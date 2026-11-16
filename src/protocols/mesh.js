// Agency mesh (V13 lineage): signed envelopes between sovereign agencies over HTTP (Tailscale-friendly).
// Envelope: {v, from, to, ts, nonce, type, body, sig}; sig = Ed25519 over canonical(envelope without sig).
// Checks: signature, ±300 s clock window, single-use nonce, sender trust level.
//   known   -> ping, message, memory.share (stored as quarantined peer knowledge)
//   trusted -> also task.request (runs an agent and replies task.result) and organism.offer (imports an agent)
import { newId, nowIso, canonical, truncate, errorMessage } from '../core/util.js';
import { verifyWith } from '../core/identity.js';
import { wrapUntrusted } from '../guard/sentinel.js';

const WINDOW_MS = 300000;

export class Mesh {
  constructor({ cfg, store, keyring, ledger, bus, memory, runtime, agents }) {
    Object.assign(this, { cfg, store, keyring, ledger, bus, memory, runtime, agents });
  }

  identity() {
    const id = this.keyring.get('agency');
    return { name: this.cfg.name, publicKey: id.publicHex, fingerprint: id.fingerprint, protocol: 'eyeoverthink-mesh/1' };
  }

  envelope(to, type, body) {
    const env = { v: 1, from: this.keyring.get('agency').publicHex, to, ts: Date.now(), nonce: newId('n'), type, body };
    return { ...env, sig: this.keyring.get('agency').sign(env) };
  }

  peers() { return this.store.all('SELECT * FROM peers ORDER BY created DESC LIMIT 200'); }

  async addPeer(url, name = null) {
    const base = String(url).replace(/\/$/, '');
    const res = await fetch(`${base}/mesh/identity`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`peer identity HTTP ${res.status}`);
    const ident = await res.json();
    if (!/^[0-9a-f]{64}$/.test(ident.publicKey || '')) throw new Error('peer returned no valid public key');
    const existing = this.store.get('SELECT id FROM peers WHERE public_key = ?', ident.publicKey);
    const id = existing?.id || newId('peer');
    if (existing) this.store.run('UPDATE peers SET url = ?, name = ?, last_seen = ? WHERE id = ?', base, name || ident.name, nowIso(), id);
    else this.store.run('INSERT INTO peers (id, name, url, public_key, trust, last_seen, created) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name || ident.name || base, base, ident.publicKey, 'known', nowIso(), nowIso());
    this.ledger.append('mesh.peer', { id, url: base, fingerprint: ident.fingerprint }, 'operator');
    return this.store.get('SELECT * FROM peers WHERE id = ?', id);
  }

  setTrust(peerId, trust) {
    if (!['known', 'trusted', 'blocked'].includes(trust)) throw new Error('trust must be known|trusted|blocked');
    this.store.run('UPDATE peers SET trust = ? WHERE id = ?', trust, peerId);
    this.ledger.append('mesh.trust', { peerId, trust }, 'operator');
  }

  async send(peerId, type, body) {
    const peer = this.store.get('SELECT * FROM peers WHERE id = ?', peerId);
    if (!peer) throw new Error('unknown peer');
    const env = this.envelope(peer.public_key, type, body);
    const res = await fetch(`${peer.url}/mesh/inbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env), signal: AbortSignal.timeout(15000) });
    const reply = await res.json().catch(() => ({}));
    this.store.run('INSERT INTO messages (id, channel, sender, recipient, type, body, sig, verified, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('msg'), `peer:${peerId}`, 'self', peer.public_key, type, body, env.sig, 1, nowIso());
    if (!res.ok) throw new Error(`peer rejected: ${reply.error || res.status}`);
    return reply;
  }

  /** Validate and dispatch an inbound envelope. Returns a JSON reply. */
  async receive(env) {
    const { sig, ...unsigned } = env || {};
    if (!env || env.v !== 1 || !env.from || !env.type) throw new Error('malformed envelope');
    if (!verifyWith(env.from, unsigned, sig)) throw new Error('bad signature');
    if (Math.abs(Date.now() - Number(env.ts)) > WINDOW_MS) throw new Error('timestamp outside ±300s window');
    this.store.run('DELETE FROM mesh_nonces WHERE ts < ?', Date.now() - 2 * WINDOW_MS);
    if (this.store.get('SELECT nonce FROM mesh_nonces WHERE nonce = ?', String(env.nonce))) throw new Error('replayed nonce');
    this.store.run('INSERT INTO mesh_nonces (nonce, ts) VALUES (?, ?)', String(env.nonce), Date.now());
    const me = this.keyring.get('agency').publicHex;
    if (env.to && env.to !== me) throw new Error('envelope addressed to another agency');
    const peer = this.store.get('SELECT * FROM peers WHERE public_key = ?', env.from);
    if (!peer && env.type !== 'ping') throw new Error('unknown sender: add it as a peer first');
    if (peer?.trust === 'blocked') throw new Error('sender is blocked');
    if (peer) this.store.run('UPDATE peers SET last_seen = ? WHERE id = ?', nowIso(), peer.id);
    this.store.run('INSERT INTO messages (id, channel, sender, recipient, type, body, sig, verified, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('msg'), peer ? `peer:${peer.id}` : 'mesh:anon', env.from, me, env.type, env.body ?? {}, sig, 1, nowIso());
    this.bus?.publish('mesh.message', { from: peer?.name || env.from.slice(0, 12), type: env.type });
    const trusted = peer?.trust === 'trusted';
    switch (env.type) {
      case 'ping': return { ok: true, pong: this.identity() };
      case 'message': return { ok: true };
      case 'memory.share': {
        const content = wrapUntrusted(`peer:${peer.name}`, String(env.body?.content ?? '')).text;
        const r = await this.memory.write({ kind: 'fact', content: truncate(content, 4000), tags: ['peer', `peer:${peer.name}`], importance: 0.3, source: `peer:${peer.id}` });
        return { ok: true, memory: r.id };
      }
      case 'task.request': {
        if (!trusted) throw new Error('task.request requires a trusted peer');
        const agentId = String(env.body?.agent || 'lumen');
        const task = String(env.body?.task || '');
        const corr = String(env.body?.id || newId('rq'));
        this.ledger.append('mesh.task', { peer: peer.id, agentId, corr }, 'agency');
        this.runtime.run(agentId, wrapUntrusted(`peer:${peer.name}`, task).text, { privacy: 'normal' })
          .then((r) => this.send(peer.id, 'task.result', { id: corr, agent: agentId, final: r.final, confidence: r.confidence }))
          .catch((e) => this.send(peer.id, 'task.result', { id: corr, error: errorMessage(e) }).catch(() => {}));
        return { ok: true, accepted: corr };
      }
      case 'task.result': return { ok: true };
      case 'organism.offer': {
        if (!trusted) throw new Error('organism.offer requires a trusted peer');
        const { agent } = this.agents.importOrganism(env.body?.plasmid, { trustSigner: env.from });
        return { ok: true, imported: agent.id };
      }
      default: throw new Error(`unsupported envelope type ${env.type}`);
    }
  }

  inbox(limit = 50) {
    return this.store.all(`SELECT * FROM messages WHERE channel LIKE 'peer:%' OR channel = 'mesh:anon' ORDER BY ts DESC LIMIT ${Math.min(500, limit | 0)}`)
      .map((m) => ({ ...m, body: JSON.parse(m.body) }));
  }

  static canonicalFor(env) { const { sig, ...rest } = env; return canonical(rest); }
}
