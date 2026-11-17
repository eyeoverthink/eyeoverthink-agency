// Red Queen exams: questions are proposed by a model but answered by a sandboxed program, and only frontier items join.
import { makeAgency } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCheck, answerKey, sameAnswer } from '../src/evolve/examiner.js';

/** Scripted second-key verifier: an independent program per question (or an ambiguity flag). */
const VERIFIER = [
  [/first 50 odd numbers/, { program: 'console.log(50*50)' }],
  [/2\^31 - 1/, { program: 'console.log("yes")' }],
  [/snail/, { program: 'let h=0,d=0;while(true){d++;h+=3;if(h>=60)break;h-=2}console.log(d)' }],
  [/discount/, { ambiguous: true, program: 'console.log(80)' }],
  [/17 \* 23/, { program: 'console.log(391)' }],
];
const verifier = (req) => { const q = req.messages[1].content; return (VERIFIER.find(([re]) => re.test(q)) || [null, { program: 'console.log(0)' }])[1]; };

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
  assert.ok(sameAnswer('number', '0.1', '0.10000000001'));
  assert.ok(!sameAnswer('number', '57', '58'));
  assert.ok(sameAnswer('yesno', 'Yes', 'yes'));
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
    // Real failure seen on fraymus-prime: the program runs but answers the wrong question (off-by-one).
    { task: 'A snail climbs 3 cm and slips 2 cm each day in a 60 cm well. On which day does it escape? Give the number.', match: 'number', program: 'console.log(Math.floor(60/1)-3)' },
    { task: 'A $120 item gets a 12% discount plus another 8% discount. What percent of the price do you pay?', match: 'number', program: 'console.log(80)' },
  ];
  const A = await makeAgency((req) => (/exam designer/.test(req.messages[0].content) ? { items } : /verify exam answer keys/.test(req.messages[0].content) ? verifier(req) : okFinal));
  try {
    const r = await A.agency.examiner.propose('tycho', { count: 9 });
    assert.deepEqual(r.accepted.map((a) => a.answer), ['2500', 'yes', '58'], 'the snail key is CORRECTED to 58: two blind derivations outvote the examiner');
    assert.equal(r.accepted[2].verdict, 'majority (2/3)');
    assert.deepEqual(r.rejected.sort(), ['ambiguous output', 'ambiguous output', 'duplicate', 'program failed', 'program failed', 'ambiguous question'].sort());
    const audit = A.agency.examiner.list('tycho', 'unverified');
    assert.equal(audit.length, 1, 'rejected proposals are kept for audit, never used');
    assert.equal(audit[0].stats.keyCheck.verdict, 'ambiguous question');
    const verifierCalls = A.calls.filter((c) => /verify exam answer keys/.test(c.messages[0].content));
    assert.ok(verifierCalls.every((c) => ['code', 'reason'].includes(c.role) && c.privacy === 'private'), 'second and third keys come from other roles, locally');
    assert.ok(verifierCalls.some((c) => c.role === 'reason'), 'a disagreement triggered the third derivation');
    assert.ok(verifierCalls.every((c) => !JSON.stringify(c.messages).includes('console.log(5')), 'the verifier never sees the examiner program');
    assert.equal(A.agency.examiner.list('tycho', 'candidate').length, 3);
    const [entry] = A.agency.ledger.list({ limit: 1, kind: 'exam.propose' });
    assert.equal(entry.data.accepted, 3);
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
  const A = await makeAgency((req) => (/exam designer/.test(req.messages[0].content) ? { items } : /verify exam answer keys/.test(req.messages[0].content) ? verifier(req) : okFinal));
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

test('real-cycle fixes: precision-aware number matching, and a consistent dissent flags the KEY as disputed', async () => {
  const { consistentAnswer } = await import('../src/evolve/examiner.js');
  assert.ok(makeCheck('number', '43.982297150257104')('The circumference is about 43.98 cm.'), 'rounded to the answer\'s own precision');
  assert.ok(!makeCheck('number', '43.982297150257104')('About 44 cm.'), 'integers still match exactly');
  assert.ok(!makeCheck('number', '43.982297150257104')('43.90'));
  assert.equal(consistentAnswer(['You can walk it 3 times.', 'It takes 3 laps.', 'Answer: 3'], '9'), '3');
  assert.equal(consistentAnswer(['3', '4', '3'], '9'), null, 'no consensus, no dispute');
  const A = await makeAgency(() => okFinal);
  try {
    A.agency.store.run("INSERT INTO exam_items (id, agent_id, task, answer, match, split, status, origin, program, stats, created, updated) VALUES ('ex_park', 'tycho', 'park laps', '9', 'number', 'train', 'candidate', 'test', '', '{}', 'x', 'x')");
    A.agency.examiner.bench = { runItem: async (item) => ({ id: item.id, pass: false, answer: 'You can walk around it 3 times.', steps: 1 }) };
    const r = await A.agency.examiner.trial('tycho', { repeats: 3 });
    assert.match(r.rejected[0].reason, /key disputed: the agent consistently answered 3/);
    const [row] = A.agency.examiner.list('tycho', 'disputed');
    assert.equal(row.stats.agentAnswer, '3');
  } finally { await A.cleanup(); }
});
