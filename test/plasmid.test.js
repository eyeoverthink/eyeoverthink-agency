// Skill plasmids (Phase 15): a verified skill travels to another agency, is re-verified there, answers nothing while on
// probation, and is adopted only after the receiver's own agents agree with it on its own tasks.
import { makeAgency, systemOf, lastUser } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlasmid } from '../src/core/dna.js';
import { Identity } from '../src/core/identity.js';

const DISCOUNT = {
  name: 'compound_discount', description: 'Final price after applying percentage discounts one after another.',
  params: { type: 'object', properties: { price: { type: 'number' }, discounts: { type: 'array', items: { type: 'number' } } }, required: ['price', 'discounts'] },
  code: 'function main(input) { return input.discounts.reduce((p, d) => p * (1 - d / 100), input.price); }',
};
// Honest but wrong: treats the second percentage as a surcharge. Self-consistent, so it reproduces its own rows.
const WRONG = { ...DISCOUNT, code: 'function main(input) { return input.price * (1 - input.discounts[0] / 100) * (1 + (input.discounts[1] || 0) / 100); }' };
const INPUTS = [{ price: 120, discounts: [12, 8] }, { price: 100, discounts: [] }, { price: 50, discounts: [50, 50] }];
const parse = (t) => ({ price: Number(t.match(/\$(\d+(?:\.\d+)?)/)[1]), discounts: [...t.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1])) });
const truth = (t) => { const n = parse(t); return Math.round(n.discounts.reduce((p, d) => p * (1 - d / 100), n.price) * 100) / 100; };
const task = (p, a, b) => `A jacket costs $${p}. The store takes ${a}% off, then a further ${b}% off the reduced price. What does the jacket cost now?`;
const LEARN = [task(120, 12, 8), task(80, 25, 10), task(200, 10, 20)];
const LOCAL = [task(150, 20, 5), task(60, 15, 10), task(90, 30, 10)];

/** Scripted models: crystallization, a correct binder, and agents that answer correctly. */
function script(skill = DISCOUNT) {
  return (req) => {
    const sys = systemOf(req), u = lastUser(req);
    if (/turn a solved task into ONE reusable/.test(sys)) return skill;
    if (/independently implement/.test(sys)) return { code: skill.code, inputs: INPUTS };
    if (/You route tasks to verified functions/.test(sys)) { const t = u.split('\n\nFunctions:')[0].replace(/^Task:\n/, ''); return { skill: 'compound_discount', input: parse(t) }; }
    if (/You write|paraphrase|near-miss/i.test(sys)) return { tasks: [] };
    const all = req.messages.map((m) => m.content).join('\n');
    const q = all.match(/A jacket costs \$\d+[^\n?]*\?/)?.[0];
    const final = q ? `It costs ${truth(q).toFixed(2)}` : 'ok';
    if (/reviewing your own draft/.test(sys)) return { issues: [], final, confidence: 0.8 };
    return { thought: 'by hand', final, confidence: 0.8 };
  };
}

/** Sender: owns the skill and has routed the learning tasks (grounded bindings become its positive examples). */
async function sender(skill = DISCOUNT) {
  const A = await makeAgency(script(skill), { skills: { first: true, learnBinders: false, importTrust: 2 } });
  const r = await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: 'A $120 item gets 12% off then 8% off: 97.152.' });
  assert.equal(r.admitted, true, r.reason);
  for (const t of LEARN) assert.equal((await A.agency.runtime.run('tycho', t)).skill, 'compound_discount');
  return A;
}
async function receiver() {
  const B = await makeAgency(script(), { skills: { first: true, learnBinders: false, importTrust: 2 } });
  B.agency.crystallizer.agentAnswer = async (t) => `It costs ${truth(t).toFixed(2)}`; // second and third opinions
  return B;
}

test('a skill plasmid is re-verified on import, answers nothing on probation, and is adopted after 2 local agreements', async () => {
  const A = await sender(), B = await receiver();
  try {
    const { plasmid, skills } = A.agency.crystallizer.exportSkill('compound_discount', A.agency.keyring.get('agency'));
    assert.deepEqual(skills, ['compound_discount']);
    const imp = await B.agency.crystallizer.importSkill(plasmid);
    assert.equal(imp.imported, true, imp.reason);
    assert.equal(B.agency.crystallizer.list('probation').length, 1);
    assert.equal(B.agency.crystallizer.examples('compound_discount').length, 3, 'positive examples travel; the binder is induced here');
    assert.ok(!B.agency.tools.tools?.has('skill_compound_discount'), 'not a tool while on probation');

    // A near-miss with wording the examples never verified is not a trial: it could only refute the skill for the wrong reason.
    await B.agency.runtime.run('tycho', 'A jacket costs $100. The store takes 10% off, then adds 8% sales tax on the reduced price. What does the jacket cost now?');
    assert.equal(B.agency.ledger.list({ limit: 5, kind: 'skill.trial' }).length, 0);
    // Trial 1 and 2: the agents answer (the skill never does), and the skill's output is judged against them.
    for (const [i, t] of LOCAL.slice(0, 2).entries()) {
      const r = await B.agency.runtime.run('tycho', t);
      assert.equal(r.skill, undefined, 'probation skills never answer');
      const trial = B.agency.ledger.list({ limit: 1, kind: 'skill.trial' })[0];
      assert.equal(trial.data.agree, true);
      assert.equal(B.agency.crystallizer.list().find((s) => s.name === 'compound_discount').status, i === 0 ? 'probation' : 'active');
    }
    assert.equal(B.agency.ledger.list({ limit: 5, kind: 'skill.adopt' }).length, 1);
    // Adopted: the next task is answered by the skill.
    const r3 = await B.agency.runtime.run('tycho', LOCAL[2]);
    assert.equal(r3.skill, 'compound_discount');
    assert.match(r3.final, /56\.7/);
    // Re-exportable by the receiver, with its own signed adoption entry as provenance.
    const again = B.agency.crystallizer.exportSkill('compound_discount', B.agency.keyring.get('agency'));
    assert.equal(again.plasmid.signer, B.agency.keyring.get('agency').publicHex);
    assert.ok(B.agency.ledger.verify().ok);
  } finally { await A.cleanup(); await B.cleanup(); }
});

test('import refuses a forged plasmid, a wrong signer, and an ungrounded example', async () => {
  const A = await sender(), B = await receiver();
  try {
    const { plasmid } = A.agency.crystallizer.exportSkill('compound_discount', A.agency.keyring.get('agency'));
    // A third party alters the code and re-signs: the sender's admission entry no longer matches its signer or hash.
    const opened = (await import('../src/core/dna.js')).openPlasmid(plasmid);
    const skills = JSON.parse(opened.parts['skills.json']);
    const forged = skills.map((s) => ({ ...s, code: WRONG.code, code_sha256: (awaitSha(WRONG.code)) }));
    const kp = generateKeyPairSync('ed25519');
    const mallory = new Identity('mallory', kp.publicKey, kp.privateKey);
    const evil = buildPlasmid('skill:compound_discount', { 'skills.json': forged, 'examples.json': JSON.parse(opened.parts['examples.json']), 'provenance.json': {} }, mallory);
    const r1 = await B.agency.crystallizer.importSkill(evil);
    assert.equal(r1.imported, false);
    assert.match(r1.reason, /no valid signed admission entry/);
    // Tampering with the strand breaks its hash.
    const r2 = await B.agency.crystallizer.importSkill({ ...plasmid, strand: plasmid.strand.replace(/A/, 'C') });
    assert.match(r2.reason, /hash mismatch/);
    // Only the trusted peer.
    const r3 = await B.agency.crystallizer.importSkill(plasmid, { trustSigner: mallory.publicHex });
    assert.match(r3.reason, /not the trusted peer/);
    assert.equal(B.agency.crystallizer.list().length, 0);
    assert.equal(B.agency.ledger.list({ limit: 5, kind: 'skill.import_reject' }).length, 3);
  } finally { await A.cleanup(); await B.cleanup(); }
});

test('an honestly wrong skill passes import (it reproduces itself) but is rejected by the receiver\'s own agents', async () => {
  const A = await sender(WRONG), B = await receiver();
  try {
    const { plasmid } = A.agency.crystallizer.exportSkill('compound_discount', A.agency.keyring.get('agency'));
    assert.equal((await B.agency.crystallizer.importSkill(plasmid)).imported, true);
    const r = await B.agency.runtime.run('tycho', LOCAL[0]);
    assert.match(r.final, /114\.00/, 'the agents answered, not the skill');
    const trial = B.agency.ledger.list({ limit: 1, kind: 'skill.trial' })[0].data;
    assert.equal(trial.agree, false, 'a second agent corroborated the first');
    assert.equal(B.agency.crystallizer.list().find((s) => s.name === 'compound_discount').status, 'rejected');
    // Rejected skills are never tried again.
    await B.agency.runtime.run('tycho', LOCAL[1]);
    assert.equal(B.agency.ledger.list({ limit: 5, kind: 'skill.trial' }).length, 1);
  } finally { await A.cleanup(); await B.cleanup(); }
});

function awaitSha(s) { return createHash('sha256').update(s).digest('hex'); }
import { createHash, generateKeyPairSync } from 'node:crypto';

// ---- Phase 16: skills over the mesh ---------------------------------------------------------------------------------
async function listen(agency) {
  const { createServer } = await import('../src/server/server.js');
  const server = createServer(agency);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('over the mesh: a task no skill could take makes the agency pull a matching skill from a trusted peer, judged on that very task; the task never leaves', async () => {
  const A = await sender(), B = await receiver();
  const sa = await listen(A.agency), sb = await listen(B.agency);
  try {
    const peerA = await B.agency.mesh.addPeer(sa.url, 'A');
    const peerB = await A.agency.mesh.addPeer(sb.url, 'B');
    // Known (not trusted): the catalog is visible (contracts only), but a skill is not handed over.
    const cat = await B.agency.mesh.catalog(peerA.id);
    assert.deepEqual(cat.map((s) => s.name), ['compound_discount']);
    assert.equal(cat[0].code, undefined, 'catalogs carry no code');
    B.agency.mesh.setTrust(peerA.id, 'trusted');
    await assert.rejects(B.agency.mesh.requestSkill(peerA.id, 'compound_discount'), /requires a trusted peer/);
    A.agency.mesh.setTrust(peerB.id, 'trusted');

    // B owns nothing: the agents answer, then B looks among trusted peers in the background.
    const secret = LOCAL[0];
    const r1 = await B.agency.runtime.run('tycho', secret);
    assert.equal(r1.skill, undefined);
    await B.agency.crystallizer.seekQueue;
    const seek = B.agency.ledger.list({ limit: 1, kind: 'skill.seek' })[0].data;
    assert.equal(seek.imported, true);
    assert.equal(seek.trial.agree, true, 'judged on the task that triggered the search');
    assert.equal(B.agency.crystallizer.list().find((s) => s.name === 'compound_discount').status, 'probation');
    // The second matching task is the second trial: adopted, then the third is answered by the skill.
    await B.agency.runtime.run('tycho', LOCAL[1]);
    assert.equal(B.agency.crystallizer.list().find((s) => s.name === 'compound_discount').status, 'active');
    assert.equal((await B.agency.runtime.run('tycho', LOCAL[2])).skill, 'compound_discount');
    // Privacy: no message A received carries B's task text; only the skill name went out.
    const seen = JSON.stringify(A.agency.mesh.inbox(200));
    assert.ok(!seen.includes('jacket costs $150'), 'the task never left B');
    assert.ok(seen.includes('"name":"compound_discount"'));
    // Never pulled twice.
    await B.agency.runtime.run('tycho', 'A lamp costs $40. It is 10% off, then a further 5% off. What does it cost?');
    await B.agency.crystallizer.seekQueue;
    assert.equal(B.agency.ledger.list({ limit: 10, kind: 'skill.seek' }).length, 1);
    assert.ok(A.agency.ledger.verify().ok && B.agency.ledger.verify().ok);
  } finally { sa.server.close(); sb.server.close(); await A.cleanup(); await B.cleanup(); }
});

test('over the mesh: an offered skill lands on probation, and only from a trusted peer', async () => {
  const A = await sender(), B = await receiver();
  const sa = await listen(A.agency), sb = await listen(B.agency);
  try {
    const peerB = await A.agency.mesh.addPeer(sb.url, 'B');
    const peerA = await B.agency.mesh.addPeer(sa.url, 'A');
    await assert.rejects(A.agency.mesh.offerSkill(peerB.id, 'compound_discount'), /requires a trusted peer/);
    B.agency.mesh.setTrust(peerA.id, 'trusted');
    const r = await A.agency.mesh.offerSkill(peerB.id, 'compound_discount');
    assert.equal(r.imported, true, r.reason);
    assert.equal(B.agency.crystallizer.list('probation').length, 1);
    assert.equal(B.agency.ledger.list({ limit: 1, kind: 'mesh.skill_in' })[0].data.how, 'offer');
  } finally { sa.server.close(); sb.server.close(); await A.cleanup(); await B.cleanup(); }
});

test('the verdict decides the reply: when a second agent sides with the skill against the first, the user gets the 2-of-3 answer', async () => {
  const A = await sender();
  const B = await makeAgency((req) => {
    const sys = systemOf(req);
    if (/reviewing your own draft/.test(sys)) return { issues: [], final: 'It costs 999.00', confidence: 0.8 };
    return { thought: 'rushed', final: 'It costs 999.00', confidence: 0.8 }; // the first agent is wrong
  }, { skills: { first: true, learnBinders: false, importTrust: 2 } });
  B.agency.crystallizer.agentAnswer = async (t) => `It costs ${truth(t).toFixed(2)}`; // the second agent is right
  try {
    const { plasmid } = A.agency.crystallizer.exportSkill('compound_discount', A.agency.keyring.get('agency'));
    assert.equal((await B.agency.crystallizer.importSkill(plasmid)).imported, true);
    const r = await B.agency.runtime.run('tycho', LOCAL[0]);
    assert.match(r.final, /^\*\*Answer: 114\*\*/);
    assert.match(r.final, /Verified 2 of 3: skill_compound_discount computed 114, and a second agent \(114\) agreed\. The first agent's answer \(999\) was outvoted\./);
    assert.equal(B.agency.ledger.list({ limit: 1, kind: 'skill.correct' })[0].data.corrected, 114);
    // Agreement only at the agent's rounding: the exact verified value is the reply.
    const cz = B.agency.crystallizer;
    const prec = cz.correctAnswer({ agree: true, agentAnswer: 24, skillOut: 23.85, skill: 'compound_discount' }, 'about 24');
    assert.match(prec, /^\*\*Answer: 23\.85\*\*/);
    assert.match(prec, /the agents' answer \(24\) is this value rounded/);
    assert.equal(cz.correctAnswer({ agree: true, agentAnswer: 23.85, skillOut: 23.849999999999998, skill: 'compound_discount' }, 'x'), null, 'already exact');
    // Agreement with the first agent changes nothing.
    B.agency.crystallizer.agentAnswer = async () => 'It costs 999.00';
    const r2 = await B.agency.runtime.run('tycho', LOCAL[1]);
    assert.equal(r2.final, 'It costs 999.00', 'a corroborated dissent is not overridden');
  } finally { await A.cleanup(); await B.cleanup(); }
});

test('family tree: every link is a signed ledger entry (import from a peer, adoption after trials)', async () => {
  const A = await sender(), B = await receiver();
  try {
    const { plasmid } = A.agency.crystallizer.exportSkill('compound_discount', A.agency.keyring.get('agency'));
    await B.agency.crystallizer.importSkill(plasmid);
    for (const t of LOCAL.slice(0, 2)) await B.agency.runtime.run('tycho', t);
    const l = B.agency.crystallizer.lineage();
    const skill = l.nodes.find((n) => n.id === 'compound_discount');
    assert.equal(skill.kind, 'import'); assert.equal(skill.status, 'active');
    assert.deepEqual(skill.events.map((e) => e.what), ['imported', 'adopted after local trials']);
    const edge = l.edges.find((e) => e.to === 'compound_discount');
    assert.equal(edge.kind, 'imported');
    assert.ok(edge.from.startsWith('peer:'));
    const entry = B.agency.ledger.list({ limit: 50 }).find((e) => e.seq === edge.seq);
    assert.equal(entry.hash, edge.hash, 'the link is the ledger entry itself');
    // The sender's tree shows the skill admitted, then shared.
    const la = A.agency.crystallizer.lineage();
    assert.deepEqual(la.nodes.find((n) => n.id === 'compound_discount').events.map((e) => e.what), ['admitted', 'exported']);
  } finally { await A.cleanup(); await B.cleanup(); }
});
