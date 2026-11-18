// Skill-first routing: agents use what the agency owns (verified skills) before spending model turns.
import { makeAgency, systemOf, lastUser } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundingProblem, words } from '../src/evolve/crystallizer.js';

const DISCOUNT = {
  name: 'compound_discount', description: 'Final price after applying percentage discounts one after another.',
  params: { type: 'object', properties: { price: { type: 'number' }, discounts: { type: 'array', items: { type: 'number' } } }, required: ['price', 'discounts'] },
  code: 'function main(input) { return input.discounts.reduce((p, d) => p * (1 - d / 100), input.price); }',
};
const INPUTS = [{ price: 120, discounts: [12, 8] }, { price: 100, discounts: [] }, { price: 50, discounts: [50, 50] }];
const TASK = 'A jacket costs $120. The store takes 12% off, then a further 8% off the reduced price. What does the jacket cost now?';
const BINDER = /You route tasks to verified functions/;
const AGENT_FINAL = { thought: 'did it by hand', final: 'About 97.15', confidence: 0.7 };

/** Scripted models: crystallization (extract + reference), the binder, and an ordinary agent loop. */
function script(bind = { skill: 'compound_discount', input: { price: 120, discounts: [12, 8] } }) {
  return (req) => {
    const sys = systemOf(req);
    if (/turn a solved task into ONE reusable/.test(sys)) return DISCOUNT;
    if (/independently implement/.test(sys)) return { code: DISCOUNT.code, inputs: INPUTS };
    if (BINDER.test(sys)) return bind;
    if (/reviewing your own draft/.test(sys)) return { issues: [], final: AGENT_FINAL.final, confidence: 0.7 };
    return AGENT_FINAL;
  };
}
async function withSkill(bind) {
  const A = await makeAgency(script(bind));
  const r = await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: 'A $120 item gets 12% off then 8% off: 97.152.' });
  assert.equal(r.admitted, true, r.reason);
  A.calls.length = 0;
  return A;
}

test('grounding: bound values must appear literally in the task, with the schema satisfied', () => {
  const schema = DISCOUNT.params;
  assert.equal(groundingProblem({ price: 120, discounts: [12, 8] }, schema, TASK), null);
  assert.match(groundingProblem({ price: 120, discounts: [0.12, 0.08] }, schema, TASK), /0\.12 does not appear/, 'a binder may not rescale 12% into 0.12');
  assert.match(groundingProblem({ price: 130, discounts: [12] }, schema, TASK), /130 does not appear/, 'a binder may not invent values');
  assert.match(groundingProblem({ price: 120 }, schema, TASK), /discounts is missing/);
  assert.match(groundingProblem({ price: '120', discounts: [12] }, schema, TASK), /price should be number/);
  assert.equal(groundingProblem({ a: 11 }, {}, 'due 2026-11-17'), null, '"2026-11" contains 11, not -11');
  // A conversion is allowed only when the skill's own contract declares it and the task states that percentage.
  const DEC = { type: 'object', properties: { price: { type: 'number' }, rate: { type: 'number', description: 'discount rate as a decimal (0.12 for 12%)' } }, required: ['price', 'rate'] };
  assert.equal(groundingProblem({ price: 120, rate: 0.12 }, DEC, TASK), null, 'declared percent-as-decimal, and 12% is in the task');
  assert.match(groundingProblem({ price: 120, rate: 0.15 }, DEC, TASK), /0\.15 does not appear/, '15% is not in the task');
  assert.match(groundingProblem({ price: 120, discounts: [0.12] }, schema, TASK), /does not appear/, 'undeclared conversion still rejected');
  assert.ok(words('Applying discounts').includes('discount'));
});

test('a matching task is answered by the skill: one short bind call instead of the agent loop, exact result', async () => {
  const A = await withSkill();
  try {
    const r = await A.agency.runtime.run('tycho', TASK);
    assert.equal(r.skill, 'compound_discount');
    assert.match(r.final, /\*\*Answer: 97\.152\*\*/, r.final);
    assert.match(r.final, /skill_compound_discount/);
    assert.equal(A.calls.length, 1, 'only the binder ran');
    assert.ok(BINDER.test(systemOf(A.calls[0])) && A.calls[0].role === 'fast' && A.calls[0].privacy === 'private');
    assert.equal(r.steps[0].tool, 'skill_compound_discount');
    const [entry] = A.agency.ledger.list({ limit: 1, kind: 'skill.route' });
    assert.equal(entry.data.skill, 'compound_discount');
    assert.deepEqual(entry.data.input, { price: 120, discounts: [12, 8] });
    const st = A.agency.crystallizer.stats();
    assert.equal(st.routed, 1);
    assert.equal(st.curve.length, 1);
    assert.ok(st.callsAvoidedMin >= 0);
  } finally { await A.cleanup(); }
});

test('an unrelated task costs nothing: no candidate skill, no bind call', async () => {
  const A = await withSkill();
  try {
    const r = await A.agency.runtime.run('tycho', 'Write a haiku about autumn rain.');
    assert.equal(r.skill, undefined);
    assert.ok(!A.calls.some((c) => BINDER.test(systemOf(c))), 'the prefilter rejected it without a model');
  } finally { await A.cleanup(); }
});

test('a binder that rescales or invents values is rejected and the agent loop answers instead', async () => {
  const A = await withSkill({ skill: 'compound_discount', input: { price: 120, discounts: [0.12, 0.08] } });
  try {
    const r = await A.agency.runtime.run('tycho', TASK);
    assert.equal(r.skill, undefined);
    assert.ok(r.final.startsWith(AGENT_FINAL.final), r.final); // plus the Phase 19 second-voice note
    const [miss] = A.agency.ledger.list({ limit: 1, kind: 'skill.route_miss' });
    assert.match(miss.data.reason, /binding rejected: discounts\[0\] = 0\.12 does not appear/);
    assert.equal(A.agency.crystallizer.list('active')[0].failures, 0, 'a bad binding is not held against the skill');
  } finally { await A.cleanup(); }
});

test('binder says no skill fully answers: falls through; seeded and skillFirst:false runs never route', async () => {
  const A = await withSkill({ skill: null });
  try {
    assert.equal((await A.agency.runtime.run('tycho', TASK)).skill, undefined);
    A.calls.length = 0;
    await A.agency.runtime.run('tycho', TASK, { seed: 3 });
    await A.agency.runtime.run('tycho', TASK, { skillFirst: false });
    assert.ok(!A.calls.some((c) => BINDER.test(systemOf(c))), 'evolution/bench (seeded) and retries never route');
  } finally { await A.cleanup(); }
});

test('in a mission, a skill answer the critic rejects is ledgered and the retry runs the full agent loop', async () => {
  const base = script();
  const A = await makeAgency((req) => {
    const sys = systemOf(req), u = lastUser(req);
    if (/director of an AI agency/.test(sys)) return { summary: 'one', tasks: [{ id: 't1', title: 'Price', agent: 'tycho', instructions: TASK, deps: [] }] };
    if (/You are Solon, a strict but fair critic/.test(sys)) return /crystallized skill/.test(u) ? { score: 0.2, pass: false, defects: ['needs the working shown'], fix: 'show steps' } : { score: 0.95, pass: true, defects: [], fix: '' };
    if (/Sentinel, a security reviewer/.test(sys)) return { risk: 'none', findings: [] };
    return base(req);
  });
  try {
    assert.equal((await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: 'A $120 item gets 12% off then 8% off: 97.152.' })).admitted, true);
    const m = A.agency.missions.create(TASK);
    const done = await A.agency.missions.waitFor(m.id, 30000);
    assert.equal(done.status, 'completed');
    assert.equal(A.agency.ledger.list({ limit: 5, kind: 'skill.route' }).length, 1, 'routed once, on the first attempt only');
    const [rej] = A.agency.ledger.list({ limit: 1, kind: 'skill.route_rejected' });
    assert.equal(rej.data.skill, 'compound_discount');
    assert.equal(A.agency.crystallizer.stats().routeRejected, 1);
  } finally { await A.cleanup(); }
});

test('ask reports what an answer cost: model calls counted per request, not across concurrent work', async () => {
  const A = await withSkill();
  try {
    // Concurrent work outside the ask must not be billed to it.
    const [r, other] = await Promise.all([
      A.agency.ask('tycho', TASK),
      A.agency.router.chat({ role: 'reason', messages: [{ role: 'user', content: 'unrelated' }] }),
    ]);
    assert.ok(other.text);
    assert.equal(r.route.skill, 'compound_discount');
    assert.equal(r.meter.calls, 1, 'only the bind call belongs to this answer');
    assert.equal(A.calls.length, 2, 'the provider saw both calls');
    assert.ok(r.meter.ms >= 0 && r.meter.tokens === 20);
    // An unrelated task goes to the agent loop, and its calls are counted.
    const q = await A.agency.ask('tycho', 'Write a haiku about rain.');
    assert.equal(q.route.skill, null);
    assert.ok(q.meter.calls >= 1);
  } finally { await A.cleanup(); }
});
