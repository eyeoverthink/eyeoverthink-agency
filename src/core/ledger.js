// Logic chain: an append-only, SHA-256 hash-chained, Ed25519-signed event ledger.
// Every consequential act (mission start, tool call, approval, memory write, evolution) is recorded,
// and the whole chain can be re-verified at any time. A Merkle root summarizes it for anchoring/handoff.
import { canonical, sha256, nowIso } from './util.js';
import { verifyWith } from './identity.js';

export const GENESIS = '0'.repeat(64);

export class Ledger {
  constructor(store, keyring, signerId = 'agency', bus = null) {
    this.store = store;
    this.keyring = keyring;
    this.signerId = signerId;
    this.bus = bus;
  }

  head() {
    return this.store.get('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1') || { seq: 0, hash: GENESIS };
  }

  static entryHash({ seq, ts, kind, actor, data, prev }) {
    return sha256(canonical({ seq, ts, kind, actor, data, prev }));
  }

  append(kind, data = {}, actor = 'agency') {
    return this.store.tx(() => {
      const head = this.head();
      const entry = { seq: head.seq + 1, ts: nowIso(), kind, actor, data, prev: head.hash };
      const hash = Ledger.entryHash(entry);
      const signer = this.keyring.get(this.signerId);
      const sig = signer.sign(hash);
      this.store.run('INSERT INTO ledger (seq, ts, kind, actor, data, prev, hash, sig, signer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        entry.seq, entry.ts, kind, actor, canonical(data), entry.prev, hash, sig, signer.publicHex);
      const full = { ...entry, hash, sig, signer: signer.publicHex };
      this.bus?.emit('ledger', full);
      return full;
    });
  }

  list({ limit = 100, before = null, kind = null } = {}) {
    const lim = Math.min(1000, Math.max(1, limit | 0));
    const rows = this.store.all(
      `SELECT * FROM ledger WHERE (? IS NULL OR seq < ?) AND (? IS NULL OR kind = ?) ORDER BY seq DESC LIMIT ${lim}`,
      before, before, kind, kind);
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  /** Re-walk the entire chain: recompute every hash, check linkage and every signature. */
  verify() {
    let prev = GENESIS;
    let expectedSeq = 1;
    let count = 0;
    const rows = this.store.db.prepare('SELECT * FROM ledger ORDER BY seq ASC').iterate();
    for (const r of rows) {
      const data = JSON.parse(r.data);
      if (r.seq !== expectedSeq) return { ok: false, count, brokenAt: r.seq, reason: `sequence gap (expected ${expectedSeq})` };
      if (r.prev !== prev) return { ok: false, count, brokenAt: r.seq, reason: 'prev hash does not link' };
      const hash = Ledger.entryHash({ seq: r.seq, ts: r.ts, kind: r.kind, actor: r.actor, data, prev: r.prev });
      if (hash !== r.hash) return { ok: false, count, brokenAt: r.seq, reason: 'content hash mismatch (entry was altered)' };
      if (!verifyWith(r.signer, r.hash, r.sig)) return { ok: false, count, brokenAt: r.seq, reason: 'signature invalid' };
      prev = r.hash;
      expectedSeq++;
      count++;
    }
    return { ok: true, count, head: prev, merkleRoot: this.merkleRoot() };
  }

  /** Merkle root over all entry hashes (pairwise SHA-256, last node duplicated on odd levels). */
  merkleRoot() {
    let level = this.store.all('SELECT hash FROM ledger ORDER BY seq ASC').map((r) => r.hash);
    if (level.length === 0) return GENESIS;
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + (level[i + 1] ?? level[i])));
      level = next;
    }
    return level[0];
  }

  /** Inclusion proof for one entry, verifiable with Ledger.verifyProof without the database. */
  proof(seq) {
    const hashes = this.store.all('SELECT hash FROM ledger ORDER BY seq ASC').map((r) => r.hash);
    let idx = seq - 1;
    if (idx < 0 || idx >= hashes.length) throw new Error(`No ledger entry ${seq}`);
    const leaf = hashes[idx];
    const path = [];
    let level = hashes;
    while (level.length > 1) {
      const sibling = idx % 2 === 0 ? (level[idx + 1] ?? level[idx]) : level[idx - 1];
      path.push({ hash: sibling, left: idx % 2 === 1 });
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + (level[i + 1] ?? level[i])));
      level = next;
      idx = Math.floor(idx / 2);
    }
    return { seq, leaf, path, root: level[0] };
  }

  static verifyProof({ leaf, path, root }) {
    let h = leaf;
    for (const step of path) h = step.left ? sha256(step.hash + h) : sha256(h + step.hash);
    return h === root;
  }
}
