// Binder induction: the agency learns how to bind a skill from its own recorded bindings, with no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberTokens, shapeOf, questionWords, induce, applySpec, leaveOneOut, compileSpec, contested } from '../src/evolve/binder-induction.js';

// The real learned skill's contract: rates as decimals (Phase 10/11).
const PRICE = { name: 'calculate_final_price', description: 'Final price after two successive discounts.', params: { type: 'object', required: ['original_price', 'discount1', 'discount2'], properties: {
  original_price: { type: 'number' }, discount1: { type: 'number', description: 'first rate as a decimal (0.12 for 12%)' }, discount2: { type: 'number', description: 'second rate as a decimal' } } } };
const P = (task, p, a, b) => ({ task, input: { original_price: p, discount1: a, discount2: b } });
const POS = [
  P('A coat is $150. It is marked down 10%, and then another 20% comes off at the register. What is the final price?', 150, 0.1, 0.2),
  P('Sneakers list at $80; first 25% off, then 10% off the sale price. What do I pay?', 80, 0.25, 0.1),
  P('A $45 book gets 20% off and then a 5% member discount. What is the final price?', 45, 0.2, 0.05),
  P('A $300 chair is reduced by 30%, then by a further 15%. What does it cost now?', 300, 0.3, 0.15),
];
const NEG = [{ task: 'A $90 jacket gets 30% off, then 10% off. How many dollars cheaper is it than the original price?' }];

test('number tokens carry their kind; shapes and question words', () => {
  assert.deepEqual(numberTokens('A $45 book gets 20% off, then 5 percent, in 2026-11.').map((t) => `${t.kind}:${t.v}`), ['currency:45', 'percent:20', 'percent:5', 'plain:2026', 'plain:11']);
  assert.equal(shapeOf(numberTokens('$10, 5% and 3%')), '1,2,0');
  assert.deepEqual(questionWords('A coat is $150. What is the final price?'), ['final', 'price']);
});

test('induction finds one selector per parameter, consistent with every example, and compiles to identical code', () => {
  const r = induce(POS, NEG, PRICE);
  assert.deepEqual(r.spec.params.original_price, { kind: 'currency', k: 0, scale: 1 });
  assert.deepEqual(r.spec.params.discount1, { kind: 'percent', k: 0, scale: 0.01 }, 'the declared percent-as-decimal is learned, not assumed');
  assert.deepEqual(r.spec.shapes, ['1,2,0']);
  assert.ok(r.spec.blockWords.includes('cheaper') && r.spec.blockWords.includes('original'));
  assert.ok(!r.spec.blockWords.includes('off'), 'words that occur in positive tasks are never block words');
  const bind = new Function(`${compileSpec(r.spec)}; return bind;`)();
  for (const t of ['A $500 sofa is 40% off, then an extra 10% off. What is the price?', 'A car goes 50 mph for 2 hours. Speed?', 'A $60 coat is 20% off, then 10% off. What percent of the original price do I pay?']) {
    assert.deepEqual(bind(t), applySpec(r.spec, t));
  }
  assert.deepEqual(bind('A $500 sofa is 40% off, then an extra 10% off. What is the price?'), { original_price: 500, discount1: 0.4, discount2: 0.1 });
  assert.equal(bind('A $40 shirt has 25% sales tax added. What is the total?'), null, 'a number shape never seen does not bind');
  assert.equal(bind('A $60 coat is 20% off, then 10% off. What percent of the original price do I pay?'), null, '"original" was learned from a refusal');
});

test('leave-one-out flags a misroute recorded as a positive: the rest of the evidence refuses it', () => {
  const poisoned = [...POS, P('A $60 coat is 20% off, then 10% off. What percent of the original price do I pay?', 60, 0.2, 0.1)];
  const loo = leaveOneOut(poisoned, NEG, PRICE);
  assert.deepEqual(loo.map((x) => x.ok), [true, true, true, true, false]);
});

test('no single rule: induction refuses rather than guessing', () => {
  const mixed = [POS[0], { task: 'Pay $20 after 10% and 30% off?', input: { original_price: 20, discount1: 0.3, discount2: 0.1 } }, POS[2]];
  assert.match(induce(mixed, [], PRICE).error, /no single rule finds discount1/);
});

test('units are learned for plain numbers: "40 mph ... 60 mph" binds, "120 miles in 2 hours" does not; a new unit is novelty, not dispute', () => {
  const SPEED = { name: 'round_trip_speed', description: 'Average speed of a round trip.', params: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } } };
  const S = (task, a, b) => ({ task, input: { a, b } });
  const pos = [S('I jog out at 6 mph and back at 3 mph. Average speed for the round trip?', 6, 3), S('A plane flies out at 400 km/h and back at 600 km/h. Average speed?', 400, 600),
    S('Driving to work at 30 mph and home at 45 mph. Average speed?', 30, 45), S('A ferry crosses at 20 knots and returns at 30 knots. Average speed?', 20, 30)];
  const r = induce(pos, [], SPEED);
  assert.deepEqual(r.spec.params.a.units, ['km/h', 'knots', 'mph']);
  assert.deepEqual(applySpec(r.spec, 'A bus goes out at 45 mph and back at 55 mph. Average speed for the round trip?'), { a: 45, b: 55 });
  assert.equal(applySpec(r.spec, 'A train travels 120 miles in 2 hours. What is its average speed?'), null);
  const loo = leaveOneOut(pos, [], SPEED);
  assert.deepEqual(loo.map((x) => (x.ok ? 'ok' : x.novel ? 'novel' : 'miss')), ['ok', 'novel', 'ok', 'novel'], 'km/h and knots each appear in one example only');
});

test('occurrences count: a repeated number the binding skips is caught, but a mission prompt restating the goal is not', async () => {
  const { bindingProblem } = await import('../src/evolve/crystallizer.js');
  assert.match(bindingProblem({ original_price: 50, discount1: 0.1, discount2: 0.08 }, PRICE, 'A $50 item is 10% off, then 10% off. What is the final price including 8% tax?'), /states 10 once more/);
  assert.equal(bindingProblem({ original_price: 120, discount1: 0.12, discount2: 0.08 }, PRICE, 'Mission goal: A $120 item gets 12% off then 8% off. Final price?\nYour task: Price\nApply 12% then 8% to $120.'), null);
  assert.equal(bindingProblem({ original_price: 100, discount1: 0.2, discount2: 0.2 }, PRICE, 'A $100 watch is 20% off, then 20% off again. What is the final price?'), null);
});

test('body block words: a refused tax task teaches "tax" after a percentage, but a refused jacket task never blocks jackets', () => {
  const TAXNEG = { task: 'A $40 shirt is 20% off, and then 5% sales tax is added. What is the total?' };
  const r = induce(POS, [...NEG, TAXNEG], PRICE);
  assert.deepEqual(r.spec.contextBlock.kinds, ['percent'], '"off" follows a percentage in most good examples: a closed role vocabulary; item nouns after "$" are open');
  assert.ok(r.spec.contextBlock.words.includes('tax') && r.spec.contextBlock.words.includes('sales'));
  assert.ok(!r.spec.contextBlock.words.includes('jacket') && !r.spec.contextBlock.words.includes('shirt'), 'nouns after a currency number are never learned');
  const bind = new Function(`${compileSpec(r.spec)}; return bind;`)();
  assert.equal(bind('A $75 bag gets 10% off, then 8% tax. What is the final price?'), null, 'other tax wordings are refused in the body, with no question word to go on');
  assert.deepEqual(bind('A $75 jacket gets 10% off, then 8% off. What is the final price?'), { original_price: 75, discount1: 0.1, discount2: 0.08 }, 'jackets still bind');
  assert.deepEqual(bind('A $200 shirt is 25% off, then a 10% loyalty discount. What do I pay?'), { original_price: 200, discount1: 0.25, discount2: 0.1 }, 'unseen role words are not refused: only words from refused tasks block');
  assert.deepEqual(numberTokens('then 5% sales tax is added. What').map((t) => t.ctx), [['sales', 'tax', 'added']]);
});

test('a confirmed failure contests look-alike positives: stored tax misroutes no longer immunize "tax"', () => {
  const clean = [...POS, P('A $70 vase is 10% off, then 20% off. What does it cost now?', 70, 0.1, 0.2), P('A $500 TV gets 15% off and then 10% off. Final price?', 500, 0.15, 0.1),
    P('A $20 cap is 50% off, then 10% off. What do I pay?', 20, 0.5, 0.1), P('A $90 rug is 30% off, then another 5% off. What is the price?', 90, 0.3, 0.05)];
  const poisoned = [...clean, P('A $120 bike is 10% off and then 5% sales tax is added. What do I pay?', 120, 0.1, 0.05)];
  const rejected = 'A $150 phone is 20% off and then 5% sales tax is added. What do I pay?';
  assert.ok(!induce(poisoned, [{ task: rejected }], PRICE).spec.contextBlock.words.includes('tax'), 'the poisoned positive blocks the lesson');
  const c = contested(poisoned, rejected);
  assert.deepEqual(c.words, ['added', 'sales', 'tax'], '"off" is common in positives, so it is never contested');
  assert.deepEqual(c.examples.map((e) => e.input.original_price), [120]);
  const kept = poisoned.filter((e) => !c.examples.includes(e));
  assert.ok(induce(kept, [{ task: rejected }], PRICE).spec.contextBlock.words.includes('tax'), 'with the look-alike disputed, the lesson forms');
  assert.deepEqual(contested(clean, 'A $40 coat is 25% off, then 10% off. What is the final price?').examples, [], 'a rejected ordinary task contests nothing');
});

test('verified wording is positional: "off" after the 2nd % is new for a skill that only saw tax there (real Phase 14 misroute)', async () => {
  const { novelWording } = await import('../src/evolve/binder-induction.js');
  const pos = [
    { task: 'A $200 dinner is 20% off, then 8% sales tax is added, and the total is split evenly among 4 friends. How much does each friend pay?' },
    { task: 'A $150 concert package is 10% off, then 6% sales tax is added, and the total is split evenly among 3 friends. How much does each friend pay?' },
  ];
  const discount = 'A $240 cabin rental is 25% off, then another 10% off, and the cost is split evenly among 4 friends. How much does each friend pay?';
  assert.ok(novelWording(pos, discount).includes('off after % #2'));
  assert.deepEqual(novelWording(pos, 'A $120 pizza order is 25% off, then 8% sales tax is added, and the total is split evenly among 3 friends. How much does each friend pay?'), [], 'same wording in the same places: verified');
  assert.deepEqual(novelWording(pos, `Mission goal: ${pos[0].task}\nYour task: Price\n${pos[0].task}`), [], 'occurrences counted in the fullest line, so restated mission goals stay verified');
});
