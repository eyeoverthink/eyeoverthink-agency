// Crystallization: solved tasks become verified, owned, executable skills that need no model.
import { makeAgency, systemOf } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOutput } from '../src/evolve/crystallizer.js';

const okFinal = { thought: 'done', final: 'ok', confidence: 0.9 };
const DISCOUNT = {
  name: 'compound_discount', description: 'Final price after applying percentage discounts one after another.',
  params: { type: 'object', properties: { price: { type: 'number' }, discounts: { type: 'array', items: { type: 'number' } } }, required: ['price', 'discounts'] },
};
const GOOD = 'function main(input) { return input.discounts.reduce((p, d) => p * (1 - d / 100), input.price); }';
const ADDITIVE_BUG = 'function main(input) { return input.price * (1 - input.discounts.reduce((a, b) => a + b, 0) / 100); }';
const INPUTS = [{ price: 120, discounts: [12, 8] }, { price: 100, discounts: [] }, { price: 50, discounts: [50, 50] }, { price: 0, discounts: [10] }];

/** Scripted models: extractor (code role), reference (reason role), tie-break (plan role). */
function script({ candidate = GOOD, reference = GOOD, tiebreak = GOOD, extract = null } = {}) {
  return (req) => {
    const sys = systemOf(req);
    if (/turn a solved task into ONE reusable/.test(sys)) return extract || { ...DISCOUNT, code: candidate };
    if (/independently implement a specified function/.test(sys)) return req.role === 'reason' ? { code: reference, inputs: INPUTS } : { code: tiebreak };
    return okFinal;
  };
}
const SRC = { kind: 'text', ref: 'test', text: 'A $120 item gets 12% off and then another 8% off. Final price: 97.152.' };

test('sameOutput: deep equality with numeric tolerance', () => {
  assert.ok(sameOutput({ a: [1, 2.0000000000001] }, { a: [1, 2] }));
  assert.ok(!sameOutput({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!sameOutput(97.152, 96));
  assert.ok(sameOutput({ averageSpeed: 0 }, 0), 'the same value in a single-key wrapper is the same output');
  assert.ok(!sameOutput({ a: 1, b: 2 }, 1), 'multi-key objects are not unwrapped');
});

test('a verified skill is admitted, signed, and callable as a tool with no model', async () => {
  const A = await makeAgency(script());
  try {
    const r = await A.agency.crystallizer.crystallize(SRC);
    assert.equal(r.admitted, true, r.reason);
    assert.match(r.reason, /independent implementation on 4 input/);
    const before = A.calls.length;
    const call = await A.agency.tools.call('skill_compound_discount', { input: { price: 120, discounts: [12, 8] } });
    assert.equal(call.ok, true, call.output);
    assert.ok(Math.abs(call.data.result - 97.152) < 1e-9);
    assert.equal(A.calls.length, before, 'the skill answered without any model call');
    assert.equal(A.agency.crystallizer.stats().uses, 1);
    const [entry] = A.agency.ledger.list({ limit: 1, kind: 'skill.admit' });
    assert.equal(entry.data.name, 'compound_discount');
    assert.match(entry.data.codeSha256, /^[0-9a-f]{64}$/);
    const extractor = A.calls.find((c) => /turn a solved task/.test(systemOf(c)));
    const refCall = A.calls.find((c) => /independently implement/.test(systemOf(c)));
    assert.ok(!JSON.stringify(refCall.messages).includes('reduce('), 'the reference never sees the candidate code');
    assert.ok(JSON.stringify(refCall.messages).includes('97.152'), 'the reference does see the solved task, the ground truth both derive from');
    assert.ok(extractor.privacy === 'private' && refCall.privacy === 'private');
  } finally { await A.cleanup(); }
});

test('a plausible but wrong skill (additive instead of compounding) loses the 2-of-3 vote', async () => {
  const A = await makeAgency(script({ candidate: ADDITIVE_BUG }));
  try {
    const r = await A.agency.crystallizer.crystallize(SRC);
    assert.equal(r.admitted, false);
    assert.match(r.reason, /lost the 2-of-3 vote/);
    assert.equal(A.agency.crystallizer.list().length, 0);
    assert.ok(!A.agency.tools.tools.has('skill_compound_discount'));
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'skill.reject' }).length, 1);
  } finally { await A.cleanup(); }
});

test('a buggy reference is outvoted: the correct skill is admitted on the tie-break', async () => {
  const A = await makeAgency(script({ reference: ADDITIVE_BUG }));
  try {
    const r = await A.agency.crystallizer.crystallize(SRC);
    assert.equal(r.admitted, true, r.reason);
    assert.match(r.reason, /2-of-3 tie-break/);
    assert.equal(r.verification.tiebreak, true);
  } finally { await A.cleanup(); }
});

test('skills compose: a new skill can call an admitted one, so capability compounds', async () => {
  const A = await makeAgency(script());
  try {
    assert.equal((await A.agency.crystallizer.crystallize(SRC)).admitted, true);
    const CART = { name: 'cart_total', description: 'Total of a cart where each line has a price and a list of compounding discounts.',
      params: { type: 'object', properties: { lines: { type: 'array' } }, required: ['lines'] },
      code: 'function main(input) { return input.lines.reduce((s, l) => s + skill_compound_discount(l), 0); }' };
    const REF = 'function main(input) { let t = 0; for (const l of input.lines) { let p = l.price; for (const d of l.discounts) p *= 1 - d / 100; t += p; } return t; }';
    A.agency.router.extra[0].chat = async (req) => {
      const sys = systemOf(req);
      const body = /turn a solved task/.test(sys) ? CART : /independently implement/.test(sys) ? { code: REF, inputs: [{ lines: [] }, { lines: [{ price: 120, discounts: [12, 8] }] }, { lines: [{ price: 10, discounts: [] }, { price: 50, discounts: [50] }] }] } : okFinal;
      return { text: JSON.stringify(body), model: 'scripted', provider: 'scripted', latencyMs: 1, usage: { prompt: 1, completion: 1 } };
    };
    const r = await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: 'sum a discounted cart' });
    assert.equal(r.admitted, true, r.reason);
    const call = await A.agency.tools.call('skill_cart_total', { input: { lines: [{ price: 120, discounts: [12, 8] }, { price: 10, discounts: [] }] } });
    assert.ok(Math.abs(call.data.result - 107.152) < 1e-9, JSON.stringify(call));
  } finally { await A.cleanup(); }
});

test('nothing reusable, malformed proposals and duplicate names are refused', async () => {
  const A = await makeAgency(script({ extract: { none: true } }));
  try {
    assert.match((await A.agency.crystallizer.crystallize(SRC)).reason, /no reusable computation/);
    A.agency.router.extra[0].chat = async () => ({ text: JSON.stringify({ name: 'Bad Name!', code: 'x', params: {} }), model: 's', provider: 's', latencyMs: 1, usage: { prompt: 1, completion: 1 } });
    assert.match((await A.agency.crystallizer.crystallize(SRC)).reason, /malformed/);
  } finally { await A.cleanup(); }
});

test('learned skills persist across a restart and are tools again from the first second', async () => {
  const A = await makeAgency(script());
  try {
    await A.agency.crystallizer.crystallize(SRC);
    const { Crystallizer } = await import('../src/evolve/crystallizer.js');
    A.agency.tools.tools.delete('skill_compound_discount');
    const fresh = new Crystallizer({ store: A.agency.store, router: A.agency.router, tools: A.agency.tools, missions: A.agency.missions, ledger: A.agency.ledger, bus: A.agency.bus });
    assert.equal(fresh.load(), 1);
    assert.ok(A.agency.tools.tools.has('skill_compound_discount'));
  } finally { await A.cleanup(); }
});

test('automatic: a well-scored mission is crystallized with nobody asking (private missions never are)', async () => {
  const { lastUser } = await import('./helpers.js');
  const mission = (req) => {
    const sys = systemOf(req), u = lastUser(req);
    if (/turn a solved task into ONE reusable/.test(sys)) return { ...DISCOUNT, code: GOOD };
    if (/independently implement a specified function/.test(sys)) return req.role === 'reason' ? { code: GOOD, inputs: INPUTS } : { code: GOOD };
    if (/director of an AI agency/.test(sys)) return { summary: 'one', tasks: [{ id: 't1', title: 'Compute', agent: 'tycho', instructions: 'compute the discounted price', deps: [] }] };
    if (/You are Solon, a strict but fair critic/.test(sys)) return { score: 0.95, pass: true, defects: [], fix: '' };
    if (/Sentinel, a security reviewer/.test(sys)) return { risk: 'none', findings: [] };
    if (/Combine the team's verified work/.test(u)) return { thought: 'merge', final: 'Final price: 97.152', confidence: 0.9 };
    return { thought: 'work', final: 'Final price: 97.152', confidence: 0.9 };
  };
  const A = await makeAgency(mission, { crystallize: { auto: true, minScore: 0.85 } });
  try {
    const admitted = new Promise((res) => A.agency.bus.once('skill.admit', res));
    const m = A.agency.missions.create('A $120 item gets 12% off then 8% off. What is the final price?');
    assert.equal((await A.agency.missions.waitFor(m.id, 30000)).status, 'completed');
    const ev = await admitted;
    assert.equal(ev.name, 'compound_discount');
    const [skill] = A.agency.crystallizer.list('active');
    assert.equal(skill.source, `mission:${m.id}`, 'provenance points at the mission it was learned from');

    const p = A.agency.missions.create('Same task, private.', { privacy: 'private' });
    await A.agency.missions.waitFor(p.id, 30000);
    await A.agency.crystalQueue;
    assert.equal(A.agency.ledger.list({ limit: 50, kind: 'skill.reject' }).filter((e) => String(e.data.source).includes(p.id)).length, 0, 'private work is never mined for skills');
  } finally { await A.cleanup(); }
});

test('inputs two of three implementations reject are out of domain, not evidence against the candidate', async () => {
  const SPEED = { name: 'round_trip_speed', description: 'Average speed of a round trip at two speeds (harmonic mean).', params: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } };
  const CAND = 'function main(i) { return 2 * i.a * i.b / (i.a + i.b); }';
  const STRICT = 'function main(i) { if (!(i.a > 0 && i.b > 0)) throw new Error("speeds must be positive"); return 2 * i.a * i.b / (i.a + i.b); }';
  const A = await makeAgency((req) => {
    const sys = systemOf(req);
    if (/turn a solved task/.test(sys)) return { ...SPEED, code: CAND };
    if (/independently implement/.test(sys)) return req.role === 'reason' ? { code: STRICT, inputs: [{ a: 40, b: 60 }, { a: 30, b: 50 }, { a: 100, b: 200 }, { a: 0, b: 10 }, { a: -5, b: 20 }] } : { code: STRICT };
    return okFinal;
  });
  try {
    const r = await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: '40 and 60 mph round trip: 48 mph' });
    assert.equal(r.admitted, true, r.reason);
    assert.ok(r.reason.includes('on 3 input(s)') && r.reason.includes('2 input(s) rejected by 2 of 3 as out of domain'), r.reason);
    assert.equal(r.verification.outOfDomain, 2);
  } finally { await A.cleanup(); }
});

test('determinism: a skill whose output changes between runs on the same input is never admitted (from Chandra skill forge)', async () => {
  const { makeAgency, systemOf } = await import('./helpers.js');
  const RAND = { name: 'noisy_total', description: 'Total of a price plus tax.', params: { type: 'object', properties: { price: { type: 'number' } }, required: ['price'] },
    code: 'function main(i) { return i.price * 1.08 + (Math.random() < 2 ? Math.random() * 1e-3 : 0); }' };
  const A = await makeAgency((req) => {
    const sys = systemOf(req);
    if (/turn a solved task into ONE reusable/.test(sys)) return RAND;
    if (/independently implement/.test(sys)) return { code: RAND.code, inputs: [{ price: 10 }, { price: 20 }, { price: 30 }] };
    return { final: 'ok' };
  });
  try {
    const r = await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: 'A $10 item plus 8% tax: 10.8.' });
    assert.equal(r.admitted, false);
    assert.match(r.reason, /not deterministic/);
  } finally { await A.cleanup(); }
});
