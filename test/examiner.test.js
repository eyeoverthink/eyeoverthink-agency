// Red Queen exams: questions are proposed by a model but answered by a sandboxed program, and only frontier items join.
import { makeAgency } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCheck, answerKey } from '../src/evolve/examiner.js';

const okFinal = { thought: 'done', final: 'ok', confidence: 0.9 };

test('answer keys: exactly one clean line of output, typed; checkers are deterministic', () => {
  assert.equal(answerKey('number', '2842\n'), '2842');
  assert.equal(answerKey('number', '1.50'), '1.5');
  assert.equal(answerKey('number', 'about 12'), null);
  assert.equal(answerKey('number', '1\n2'), null, 'two lines is ambiguous');
  assert.equal(answerKey('yesno', 'Yes'), 'yes');
  assert.equal(answerKey('text', 'Agency'), 'Agency');
  assert.equal(answerKey('text', ''), null);
  assert.ok(makeCheck('number', '2842')('The sum is 2,842.'));
  assert.ok(!makeCheck('number', '2842')('The sum is 2843.'));
  assert.ok(makeCheck('yesno', 'no')('No, because Carol is youngest.'));
  assert.ok(!makeCheck('yesno', 'no')('Yes. Not really.'));
  assert.ok(makeCheck('text', 'Agency')('It decodes to "agency".'));
  assert.ok(!makeCheck('text', 'Agency')('Agencyship'));
});

test('propose: the model never supplies the answer; programs run in the sandbox, and bad programs are rejected', async () => {
  const items = [
    { task: 'What is the sum of the first 50 odd numbers? Give the number.', match: 'number', program: 'let s=0;for(let i=0;i<50;i++)s+=2*i+1;console.log(s)' },
    { task: 'Is 2^31 - 1 a prime number? Answer yes or no.', match: 'yesno', program: 'const n=2**31-1;let p=true;for(let i=2;i*i<=n;i++)if(n%i===0){p=false;break}console.log(p?"yes":"no")' },
    { task: 'This program crashes, so the question must be rejected.', match: 'number', program: 'throw new Error("boom")' },
    { task: 'This program prints two lines, which is ambiguous.', match: 'number', program: 'console.log(1);console.log(2)' },
    { task: 'This program prints text where a number is required.', match: 'number', program: 'console.log("forty-two")' },
    { task: 'What is the sum of the first 50 odd numbers? Give the number.', match: 'number', program: 'console.log(2500)' },
    { task: 'This one reads the file system, which the sandbox forbids.', match: 'text', program: 'console.log(require("fs").readFileSync("/etc/hosts","utf8"))' },
  ];
  const A = await makeAgency((req) => (/exam designer/.test(req.messages[0].content) ? { items } : okFinal));
  try {
    const r = await A.agency.examiner.propose('tycho', { count: 7 });
    assert.deepEqual(r.accepted.map((a) => a.answer), ['2500', 'yes']);
    assert.deepEqual(r.rejected.sort(), ['ambiguous output', 'ambiguous output', 'duplicate', 'program failed', 'program failed'].sort());
    assert.equal(A.agency.examiner.list('tycho', 'candidate').length, 2);
    const [entry] = A.agency.ledger.list({ limit: 1, kind: 'exam.propose' });
    assert.equal(entry.data.accepted, 2);
    assert.ok(!JSON.stringify(entry.data).includes('2500'), 'the ledger commits to answers by hash, so the exam is not leaked');
  } finally { await A.cleanup(); }
});

test('trial: only frontier items are admitted (alternating train / held-out); saturated items retire', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const ex = A.agency.examiner;
    const add = (task, answer) => A.agency.store.run("INSERT INTO exam_items (id, agent_id, task, answer, match, split, status, origin, program, stats, created, updated) VALUES (?, 'tycho', ?, ?, 'number', 'train', 'candidate', 'test', '', '{}', 'x', 'x')", `ex_${answer}`, task, String(answer));
    add('always right', 1); add('always wrong', 2); add('frontier A', 3); add('frontier B', 4);
    // Stub bench: decide pass/fail per item and seed.
    ex.bench = { runItem: async (item, { seed }) => ({ id: item.id, pass: item.id === 'ex_1' || ((item.id === 'ex_3' || item.id === 'ex_4') && seed % 2 === 1), steps: 1 }) };
    const r = await ex.trial('tycho', { repeats: 3 });
    assert.deepEqual(r.admitted.map((x) => x.id).sort(), ['ex_3', 'ex_4']);
    assert.deepEqual(r.admitted.map((x) => x.split).sort(), ['holdout', 'train'], 'admitted items alternate between train and held-out');
    assert.deepEqual(r.rejected.map((x) => x.reason).sort(), ['too easy (no signal)', 'too hard (no signal)']);
    // Evolution now sees them.
    const trainIds = A.agency.evolution.itemsFor('tycho').map((i) => i.id), holdIds = A.agency.evolution.holdoutFor('tycho').map((i) => i.id);
    assert.equal(['ex_3', 'ex_4'].filter((id) => trainIds.includes(id)).length, 1);
    assert.equal(['ex_3', 'ex_4'].filter((id) => holdIds.includes(id)).length, 1);
    // The agent masters one frontier item: it retires after two saturated trials in a row.
    ex.bench = { runItem: async (item, { seed }) => ({ id: item.id, pass: item.id === 'ex_3' || seed % 2 === 1, steps: 1 }) };
    await ex.trial('tycho', { repeats: 3 });
    const r3 = await ex.trial('tycho', { repeats: 3 });
    assert.deepEqual(r3.retired.map((x) => x.id), ['ex_3']);
    assert.equal(ex.list('tycho', 'active').length, 1);
    assert.equal(A.agency.ledger.list({ limit: 5, kind: 'exam.trial' }).length, 3);
  } finally { await A.cleanup(); }
});

test('a Red Queen cycle runs as a persisted background job', async () => {
  const items = [{ task: 'What is 17 * 23? Give the number.', match: 'number', program: 'console.log(17*23)' }];
  const A = await makeAgency((req) => (/exam designer/.test(req.messages[0].content) ? { items } : okFinal));
  try {
    A.agency.examiner.bench = { runItem: async (item, { seed }) => ({ id: item.id, pass: seed % 2 === 0, steps: 1 }) };
    const done = new Promise((res) => A.agency.bus.once('evolution.done', res));
    const job = A.agency.evolution.start(['tycho'], { kind: 'exam', count: 1, repeats: 3 });
    assert.equal(job.kind, 'exam');
    await done;
    const final = A.agency.evolution.job(job.id);
    assert.equal(final.status, 'done', final.error);
    assert.equal(final.result.agents[0].proposed.accepted[0].answer, '391');
    assert.equal(final.result.agents[0].trial.admitted.length, 1);
  } finally { await A.cleanup(); }
});
