// Skill composition (Phase 14): chains of owned skills, verified by the judge, then crystallized into a composed skill
// whose code the agency writes itself (no model), and finally routed with zero model calls by a learned binder.
import { makeAgency, systemOf, lastUser } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChain, chainSignature, chainProblem, composeChainSkill, chainInput } from '../src/evolve/crystallizer.js';

const SKILLS = {
  DISCOUNT: { name: 'discount_price', description: 'Price after one percentage discount.', params: { type: 'object', properties: { price: { type: 'number' }, discount: { type: 'number', description: 'discount percent' } }, required: ['price', 'discount'] }, code: 'function main(i) { return i.price * (1 - i.discount / 100); }' },
  TAX: { name: 'add_tax', description: 'Amount after adding a percentage sales tax.', params: { type: 'object', properties: { amount: { type: 'number' }, rate: { type: 'number', description: 'tax percent' } }, required: ['amount', 'rate'] }, code: 'function main(i) { return i.amount * (1 + i.rate / 100); }' },
  SPLIT: { name: 'split_evenly', description: 'Share of a total split evenly among people.', params: { type: 'object', properties: { total: { type: 'number' }, people: { type: 'number' } }, required: ['total', 'people'] }, code: 'function main(i) { return i.total / i.people; }' },
};
const OWNED = Object.values(SKILLS);
const parse = (t) => ({ price: Number(t.match(/\$(\d+(?:\.\d+)?)/)[1]), pcts: [...t.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1])), people: Number((t.match(/among (\d+)/) || [])[1]) });
const truth = (t) => { const n = parse(t); return Math.round((n.price * (1 - n.pcts[0] / 100) * (1 + n.pcts[1] / 100)) / n.people * 1e6) / 1e6; };
const chainFor = (t) => { const n = parse(t); return { steps: [{ skill: 'discount_price', input: { price: n.price, discount: n.pcts[0] } }, { skill: 'add_tax', input: { amount: { ref: 1 }, rate: n.pcts[1] } }, { skill: 'split_evenly', input: { total: '$2', people: n.people } }] }; };
const TASKS = [
  'A $200 coat is 20% off, then 8% sales tax is added, and the total is split evenly among 4 friends. How much does each pay?',
  'A $90 dinner is 10% off, then 5% sales tax is added, and the total is split evenly among 3 friends. How much does each pay?',
  'A $300 hotel room is 15% off, then 6% sales tax is added, and the total is split evenly among 2 friends. How much does each pay?',
  'A $120 game is 25% off, then 7% sales tax is added, and the total is split evenly among 5 friends. How much does each pay?',
];

let current = '';
let synthPeople = false;
function script(req) {
  const sys = systemOf(req), u = lastUser(req);
  if (/turn a solved task into ONE reusable/.test(sys)) return u.includes('DISCOUNT') ? SKILLS.DISCOUNT : u.includes('TAX') ? SKILLS.TAX : SKILLS.SPLIT;
  if (/independently implement/.test(sys)) {
    const s = OWNED.find((x) => u.includes(x.description));
    return { code: s.code, inputs: s === SKILLS.SPLIT ? [{ total: 100, people: 4 }, { total: 9, people: 3 }, { total: 10, people: 4 }] : s === SKILLS.TAX ? [{ amount: 100, rate: 8 }, { amount: 50, rate: 0 }, { amount: 10, rate: 10 }] : [{ price: 100, discount: 20 }, { price: 50, discount: 0 }, { price: 10, discount: 50 }] };
  }
  if (/You route tasks/.test(sys)) {
    const task = u.split('\n\nFunctions:')[0].replace(/^Task:\n/, '');
    if (!/split/.test(task)) return { skill: null };
    const composed = u.match(/- (\S+): Composed from owned skills/);
    if (composed) { const n = parse(task); return { skill: composed[1], input: { price: n.price, discount: n.pcts[0], rate: n.pcts[1], people: n.people } }; }
    return chainFor(task);
  }
  if (/You write test cases for a task router/.test(sys)) {
    if (!synthPeople || !/Composed from owned skills/.test(u)) return { positives: [], negatives: [] };
    const t = 'A $80 kettle is 25% off, then 5% sales tax is added, and the total is split evenly among 4 people. How much does each pay?';
    return { positives: [{ task: t, input: { price: 80, discount: 25, rate: 5, people: 4 } }], negatives: ['A $80 kettle is 25% off, then 5% sales tax is added, and 4 people pay. How much more does Ann pay than Bob?'] };
  }
  const final = `Each friend pays $${truth(current)}.`;
  return /reviewing your own draft/.test(sys) ? { issues: [], final, confidence: 0.8 } : { thought: 'by hand', final, confidence: 0.8 };
}
async function setup(skills = {}) {
  const A = await makeAgency(script, { skills: { first: true, bindRole: 'fast', minOverlap: 1, learnBinders: true, binderMinExamples: 3, chainTrust: 2, ...skills } });
  for (const k of ['DISCOUNT', 'TAX', 'SPLIT']) assert.equal((await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: `${k}: a solved task.` })).admitted, true, k);
  A.agency.crystallizer.agentAnswer = async (t) => `Each pays $${truth(t)}.`;
  return A;
}
const run = async (A, t) => { current = t; return A.agency.runtime.run('tycho', t); };

test('chain gates: grounding, refs to earlier steps only, no dead steps, every number used, answer form of the last step', () => {
  const t = TASKS[0];
  const ok = normalizeChain(chainFor(t));
  assert.equal(ok[2].input.total.ref, 2, '"$2" means the output of step 2');
  assert.equal(chainProblem(ok, OWNED, t), null);
  assert.equal(chainSignature(ok), 'discount_price(discount,price) > add_tax(amount=@1,rate) > split_evenly(people,total=@2)');
  const bad = (mut) => { const c = structuredClone(ok); mut(c); return chainProblem(c, OWNED, t); };
  assert.match(bad((c) => { c[1].input.rate = 9; }), /rate = 9 does not appear in the task/);
  assert.match(bad((c) => { c[0].input.price = { ref: 2 }; }), /refers to step 2, which is not an earlier step/);
  assert.match(bad((c) => { c[2].input.total = 172.8; }), /step 2 \(add_tax\) feeds nothing|172.8 does not appear/);
  assert.match(chainProblem(normalizeChain({ steps: [ok[0], { skill: 'split_evenly', input: { total: { ref: 1 }, people: 4 } }] }), OWNED, t), /states 8 but the chain does not use it/);
  assert.match(chainProblem(ok, OWNED, t.replace('How much does each pay?', 'How much do they save?')), /asks for a difference or saving, which the last step/);
  assert.equal(normalizeChain({ steps: [ok[0]] }), null, 'one step is not a chain');
});

test('the agency writes the composed skill itself, and it reproduces the chain', async () => {
  const steps = normalizeChain(chainFor(TASKS[0]));
  const c = composeChainSkill(steps, OWNED);
  assert.deepEqual(Object.keys(c.params.properties), ['price', 'discount', 'rate', 'people']);
  assert.match(c.code, /const s2 = skill_add_tax\(\{ "amount": s1, "rate": input\["rate"\] \}\);/);
  assert.deepEqual(chainInput(steps, c.slots), { price: 200, discount: 20, rate: 8, people: 4 });
  const lib = OWNED.map((s) => `const skill_${s.name} = (() => { ${s.code}\n return main; })();`).join('\n');
  assert.equal(Math.round(new Function(`${lib}\n${c.code}; return main;`)()(chainInput(steps, c.slots)) * 1e6) / 1e6, 43.2);
});

test('a new chain is verified by the judge, then composed into a skill, then routed with ZERO model calls', async () => {
  const A = await setup();
  try {
    const cz = A.agency.crystallizer;
    // 1-2: unverified compositions: the agent loop answers and the chain's result is judged against it.
    for (const t of TASKS.slice(0, 2)) {
      const r = await run(A, t);
      assert.equal(r.skill, undefined);
      assert.match(r.final, new RegExp(String(truth(t)).replace('.', '\\.')));
      assert.equal(A.agency.ledger.list({ limit: 1, kind: 'skill.shadow' })[0].data.agree, true);
    }
    assert.equal(cz.chains().filter((c) => c.label === 'verified').length, 2);
    await cz.composeQueue;
    const sk = cz.list('active').find((s) => s.source.startsWith('chain:'));
    assert.ok(sk, 'composed after 2 verified chains of the same shape');
    assert.match(sk.verification.method, /no model wrote this code/);
    assert.equal(sk.verification.answerKey, '2/2');
    assert.deepEqual(sk.verification.steps, ['discount_price', 'add_tax', 'split_evenly']);
    assert.ok(cz.chains().every((c) => c.composed === sk.name));

    // 3: the composed skill is one candidate now: one bind call; its third example teaches the binder.
    const r3 = await run(A, TASKS[2]);
    assert.equal(r3.skill, sk.name);
    assert.match(r3.final, /\*\*Answer: 135\.15\*\*/);
    await cz.binderQueue;
    assert.ok(cz.binder(sk.name), 'binder learned from the composed skill\'s examples');

    // 4: zero model calls.
    A.calls.length = 0;
    const r4 = await run(A, TASKS[3]);
    assert.equal(r4.skill, sk.name);
    assert.equal(A.calls.length, 0, 'no model call at all');
    assert.match(r4.final, /\*\*Answer: 19\.26\*\*/);
  } finally { await A.cleanup(); }
});

test('a chain the judge refutes is never trusted or composed', async () => {
  const A = await setup();
  try {
    const cz = A.agency.crystallizer;
    cz.agentAnswer = async () => 'Each pays $1.';
    const realTruth = truth;
    for (const t of TASKS.slice(0, 2)) {
      current = t;
      await cz.shadowVerdict({ chain: normalizeChain(chainFor(t)), reason: 'test' }, t, 'Each pays $1.');
    }
    assert.equal(cz.chains().filter((c) => c.label === 'refuted').length, 2);
    await cz.composeQueue;
    assert.equal(cz.list('active').some((s) => s.source.startsWith('chain:')), false);
    assert.ok(realTruth);
  } finally { await A.cleanup(); }
});

// The real live-home skills (Phase 14 run 1) and the 3B binder's real replies.
const REAL = [
  { name: 'calculate_final_price', description: 'Calculates the final price of an item after applying two successive discounts.', params: { type: 'object', properties: { original_price: { type: 'number' }, discount1: { type: 'number', description: 'The first discount rate as a decimal (e.g., 0.12 for 12%).' }, discount2: { type: 'number', description: 'The second discount rate as a decimal (e.g., 0.08 for 8%).' } }, required: ['original_price', 'discount1', 'discount2'] } },
  { name: 'calculate_final_price_with_tax', description: 'Calculates the final price of an item after applying a discount and adding sales tax.', params: { type: 'object', properties: { original_price: { type: 'number' }, discount: { type: 'number', description: '(as a decimal fraction: 0.2 for 20%)' }, tax_rate: { type: 'number', description: '(as a decimal fraction: 0.2 for 20%)' } }, required: ['original_price', 'discount', 'tax_rate'] } },
  { name: 'calculate_individual_share', description: 'Calculates the amount each person pays when splitting a total amount evenly among a given number of people.', params: { type: 'object', properties: { total_amount: { type: 'number' }, number_of_people: { type: 'number' } }, required: ['total_amount', 'number_of_people'] } },
];

test('the model gives values, the agency gives structure: a flat "chain" binding becomes a unique chain', async () => {
  const { inferChain, extendChain } = await import('../src/evolve/crystallizer.js');
  const task = 'A $200 dinner is 20% off, then 8% sales tax is added, and the total is split evenly among 4 friends. How much does each friend pay?';
  // Real llama3.2 reply: {"skill":"chain","input":{"original_price":200,"discount":0.2,"tax_rate":0.08,"number_of_people":4}}
  const [chain, ...more] = inferChain({ original_price: 200, discount: 0.2, tax_rate: 0.08, number_of_people: 4 }, REAL);
  assert.equal(more.length, 0, 'exactly one structure uses every value');
  assert.equal(chainSignature(chain), 'calculate_final_price_with_tax(discount,original_price,tax_rate) > calculate_individual_share(number_of_people,total_amount=@1)');
  assert.equal(chainProblem(chain, REAL, task), null);
  assert.deepEqual(inferChain({ original_price: 200, discount: 0.2 }, REAL), [], 'no structure uses exactly these values');
  // Real reply for the two-discount task: the single skill, leaving "3 friends" unused.
  const t2 = 'A $300 hotel room is 20% off, then another 10% off, and the cost is split evenly among 3 friends. How much does each friend pay?';
  const ext = extendChain(REAL[0], { original_price: 300, discount1: 0.2, discount2: 0.1 }, [3], REAL);
  assert.deepEqual(ext.map(chainSignature).sort(), ['calculate_final_price(discount1,discount2,original_price) > calculate_individual_share(number_of_people,total_amount=@1)', 'calculate_final_price(discount1,discount2,original_price) > calculate_individual_share(number_of_people=@1,total_amount)'], 'the output could feed either input: both are kept, and the judge decides');
  assert.ok(ext.every((c) => chainProblem(c, REAL, t2) === null));
  assert.deepEqual(extendChain(REAL[0], { original_price: 300, discount1: 0.2, discount2: 0.1 }, [3, 5, 7], REAL), [], 'no skill consumes exactly the unused numbers');
});

test('an ambiguous composition is decided by the agent loop answer: only the matching structure is judged and learned', async () => {
  const A = await setup();
  try {
    const cz = A.agency.crystallizer;
    const t = 'A $300 hotel room is 20% off, and the cost is split evenly among 4 friends. How much does each friend pay?';
    const right = [{ skill: 'discount_price', input: { price: 300, discount: 20 } }, { skill: 'split_evenly', input: { total: { ref: 1 }, people: 4 } }];
    const wrong = [{ skill: 'discount_price', input: { price: 300, discount: 20 } }, { skill: 'split_evenly', input: { total: 4, people: { ref: 1 } } }];
    cz.agentAnswer = async () => 'Each pays $60.';
    const j = await cz.shadowVerdict({ candidates: [{ chain: wrong, signature: chainSignature(wrong), out: 4 / 240 }, { chain: right, signature: chainSignature(right), out: 60 }], reason: 'ambiguous composition' }, t, 'Each friend pays $60.');
    assert.equal(j.agree, true);
    assert.deepEqual(cz.chains().map((c) => [c.signature, c.label]), [[chainSignature(right), 'verified']]);
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'skill.chain_pick' })[0].data.picked, chainSignature(right));
  } finally { await A.cleanup(); }
});

test('a composed skill knows its verified wording from birth: unseen wording is not routed to it, even with only 2 examples', async () => {
  const A = await setup();
  try {
    const cz = A.agency.crystallizer;
    for (const t of TASKS.slice(0, 2)) await run(A, t);
    await cz.composeQueue;
    const sk = cz.list('active').find((s) => s.source.startsWith('chain:'));
    assert.equal(cz.examples(sk.name).filter((e) => e.label === 'pos').length, 2);
    const r = await run(A, 'A $100 dinner is 10% off, then a 5% service fee is added, and the total is split evenly among 2 friends. How much does each pay?');
    assert.equal(r.skill, undefined);
    assert.match(A.agency.ledger.list({ limit: 5, kind: 'skill.route_miss' }).map((x) => x.data.reason).join(' | '), /unverified wording \(.*"service"/);
  } finally { await A.cleanup(); }
});

test('a composed skill learns its binder at birth from its 2 verified chains: the very next task costs zero model calls', async () => {
  const A = await setup();
  try {
    const cz = A.agency.crystallizer;
    for (const t of TASKS.slice(0, 2)) await run(A, t);
    await cz.composeQueue; await cz.binderQueue;
    const sk = cz.list('active').find((s) => s.source.startsWith('chain:'));
    assert.ok(cz.binder(sk.name), 'binder induced from the 2 verified chains');
    A.calls.length = 0;
    const r = await run(A, TASKS[2]);
    assert.equal(r.skill, sk.name);
    assert.equal(A.calls.length, 0);
    assert.match(r.final, /\*\*Answer: 135\.15\*\*/);
  } finally { await A.cleanup(); }
});

test('a trusted chain is trusted only for verified wording: "an 18% tip" is not answered by a discount chain', async () => {
  const A = await setup({ composeSkills: false });
  try {
    const cz = A.agency.crystallizer;
    for (const t of TASKS.slice(0, 2)) await run(A, t);
    assert.equal(cz.chains().filter((c) => c.label === 'verified').length, 2, 'the shape is trusted now');
    const ok = await run(A, TASKS[2]);
    assert.match(String(ok.skill), / > /, 'same wording: answered by the trusted chain');
    const r = await run(A, 'A $100 dinner is 10% off, then an 18% tip is added, and the total is split evenly among 3 friends. How much does each pay?');
    assert.equal(r.skill, undefined);
    assert.match(A.agency.ledger.list({ limit: 5, kind: 'skill.route_miss' }).map((x) => x.data.reason).join(' | '), /unverified wording for composition .*"tip"/);
  } finally { await A.cleanup(); }
});

test('unit widening: a binder learned from "friends" also binds "4 people" when a blind paraphrase shows it, re-verified from scratch', async () => {
  synthPeople = true;
  const A = await setup();
  try {
    const cz = A.agency.crystallizer;
    for (const t of TASKS.slice(0, 2)) await run(A, t);
    await cz.composeQueue; await cz.binderQueue;
    const sk = cz.list('active').find((s) => s.source.startsWith('chain:'));
    const b = cz.binder(sk.name);
    assert.ok(b, 'admitted');
    const v = JSON.parse(b.verification);
    assert.deepEqual(v.widened, { people: ['people'] });
    assert.deepEqual(v.spec.params.people.units, ['friends', 'people']);
    assert.equal(v.coverage, 1);
    assert.equal(v.negatives, '1/1 refused', 'the widened binder still refuses the near-miss');
  } finally { synthPeople = false; await A.cleanup(); }
});
