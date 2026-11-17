// Refusals become skills (Phase 13): tasks a skill refused, whose answers two different agents corroborated, are
// crystallized into a NEW skill that must reproduce those answers (the answer key) on top of differential testing.
import { makeAgency, systemOf, lastUser } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearAnswer } from '../src/evolve/crystallizer.js';

const DISCOUNT = {
  name: 'compound_discount', description: 'Final price after applying percentage discounts one after another.',
  params: { type: 'object', properties: { price: { type: 'number' }, discounts: { type: 'array', items: { type: 'number' } } }, required: ['price', 'discounts'] },
  code: 'function main(input) { return input.discounts.reduce((p, d) => p * (1 - d / 100), input.price); }',
};
const TEACH = [
  'A jacket costs $120. The store takes 12% off, then a further 8% off. What does the jacket cost now?',
  'A $250 TV is discounted 20%, then a coupon takes another 10% off. What is the final price?',
  'Boots cost $90; they are 10% off and then 5% off. What do they cost?',
];
const TAXED = [
  ['A $100 lamp is 20% off, then 5% tax is added. What is the total?', 84],
  ['A $50 bag is 10% off, then 8% tax is added. What is the total?', 48.6],
  ['A $200 desk is 25% off, then 6% tax is added. What do I pay?', 159],
];
const TAXSKILL = (code) => ({
  name: 'discount_then_tax', description: 'Total after a percentage discount and then a percentage sales tax.',
  params: { type: 'object', properties: { price: { type: 'number' }, discount: { type: 'number', description: 'discount percent' }, tax: { type: 'number', description: 'tax percent' } }, required: ['price', 'discount', 'tax'] },
  code,
});
const RIGHT = 'function main(i) { return Math.round(i.price * (1 - i.discount / 100) * (1 + i.tax / 100) * 100) / 100; }';
const WRONG = 'function main(i) { return Math.round(i.price * (1 - i.discount / 100) * (1 - i.tax / 100) * 100) / 100; }'; // tax as a 2nd discount

const nums = (t) => ({ price: Number(t.match(/\$(\d+(?:\.\d+)?)/)[1]), pcts: [...t.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1])) });
function script(code, refCode = code, dec = false) {
  return (req) => {
    const sys = systemOf(req), u = lastUser(req);
    if (/turn a solved task into ONE reusable/.test(sys)) {
      if (!/Solved tasks\. Each answer/.test(u)) return DISCOUNT;
      const tasks = [...u.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
      return { ...TAXSKILL(code), bindings: tasks.map((t) => { const n = nums(t); return { input: { price: n.price, discount: dec ? n.pcts[0] / 100 : n.pcts[0], tax: dec ? n.pcts[1] / 100 : n.pcts[1] } }; }) };
    }
    if (/independently implement/.test(sys)) {
      if (/discount_then_tax|sales tax/.test(u)) return { code: refCode, inputs: dec ? [{ price: 100, discount: 0.2, tax: 0.05 }, { price: 10, discount: 0, tax: 0.1 }, { price: 80, discount: 0.5, tax: 0 }] : [{ price: 100, discount: 20, tax: 5 }, { price: 10, discount: 0, tax: 10 }, { price: 80, discount: 50, tax: 0 }] };
      return { code: DISCOUNT.code, inputs: [{ price: 120, discounts: [12, 8] }, { price: 100, discounts: [] }, { price: 50, discounts: [50, 50] }] };
    }
    if (/You route tasks/.test(sys)) {
      const task = u.split('\n\nFunctions:')[0].replace(/^Task:\n/, ''), n = nums(task);
      if (/\btax\b/.test(task)) return /discount_then_tax/.test(u) ? { skill: 'discount_then_tax', input: { price: n.price, discount: n.pcts[0], tax: n.pcts[1] } } : { skill: 'compound_discount', input: { price: n.price, discounts: n.pcts } };
      return { skill: 'compound_discount', input: { price: n.price, discounts: n.pcts } };
    }
    if (/You write test cases for a task router/.test(sys)) return { positives: [], negatives: [] };
    return { thought: 'by hand', final: 'about right', confidence: 0.6 };
  };
}
async function setup(code, refCode = code, dec = false) {
  const A = await makeAgency(script(code, refCode, dec), { skills: { first: true, bindRole: 'fast', minOverlap: 1, learnBinders: false, binderMinExamples: 3, gapMin: 3 } });
  assert.equal((await A.agency.crystallizer.crystallize({ kind: 'text', ref: 'test', text: 'A $120 item gets 12% off then 8% off: 97.152.' })).admitted, true);
  for (const t of TEACH) assert.ok((await A.agency.runtime.run('tycho', t)).skill);
  assert.equal((await A.agency.crystallizer.learnBinder('compound_discount')).admitted, true);
  return A;
}
/** Each tax task: the parent's binding is declined, the agent loop and a second agent both say the taxed total. */
async function refuse(A) {
  const cz = A.agency.crystallizer;
  for (const [task, total] of TAXED) {
    cz.agentAnswer = async () => `The total is $${total}.`;
    const n = nums(task);
    const j = await cz.shadowVerdict({ skill: 'compound_discount', input: { price: n.price, discounts: n.pcts }, reason: 'test' }, task, `You pay $${total}.`);
    assert.equal(j.agree, false);
  }
  await cz.gapQueue;
}

test('nearAnswer: rounding to the answer precision agrees, real differences do not', () => {
  assert.ok(nearAnswer(110.16000000001, 110.16));
  assert.ok(nearAnswer(51.3, 51));
  assert.ok(!nearAnswer(93.84, 110.16));
  assert.ok(!nearAnswer(NaN, 1));
});

test('three corroborated refusals become a new skill, checked against their answers; it then answers new tasks of that kind', async () => {
  const A = await setup(RIGHT);
  try {
    const cz = A.agency.crystallizer;
    await refuse(A);
    const gaps = cz.gaps('compound_discount');
    assert.equal(gaps.length, 3);
    assert.ok(gaps.every((g) => g.markers.includes('tax after % #2')), 'markers name what the parent skill does not cover, and where');
    const sk = cz.list('active').find((s) => s.name === 'discount_then_tax');
    assert.ok(sk, 'admitted automatically once the family had 3 corroborated gaps');
    assert.equal(sk.verification.answerKey, '3/3');
    assert.match(sk.verification.method, /answer key/);
    assert.ok(cz.gaps('compound_discount').every((g) => g.status === 'learned' && g.resolved_by === 'discount_then_tax'));
    assert.equal(cz.examples('discount_then_tax').filter((e) => e.label === 'pos').length, 3, 'verified bindings are its first examples');
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'skill.gap_learned' })[0].data.skill, 'discount_then_tax');

    // A new tax task: the parent's learned binder declines it, and the new skill answers it exactly.
    const r = await A.agency.runtime.run('tycho', 'A $80 chair is 10% off, then 5% tax is added. What is the total?');
    assert.equal(r.skill, 'discount_then_tax');
    assert.match(r.final, /\*\*Answer: 75\.6\*\*/);
    // Discounts still go to the parent.
    assert.equal((await A.agency.runtime.run('tycho', 'A $60 lamp is 50% off, and then 20% off that. What is the price now?')).skill, 'compound_discount');
  } finally { await A.cleanup(); }
});

test('a candidate that treats tax as a second discount passes differential testing (its blind twin agrees) but fails the answer key', async () => {
  const A = await setup(WRONG);
  try {
    const cz = A.agency.crystallizer;
    await refuse(A);
    assert.equal(cz.list('active').some((s) => s.name === 'discount_then_tax'), false);
    const [rej] = A.agency.ledger.list({ limit: 1, kind: 'skill.reject' });
    assert.match(rej.data.reason, /reproduces only 0\/3 corroborated answers/);
    assert.ok(cz.gaps('compound_discount').every((g) => g.status === 'open'), 'the gaps stay open for a later attempt');
  } finally { await A.cleanup(); }
});

test('the answer key outranks the vote: a blind reference that reproduces the answers is promoted over a wrong candidate', async () => {
  // Measured on real models: the extractor read percentages as fractions; the blind reference was right.
  const A = await setup(WRONG, RIGHT);
  try {
    const cz = A.agency.crystallizer;
    await refuse(A);
    const sk = cz.list('active').find((s) => s.name === 'discount_then_tax');
    assert.ok(sk, 'admitted with the reference implementation');
    assert.equal(sk.code, RIGHT);
    assert.equal(sk.verification.promoted.candidateKey, '0/3');
    assert.equal(sk.verification.answerKey, '3/3');
    assert.match((await A.agency.runtime.run('tycho', 'A $80 chair is 10% off, then 5% tax is added. What is the total?')).final, /\*\*Answer: 75\.6\*\*/);
  } finally { await A.cleanup(); }
});

test('contract repair: bindings that are the task percentages / 100 get the "decimal" clause the schema forgot, then the key decides', async () => {
  // Measured on real models: every binding used 0.1 for "10%" but no parameter description said "decimal".
  const DEC = 'function main(i) { return Math.round(i.price * (1 - i.discount) * (1 + i.tax) * 100) / 100; }';
  const A = await setup(DEC, DEC, true);
  try {
    const sk = A.agency.crystallizer.list('active').find((s) => s.name === 'discount_then_tax') || null;
    assert.equal(sk, null, 'nothing to learn yet');
    await refuse(A);
    const got = A.agency.crystallizer.list('active').find((s) => s.name === 'discount_then_tax');
    assert.ok(got, 'admitted after repair');
    assert.deepEqual(got.verification.contractRepaired, ['discount', 'tax']);
    assert.match(got.params.properties.tax.description, /decimal fraction/);
    assert.equal(got.verification.answerKey, '3/3');
  } finally { await A.cleanup(); }
});
