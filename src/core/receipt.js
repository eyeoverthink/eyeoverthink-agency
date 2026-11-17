// Receipt issuer: packages one mission's ledger entries, Merkle inclusion proofs and a signed root statement
// into a single JSON file that src/core/receipt-verify.js (or bin/verify-receipt.js) can check offline.
import { canonical, sha256, nowIso } from './util.js';

const MISSION_KINDS = new Set(['mission.create', 'mission.plan', 'mission.resume', 'mission.complete', 'mission.fail', 'mission.cancel',
  'tool.call', 'edge.inference', 'membrane.crossing', 'membrane.egress_blocked', 'approval.request', 'approval.decide', 'memory.save']);

/**
 * Build a receipt for a completed mission. The ledger is snapshotted once, so every proof is computed against the
 * same root that the statement signs, even if the ledger keeps growing while the receipt is built.
 */
export function issueReceipt({ store, ledger, keyring, missions, cfg }, missionId, { includeGoal = false } = {}) {
  const mission = missions.get(missionId);
  if (!mission) throw new Error(`mission ${missionId} not found`);
  if (mission.status !== 'completed' || !mission.result?.deliverable) throw new Error(`mission ${missionId} is ${mission.status}; receipts are issued for completed missions`);

  const rows = store.all('SELECT * FROM ledger ORDER BY seq ASC').map((r) => ({ ...r, data: JSON.parse(r.data) }));
  const hashes = rows.map((r) => r.hash);
  const levels = [hashes];
  while (levels.at(-1).length > 1) {
    const prev = levels.at(-1), next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(sha256(prev[i] + (prev[i + 1] ?? prev[i])));
    levels.push(next);
  }
  const root = levels.at(-1)[0];
  const proofOf = (seq) => {
    const path = [];
    let idx = seq - 1;
    for (let l = 0; l < levels.length - 1; l++) {
      const level = levels[l];
      path.push({ hash: idx % 2 === 0 ? (level[idx + 1] ?? level[idx]) : level[idx - 1], left: idx % 2 === 1 });
      idx = Math.floor(idx / 2);
    }
    return path;
  };

  const mine = rows.filter((r) => MISSION_KINDS.has(r.kind) && (r.data?.id === missionId || r.data?.missionId === missionId));
  const deliverableSha256 = sha256(mission.result.deliverable);
  const signer = keyring.get(ledger.signerId);
  const statement = {
    type: 'eyeoverthink.receipt.statement', missionId, deliverableSha256, merkleRoot: root, size: rows.length,
    entries: mine.length, issued: nowIso(),
  };
  const receipt = {
    type: 'eyeoverthink.receipt', version: 1,
    agency: { name: cfg.name, publicKey: signer.publicHex },
    mission: {
      id: missionId, mode: mission.options?.mode, privacy: mission.options?.privacy, score: mission.score ?? null,
      goalSha256: sha256(mission.goal), ...(includeGoal ? { goal: mission.goal } : {}),
    },
    statement, statementSig: signer.sign(canonical(statement)),
    entries: mine.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, actor: r.actor, data: r.data, prev: r.prev, hash: r.hash, sig: r.sig, signer: r.signer, proof: proofOf(r.seq) })),
    howToVerify: 'node bin/verify-receipt.js <receipt.json> [deliverable.txt]  (zero dependencies; or the dashboard Ledger > Verify a receipt)',
  };
  ledger.append('receipt.issue', { missionId, entries: mine.length, merkleRoot: root, size: rows.length, deliverableSha256 }, 'agency');
  return receipt;
}
