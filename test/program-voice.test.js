// Phase 20: the program-verified judge voice. Two independent programs (different model roles) must agree on one
// number; a third decides 2 of 3; otherwise no answer. A single program is never trusted (Phase 8: 5 of 6 ran
// cleanly and answered the wrong question).
import { makeAgency, systemOf } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programVoice, programsAgree } from '../src/evolve/program-voice.js';
import { runSandboxedJs } from '../src/tools/builtin.js';

// A scripted router: each role returns its own program. The sandbox is the real one.
const routerWith = (programs) => ({ chat: async ({ role }) => ({ model: `m-${role}`, text: JSON.stringify(programs[role] ?? { program: '' }) }) });
const prog = (expr) => ({ ambiguous: false, program: `console.log(${expr})` });
const FRACTION = 'A price is cut by 20%, then the new price is cut by 25%. What fraction of the original price is left? Give a decimal.';

test('agreement of two independent programs is the answer; real sandbox; numbers compared to the coarser rounding', async () => {
  const r = await programVoice(FRACTION, { router: routerWith({ code: prog('0.8 * 0.75'), reason: prog('(1 - 0.2) * (1 - 0.25)') }), sandbox: runSandboxedJs });
  assert.equal(r.answer, 0.6);
  assert.equal(r.verdict, 'two programs agree');
  assert.equal(r.votes.length, 2, 'no third program needed');
  assert.ok(programsAgree('46.67', '46.666666666666664'));
  assert.ok(!programsAgree('46.6', '46.666666'), 'different at the coarser rounding');
  assert.ok(!programsAgree('0.6', '0.55'), 'one decimal is not a rounding: 0.55 is not 0.6');
});

test('disagreement: a third program decides 2 of 3; three different numbers give no answer (never a guess)', async () => {
  const r = await programVoice(FRACTION, { router: routerWith({ code: prog('0.8 * 0.75'), reason: prog('1 - 0.2 - 0.25'), plan: prog('0.6') }), sandbox: runSandboxedJs });
  assert.equal(r.answer, 0.6);
  assert.equal(r.verdict, 'two of 3 programs agree');
  const none = await programVoice(FRACTION, { router: routerWith({ code: prog('0.6'), reason: prog('0.55'), plan: prog('0.45') }), sandbox: runSandboxedJs });
  assert.equal(none.answer, null);
  assert.equal(none.verdict, 'programs disagree');
  // A program that prints words, two lines, or crashes is not a vote.
  const bad = await programVoice(FRACTION, { router: routerWith({ code: { program: 'console.log("about 0.6")' }, reason: { program: 'console.log(1); console.log(2)' }, plan: { program: 'throw new Error("x")' } }), sandbox: runSandboxedJs });
  assert.equal(bad.answer, null);
  assert.deepEqual(bad.votes.map((v) => v.error), ['not exactly one number', 'not exactly one number', 'program failed']);
});

test('the judge uses the program voice: it corroborates a refutation no agent could (the Phase 12 open case), and is ledgered', async () => {
  // Every agent is wrong (as measured in Phase 12); two programs agree on 0.6.
  const A = await makeAgency((req) => {
    const sys = systemOf(req);
    if (/You compute the answer to a quantitative question/.test(sys)) return req.role === 'code' ? prog('0.8 * 0.75') : prog('(1 - 0.2) * (1 - 0.25)');
    return { thought: 'by hand', final: 'About 0.45', confidence: 0.6 };
  });
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => false };
    // A (wrong) skill result of 0.45, the first agent also says 0.45 -> agreement, nothing to fix. Make the skill right
    // and the first agent wrong: the program voice sides with the skill.
    A.agency.store.kvSet('judge:study', { items: 20, voices: ['tycho', 'program', 'lumen', 'forge_keeper'], accuracy: { tycho: 0.5, program: 1, lumen: 0.6, forge_keeper: 0.9 } });
    const r = await cz.judge(FRACTION, 0.6, 'FINAL 0.45', 'tycho');
    assert.equal(r.secondBy, 'program', 'measured most accurate, so asked first');
    assert.equal(r.agree, true);
    const e = A.agency.ledger.list({ limit: 1, kind: 'judge.program' })[0].data;
    assert.equal(e.answer, 0.6);
    assert.equal(e.verdict, 'two programs agree');
    assert.ok(!JSON.stringify(e).includes('fraction of the original'), 'the task text is not ledgered, only its hash');
    // Switched off: the program voice is never asked.
    A.agency.crystallizer.cfg.skills = { ...(A.agency.crystallizer.cfg.skills || {}), programVoice: false };
    const n0 = A.agency.ledger.list({ limit: 50, kind: 'judge.program' }).length;
    await cz.judge(FRACTION, 0.6, 'FINAL 0.45', 'tycho');
    assert.equal(A.agency.ledger.list({ limit: 50, kind: 'judge.program' }).length, n0);
  } finally { await A.cleanup(); }
});

test('program text is unwrapped before it runs (measured: hermes3 wrapped every program in <JavaScript> tags)', async () => {
  const { normalizeProgram } = await import('../src/evolve/program-voice.js');
  assert.equal(normalizeProgram('<JavaScript>console.log(56)</JavaScript>'), 'console.log(56)');
  assert.equal(normalizeProgram('```js\nconsole.log(20)\n```'), 'console.log(20)');
  assert.equal(normalizeProgram('console.log(1)'), 'console.log(1)');
  const r = await programVoice('How many groups of 3 can be chosen from 8 people?', { router: routerWith({ code: { program: '<JavaScript>console.log(8*7*6/6)</JavaScript>' }, reason: { program: '```js\nconsole.log(56)\n```' } }), sandbox: runSandboxedJs });
  assert.equal(r.answer, 56);
});

test('a three-way split asks a fourth voice; a fraction and its percentage agree when the task asks for a fraction', async () => {
  const A = await makeAgency(() => ({ final: 'x' }));
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => true };
    A.agency.store.kvSet('judge:study', { items: 20, voices: ['tycho', 'gemini', 'program', 'forge_keeper', 'lumen'], accuracy: { tycho: 0.5, gemini: 1, forge_keeper: 0.9, program: 0.75, lumen: 0.5 } });
    const TASK = 'An $80 jacket is 25% off, then 10% off. What fraction of the original price remains?';
    // The real Phase 20 split: skill 54 (a poisoned positive), first 67.5, gemini 27, forge_keeper 40; the program says 0.675.
    const book = { gemini: 'FINAL 27', forge_keeper: 'FINAL 40', program: 'FINAL 0.675', lumen: 'FINAL 12' };
    const asked = [];
    cz.agentAnswer = async (t, id) => { asked.push(id); return book[id]; };
    const r = await cz.judge(TASK, 54, 'FINAL 67.5', 'tycho');
    assert.deepEqual(asked, ['gemini', 'forge_keeper', 'program']);
    assert.equal(r.agree, false, 'refuted: the poisoned positive can now be demoted');
    assert.equal(r.corroborated, 67.5);
    assert.match(r.by, /program corroborated first/);
    // Outside fraction/percent tasks, 0.675 and 67.5 are different answers.
    asked.length = 0;
    const r2 = await cz.judge('An $80 jacket is 25% off, then 10% off. What is the final price?', 54, 'FINAL 67.5', 'tycho');
    assert.notEqual(r2.by, 'program corroborated first');
  } finally { await A.cleanup(); }
});
