// Learned binders: the routing step itself is crystallized, so matching tasks are answered with ZERO model calls.
import { makeAgency, systemOf, lastUser } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameInput } from '../src/evolve/crystallizer.js';

const DISCOUNT = {
  name: 'compound_discount', description: 'Final price after applying percentage discounts one after another.',
  params: { type: 'object', properties: { price: { type: 'number' }, discounts: { type: 'array', items: { type: 'number' } } }, required: ['price', 'discounts'] },
  code: 'function main(input) { return input.discounts.reduce((p, d) => p * (1 - d / 100), input.price); }',
};
const T = [
  'A jacket costs $120. The store takes 12% off, then a further 8% off. What does the jacket cost now?',
  'A $250 TV is discounted 20%, then a coupon takes another 10% off. What is the final price?',
  'Boots cost $90; they are 10% off and then 5% off. What do they cost?',
];
const NEW = 'A $60 lamp is 50% off, and then 20% off that. What is the price now?';
const NEAR_MISS = 'A $40 shirt has a 25% discount. How much money do I save?';
const TAX = 'A $40 shirt has 25% sales tax added. What is the total?'; // no structural signal: only a semantic binder can refuse it

const GOOD = 'function bind(task) { if (/\\bsav(e|ing)/i.test(task)) return null; const p = task.match(/\\$(\\d+(?:\\.\\d+)?)/); const d = [...task.matchAll(/(\\d+(?:\\.\\d+)?)%/g)].map((m) => Number(m[1])); if (!p || !d.length || !/off|discount/i.test(task)) return null; return { price: Number(p[1]), discounts: d }; }';
const MEMORIZER = 'function bind(task) { if (task.includes("jacket")) return { price: 120, discounts: [12, 8] }; if (task.includes("TV")) return { price: 250, discounts: [20, 10] }; return null; }';
const GREEDY = 'function bind(task) { const p = task.match(/\\$(\\d+)/); const d = [...task.matchAll(/(\\d+)%/g)].map((m) => Number(m[1])); return p && d.length ? { price: Number(p[1]), discounts: d } : null; }';

/** What a correct model binder would return for a task (used to script the 'fast' binder). */
const parse = (task) => { if (/\bsav(e|ing)/i.test(task)) return null; const p = task.match(/\$(\d+(?:\.\d+)?)/); const d = [...task.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1])); return p && d.length ? { price: Number(p[1]), discounts: d } : null; };

function script({ binder = GOOD } = {}) {
  return (req) => {
    const sys = systemOf(req), u = lastUser(req);
    if (/turn a solved task into ONE reusable/.test(sys)) return DISCOUNT;
    if (/independently implement/.test(sys)) return { code: DISCOUNT.code, inputs: [{ price: 120, discounts: [12, 8] }, { price: 100, discounts: [] }, { price: 50, discounts: [50, 50] }] };
    if (/You route tasks to verified functions/.test(sys)) { const task = u.split('\n\nFunctions:')[0].replace(/^Task:\n/, ''); const inp = parse(task); return inp ? { skill: 'compound_discount', input: inp } : { skill: null }; }
    if (/You write a pure JavaScript parser/.test(sys)) return { code: binder };
    if (/You write test cases for a task router/.test(sys)) return { positives: [{ task: 'Shoes are $80, with 25% off and then 10% off. What do they cost?', input: { price: 80, discounts: [25, 10] } }, { task: 'Price of a $200 bike after 15% off?', input: { price: 200, discounts: [15] } }], negatives: [NEAR_MISS, TAX] };
    if (/reviewing your own draft/.test(sys)) return { issues: [], final: 'about right', confidence: 0.6 };
    return { thought: 'by hand', final: 'about right', confidence: 0.6 };
  };
}
async function setup(opts = {}, skills = {}) {
  const A = await makeAgency(script(opts), { skills: { first: true, bindRole: 'fast', minOverlap: 1, learnBinders: true, binderMinExamples: 3, ...skills } });
  assert.equal((await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: 'A $120 item gets 12% off then 8% off: 97.152.' })).admitted, true);
  return A;
}
const teach = async (A) => { for (const t of T) assert.ok((await A.agency.runtime.run('tycho', t)).skill); };

test('structural gates: unused numbers and answer form stop misroutes that every model size made', async () => {
  const { bindingProblem, normalizeCode } = await import('../src/evolve/crystallizer.js');
  const sk = { name: 'compound_discount', ...DISCOUNT };
  const SPEED = { name: 'round_trip_speed', description: 'Average speed of a round trip at two speeds.', params: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } };
  assert.equal(bindingProblem({ price: 72, discounts: [50, 25] }, sk, 'A $72 jacket is discounted 50%, then 25%. What is the final price?'), null);
  assert.match(bindingProblem({ price: 200, discounts: [10, 5] }, sk, 'A $200 phone gets 10% off, then 5% off. How much money did I save in total?'), /difference or saving/);
  assert.match(bindingProblem({ price: 90, discounts: [30, 10] }, sk, 'A $90 jacket gets 30% off, then 10% off. How many dollars cheaper is it than the original price?'), /difference or saving/);
  assert.match(bindingProblem({ price: 50, discounts: [20, 15] }, sk, 'Store A sells a $50 item at 20% off and store B at 15% off. Which store is cheaper?'), /choice/);
  assert.match(bindingProblem({ price: 100, discounts: [15, 10] }, sk, 'Is 15% off and then 10% off a $100 item better than a single 25% off? Answer yes or no.'), /states 25/);
  assert.match(bindingProblem({ a: 60, b: 40 }, SPEED, 'A car drives 60 mph for 3 hours and then 40 mph for 1 hour. What is the average speed?'), /states 3, 1/);
  assert.equal(bindingProblem({ a: 10, b: 15 }, SPEED, 'I cycle out at 10 mph and back at 15 mph on the same route. Average speed for the round trip?'), null);
  const SAVINGS = { name: 'total_savings', description: 'How much is saved after successive percentage discounts.', params: DISCOUNT.params };
  assert.equal(bindingProblem({ price: 200, discounts: [10, 5] }, SAVINGS, 'A $200 phone gets 10% off, then 5% off. How much money did I save?'), null, 'a skill that computes savings may answer a savings question');
  assert.equal(normalizeCode('function bind(task) {\\n  return null;\\n}'), 'function bind(task) {\n  return null;\n}', 'double-escaped newlines are repaired');
  assert.equal(normalizeCode('function bind(t) {\n  return /\\d/.test(t) ? {} : null;\n}'), 'function bind(t) {\n  return /\\d/.test(t) ? {} : null;\n}', 'real code is left alone');
});

test('learning re-audits stored positives: a binding the gates now reject becomes a counter-example', async () => {
  const A = await setup({}, { learnBinders: false });
  try {
    await teach(A);
    const savings = 'A $200 phone gets 10% off, then 5% off. How much money did I save in total?';
    A.agency.store.run("INSERT INTO skill_examples (id, skill, task, input, label, created) VALUES ('se_poison', 'compound_discount', ?, ?, 'pos', '2026-01-01')", savings, JSON.stringify({ price: 200, discounts: [10, 5] }));
    await A.agency.crystallizer.learnBinder('compound_discount');
    const ex = A.agency.crystallizer.examples('compound_discount').find((e) => e.id === 'se_poison');
    assert.equal(ex.label, 'neg');
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'binder.audit' })[0].data.demoted, 1);
  } finally { await A.cleanup(); }
});

test('sameInput is strict about structure (no unwrapping) with numeric tolerance', () => {
  assert.ok(sameInput({ price: 120, discounts: [12, 8.0000000000001] }, { discounts: [12, 8], price: 120 }));
  assert.ok(!sameInput({ price: 120 }, 120));
  assert.ok(!sameInput({ price: 120, discounts: [12] }, { price: 120, discounts: [12, 8] }));
});

test('after enough grounded bindings the binder is learned automatically, and matching tasks need ZERO model calls', async () => {
  const A = await setup();
  try {
    await teach(A);
    await A.agency.crystallizer.binderQueue;
    const b = A.agency.crystallizer.binder('compound_discount');
    assert.ok(b, 'binder admitted');
    const v = JSON.parse(b.verification);
    assert.equal(v.heldOut, true);
    assert.equal(v.negatives, '2/2 refused', 'both blind near-misses are refused');
    assert.equal(v.method, 'induction', 'learned from the examples with no model writing code');
    assert.ok(!A.calls.some((c) => /You write a pure JavaScript parser/.test(systemOf(c))), 'no code-writing model was asked');
    assert.equal(v.coverage, 0.5, 'the 2-discount paraphrase binds; the 1-discount one has a number shape never seen, so it is left to the model binder');
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'binder.admit' }).length, 1);

    A.calls.length = 0;
    const r = await A.agency.runtime.run('tycho', NEW);
    assert.equal(r.skill, 'compound_discount');
    assert.match(r.final, /\*\*Answer: 24\*\*/);
    assert.equal(A.calls.length, 0, 'no model was called at all');
    assert.equal(r.binder, b.id);
    const [route] = A.agency.ledger.list({ limit: 1, kind: 'skill.route' });
    assert.equal(route.data.spent, 0);
    assert.equal(route.data.bindModel, 'learned-binder');
    assert.equal(A.agency.crystallizer.stats().zeroCall, 1);

    // The near-miss is refused by the binder and falls through (to the model binder, which also declines).
    const n = await A.agency.runtime.run('tycho', NEAR_MISS);
    assert.equal(n.skill, undefined);
  } finally { await A.cleanup(); }
});

test('a binder that memorizes its examples fails the held-out example it never saw', async () => {
  const A = await setup({ binder: MEMORIZER }, { learnBinders: false, binderInduction: false });
  try {
    await teach(A);
    const r = await A.agency.crystallizer.learnBinder('compound_discount');
    assert.equal(r.admitted, false);
    assert.match(r.reason, /held-out example it never saw/);
    const [held] = A.agency.crystallizer.examples('compound_discount').filter((e) => e.label === 'pos').slice(-1);
    const writer = A.calls.find((c) => /You write a pure JavaScript parser/.test(systemOf(c)));
    assert.ok(!JSON.stringify(writer.messages).includes(held.task), 'the writer never saw the held-out task');
  } finally { await A.cleanup(); }
});

test('a binder that would route a near-miss no gate can see (sales TAX parsed as a discount) is rejected: safety is all-or-nothing', async () => {
  const A = await setup({ binder: GREEDY }, { learnBinders: false, binderInduction: false });
  try {
    await teach(A);
    const r = await A.agency.crystallizer.learnBinder('compound_discount');
    assert.equal(r.admitted, false);
    assert.match(r.reason, /would route 1 task\(s\) that must not bind/);
    assert.equal(A.agency.crystallizer.binder('compound_discount'), null);
  } finally { await A.cleanup(); }
});

test('learned block words gate the MODEL binder too, and disputed examples are excluded from learning', async () => {
  const A = await setup({}, { learnBinders: false });
  try {
    await teach(A);
    // A refusal teaches "save"; a misroute recorded as a positive is disputed by leave-one-out.
    A.agency.store.run("INSERT INTO skill_examples (id, skill, task, input, label, created) VALUES ('se_n', 'compound_discount', ?, NULL, 'neg', '2026-01-01')", 'A $40 shirt has a 25% discount and a 5% coupon. How much money do I save?');
    A.agency.store.run("INSERT INTO skill_examples (id, skill, task, input, label, created) VALUES ('se_d', 'compound_discount', ?, ?, 'pos', '2026-01-02')", 'A $30 hat is 10% off, then 10% off. How much money is that?', JSON.stringify({ price: 30, discounts: [10, 10] }));
    const r = await A.agency.crystallizer.learnBinder('compound_discount');
    assert.equal(r.admitted, true, r.reason);
    assert.match(r.reason, /1 disputed example\(s\) excluded/);
    assert.equal(A.agency.crystallizer.examples('compound_discount').find((e) => e.id === 'se_d').label, 'disputed');
    // The model binder would bind this, but "money" only ever appeared in refused tasks.
    A.agency.store.run("UPDATE skill_binders SET code = 'function bind(task) { return null; }' WHERE status = 'active'");
    const res = await A.agency.runtime.run('tycho', 'A $70 vase is 10% off, then 20% off. How much money is that now?');
    assert.equal(res.skill, undefined);
    assert.match(A.agency.ledger.list({ limit: 1, kind: 'skill.route_miss' })[0].data.reason, /"money", which only ever appeared in tasks this skill had to refuse/);
  } finally { await A.cleanup(); }
});

test('refusals become negative examples; private work never becomes an example', async () => {
  const A = await setup({}, { learnBinders: false });
  try {
    await A.agency.runtime.run('tycho', NEAR_MISS);
    await A.agency.runtime.run('tycho', T[0], { privacy: 'private' });
    const ex = A.agency.crystallizer.examples('compound_discount');
    assert.deepEqual(ex.map((e) => e.label), ['neg']);
    assert.equal(ex[0].task, NEAR_MISS);
  } finally { await A.cleanup(); }
});

test('a broken learned binder falls through to the model binder; a critic-rejected zero-call route retires the binder', async () => {
  const A = await setup({}, { learnBinders: false });
  try {
    await teach(A);
    assert.equal((await A.agency.crystallizer.learnBinder('compound_discount')).admitted, true);
    // Corrupt it in place: it now throws. Routing still works through the model binder, and the miss is recorded.
    A.agency.store.run("UPDATE skill_binders SET code = 'function bind(task) { throw new Error(\"x\"); }' WHERE status = 'active'");
    A.calls.length = 0;
    const r = await A.agency.runtime.run('tycho', NEW);
    assert.equal(r.skill, 'compound_discount');
    assert.equal(A.calls.length, 1, 'one model bind call');
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'skill.route' })[0].data.binderMissed, true);

    A.agency.store.run(`UPDATE skill_binders SET code = ? WHERE status = 'active'`, GOOD);
    const base = script();
    A.agency.router.extra[0].chat = async (req) => {
      const sys = systemOf(req), u = lastUser(req);
      const body = /director of an AI agency/.test(sys) ? { summary: 'one', tasks: [{ id: 't1', title: 'Price', agent: 'tycho', instructions: NEW, deps: [] }] }
        : /You are Solon, a strict but fair critic/.test(sys) ? (/crystallized skill/.test(u) ? { score: 0.1, pass: false, defects: ['wrong'], fix: '' } : { score: 0.9, pass: true, defects: [], fix: '' })
          : /Sentinel/.test(sys) ? { risk: 'none', findings: [] } : base(req);
      return { text: JSON.stringify(body), model: 'scripted', provider: 'scripted', latencyMs: 1, usage: { prompt: 1, completion: 1 } };
    };
    const m = A.agency.missions.create(NEW);
    await A.agency.missions.waitFor(m.id, 30000);
    assert.equal(A.agency.crystallizer.binder('compound_discount'), null, 'binder retired');
    assert.equal(A.agency.crystallizer.list('active').length, 1, 'the skill itself stays');
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'binder.retire' }).length, 1);
  } finally { await A.cleanup(); }
});
