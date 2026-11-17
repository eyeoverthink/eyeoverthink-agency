// Proof-carrying output: a mission receipt verifies offline, and any tampering breaks it.
import { makeAgency, systemOf, lastUser } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { issueReceipt } from '../src/core/receipt.js';
import { verifyReceipt, canonical as vCanonical } from '../src/core/receipt-verify.js';
import { canonical } from '../src/core/util.js';

function missionScript() {
  return (req) => {
    const sys = systemOf(req), u = lastUser(req);
    if (/director of an AI agency/.test(sys)) return { summary: 'two-step', tasks: [
      { id: 't1', title: 'Analyze', agent: 'tycho', instructions: 'Compute 6*7', deps: [] },
      { id: 't2', title: 'Write it up', agent: 'lumen', instructions: 'Write the answer', deps: ['t1'] },
    ] };
    if (/You are Solon, a strict but fair critic/.test(sys)) return { score: 0.92, pass: true, defects: [], fix: '' };
    if (/Sentinel, a security reviewer/.test(sys)) return { risk: 'none', findings: [] };
    if (/Combine the team's verified work/.test(u)) return { thought: 'merge', final: '# Result\n42 units, verified.', confidence: 0.9 };
    return { thought: 'work', final: 'The result is 42.', confidence: 0.8 };
  };
}

async function completedMission() {
  const A = await makeAgency(missionScript());
  const m = A.agency.missions.create('What is 6*7 with units?');
  const done = await A.agency.missions.waitFor(m.id, 30000);
  assert.equal(done.status, 'completed', done.error);
  // Unrelated activity after the mission: the receipt must not include it, and its proofs must still hold.
  A.agency.ledger.append('test.noise', { n: 1 });
  return { A, done };
}

test('the verifier uses the same canonical JSON as the ledger', () => {
  const v = { b: [3, { z: 1, a: null }], a: 'x', u: undefined, n: 1.5 };
  assert.equal(vCanonical(v), canonical(v));
});

test('receipt: a completed mission verifies offline, including the exact deliverable text', async () => {
  const { A, done } = await completedMission();
  try {
    const r = issueReceipt(A.agency, done.id);
    assert.equal(r.type, 'eyeoverthink.receipt');
    assert.ok(r.entries.length >= 3 && r.entries.every((e) => e.data.id === done.id || e.data.missionId === done.id));
    assert.ok(!r.entries.some((e) => e.kind === 'test.noise'));
    assert.equal(r.mission.goal, undefined, 'the goal text is withheld unless asked for (it may be private)');
    const v = await verifyReceipt(JSON.parse(JSON.stringify(r)), { deliverable: done.result.deliverable });
    assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
    assert.ok(v.checks.some((c) => /byte-for-byte/.test(c.detail)));
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'receipt.issue' }).length, 1, 'issuing a receipt is itself ledgered');
  } finally { await A.cleanup(); }
});

test('receipt: tampering anywhere is caught (deliverable, entry data, signature, proof, statement, key swap, foreign entry)', async () => {
  const { A, done } = await completedMission();
  try {
    const base = issueReceipt(A.agency, done.id);
    const clone = () => JSON.parse(JSON.stringify(base));
    const failed = async (r, opts = {}) => (await verifyReceipt(r, opts)).checks.filter((c) => !c.ok).map((c) => c.name).join(' | ');

    assert.match(await failed(clone(), { deliverable: done.result.deliverable + ' ' }), /deliverable you hold/, 'one extra byte');
    let r = clone(); r.entries.find((e) => e.kind === 'mission.complete').data.score = 1; // inflate the score
    assert.match(await failed(r), /intact/);
    r = clone(); r.entries[0].sig = r.entries[1].sig;
    assert.match(await failed(r), /signed by the agency/);
    r = clone(); r.entries[0].proof[0].hash = 'f'.repeat(64);
    assert.match(await failed(r), /included in the signed ledger/);
    r = clone(); r.statement.deliverableSha256 = 'a'.repeat(64);
    assert.match(await failed(r), /root statement signed/);
    r = clone(); r.agency.publicKey = 'b'.repeat(64);
    assert.match(await failed(r), /root statement signed/, 'swapping in another key fails every signature');
    r = clone();
    const other = A.agency.ledger.list({ limit: 1, kind: 'test.noise' })[0];
    r.entries.push({ ...other, proof: [] });
    assert.match(await failed(r), /belongs to this mission/);
  } finally { await A.cleanup(); }
});

test('receipt: refused for missions that did not complete', async () => {
  const A = await makeAgency(missionScript());
  try {
    assert.throws(() => issueReceipt(A.agency, 'ms_missing'), /not found/);
  } finally { await A.cleanup(); }
});

test('standalone verifier CLI: zero-dependency script verifies a receipt file and rejects a tampered one', async () => {
  const { A, done } = await completedMission();
  const dir = fs.mkdtempSync(path.join(process.env.AGENCY_TEST_DIR || A.home, 'receipt-'));
  try {
    const file = path.join(dir, 'receipt.json'), text = path.join(dir, 'deliverable.txt');
    const r = issueReceipt(A.agency, done.id);
    fs.writeFileSync(file, JSON.stringify(r));
    fs.writeFileSync(text, done.result.deliverable);
    const out = execFileSync(process.execPath, ['bin/verify-receipt.js', file, text]).toString();
    assert.match(out, /VERIFIED/);
    assert.match(out, /byte-for-byte/);
    fs.writeFileSync(text, done.result.deliverable.replace('42', '43'));
    let code = 0;
    try { execFileSync(process.execPath, ['bin/verify-receipt.js', file, text], { stdio: 'pipe' }); } catch (e) { code = e.status; }
    assert.equal(code, 1, 'a changed deliverable fails with exit code 1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await A.cleanup(); }
});
