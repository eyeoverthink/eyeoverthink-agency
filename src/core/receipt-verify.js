// Receipt verifier: checks a mission receipt WITHOUT the agency, its database, or the network.
// Isomorphic (Node 22+ and modern browsers): only WebCrypto (SHA-256, Ed25519). No imports on purpose, so this one
// file can be handed to anyone, read in a few minutes, and run against a receipt they were given.
//
// A receipt proves, for one mission:
//   1. every included ledger entry is intact (its hash recomputes from its content),
//   2. every entry was signed by the agency key named in the receipt,
//   3. every entry is in the ledger the agency committed to (Merkle inclusion proof to the signed root),
//   4. the root statement (root, size, mission, deliverable hash, time) is signed by the same key,
//   5. the deliverable text you hold is byte-for-byte the one the mission completed with.

/** Must match src/core/util.js canonical() exactly: sorted keys, no whitespace, undefined dropped. */
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(String(h).match(/.{1,2}/g)?.map((x) => parseInt(x, 16)) || []);
export async function sha256Hex(text) { return hex(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text))); }

async function ed25519Verify(publicHex, message, sigHex) {
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', fromHex(publicHex), { name: 'Ed25519' }, false, ['verify']);
    return await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, fromHex(sigHex), enc.encode(message));
  } catch { return false; }
}

async function merkleFold(leaf, path) {
  let h = leaf;
  for (const step of path) h = await sha256Hex(step.left ? step.hash + h : h + step.hash);
  return h;
}

/**
 * Verify a receipt. deliverable (optional): the text you were given; if present it must match the signed hash.
 * Returns { ok, checks: [{ name, ok, detail }], summary }.
 */
export async function verifyReceipt(receipt, { deliverable = null } = {}) {
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); return ok; };
  if (!receipt || receipt.type !== 'eyeoverthink.receipt') {
    check('receipt format', false, 'not an eyeoverthink.receipt');
    return { ok: false, checks };
  }
  const pub = receipt.agency?.publicKey;
  check('receipt format', /^[0-9a-f]{64}$/.test(pub || '') && Array.isArray(receipt.entries), `version ${receipt.version}, ${receipt.entries?.length ?? 0} entries`);

  // 4. Signed root statement.
  const st = receipt.statement;
  const stOk = await ed25519Verify(pub, canonical(st), receipt.statementSig);
  check('root statement signed by the agency key', stOk, stOk ? `ledger size ${st.size}, root ${String(st.merkleRoot).slice(0, 16)}…` : 'signature invalid');

  // 1-3. Each entry: hash, signature, inclusion.
  let intact = 0, signed = 0, included = 0;
  const bad = [];
  for (const e of receipt.entries) {
    const h = await sha256Hex(canonical({ seq: e.seq, ts: e.ts, kind: e.kind, actor: e.actor, data: e.data, prev: e.prev }));
    if (h === e.hash) intact++; else bad.push(`#${e.seq} content altered`);
    if (e.signer === pub && await ed25519Verify(pub, e.hash, e.sig)) signed++; else bad.push(`#${e.seq} signature`);
    if (e.seq <= st.size && await merkleFold(e.hash, e.proof || []) === st.merkleRoot) included++; else bad.push(`#${e.seq} not in signed ledger`);
  }
  const n = receipt.entries.length;
  check('entries intact (hash recomputes)', intact === n, `${intact}/${n}`);
  check('entries signed by the agency', signed === n, `${signed}/${n}`);
  check('entries included in the signed ledger (Merkle)', included === n, `${included}/${n}`);

  // Mission binding: every entry belongs to this mission, and the completion entry carries the deliverable hash.
  const mid = st.missionId;
  const belongs = receipt.entries.every((e) => e.data?.id === mid || e.data?.missionId === mid);
  check('every entry belongs to this mission', belongs, belongs ? mid : 'an entry from another mission was included');
  const done = receipt.entries.find((e) => e.kind === 'mission.complete');
  check('mission completion entry present', Boolean(done), done ? `#${done.seq}, score ${done.data.score}` : 'missing');
  check('completion entry matches the signed deliverable hash', done?.data?.resultHash === st.deliverableSha256, String(st.deliverableSha256).slice(0, 16) + '…');
  if (deliverable != null) {
    const dh = await sha256Hex(String(deliverable));
    check('the deliverable you hold is the one the mission produced', dh === st.deliverableSha256, dh === st.deliverableSha256 ? 'byte-for-byte match' : `your text hashes to ${dh.slice(0, 16)}…`);
  }
  if (bad.length) checks.push({ name: 'problems', ok: false, detail: bad.slice(0, 10).join('; ') });

  // Recomputed summary (from verified entries only, not from the receipt's own claims).
  const of = (k) => receipt.entries.filter((e) => e.kind === k);
  const fire = of('edge.inference');
  const summary = {
    toolCalls: of('tool.call').length,
    firebaseCalls: fire.length,
    firebaseInCloud: fire.filter((e) => e.data.inferenceSource === 'IN_CLOUD').length,
    firebaseOnDevice: fire.filter((e) => e.data.inferenceSource === 'ON_DEVICE').length,
    sealedCrossings: of('membrane.crossing').length,
    valuesWithheld: of('membrane.crossing').reduce((s, e) => s + (e.data.total || 0), 0),
    egressBlocked: of('membrane.egress_blocked').length,
  };
  return { ok: checks.every((c) => c.ok), checks, summary };
}
