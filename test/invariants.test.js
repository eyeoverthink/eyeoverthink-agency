// Phase 21: Metamorphic & representation-diverse program judging + Crystallizer auditor fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTaskInvariants, checkProgramInvariants } from '../src/evolve/invariants.js';
import { programVoice, ROLE_PROMPTS } from '../src/evolve/program-voice.js';
import { nearAnswer, extractAnswerNumber } from '../src/evolve/crystallizer.js';
import { runSandboxedJs } from '../src/tools/builtin.js';
import { makeAgency, systemOf } from './helpers.js';

const TRACTOR = 'A tractor drives to a field at 10 mph and back at 15 mph on the same road. What is the average speed for the round trip?';
const PIPES = 'Pipe A fills a tank in 3 hours and pipe B fills it in 6 hours. Working together, how many hours do they take to fill it?';
const DRAIN = 'Pipe A fills a tank in 4 hours, pipe B fills it in 6 hours, and a drain empties it in 12 hours. With all three open, how many hours to fill the tank?';
const DISCOUNT = 'A shirt costs $50. It is discounted by 10%, and then the sale price is discounted by another 10%. What is the final price in dollars?';
const REVERSE_DISCOUNT = 'After a 20% discount, a coat costs $64. What was its original price in dollars?';
const FRUIT = '3 kg of apples cost $2 per kg and 2 kg of pears cost $5 per kg. What is the average price per kg of all the fruit, in dollars?';
const GRADE = 'A student scores 70 on a test worth 40% of the grade and 90 on a test worth 60% of the grade. What is the weighted average score?';
const DILUTION = 'A 20-liter drink is 30% juice. How many liters of water must be added to make it 20% juice?';
const UNEQUAL_TRIP = 'A car travels 150 miles in 2.5 hours, then 90 miles in 1.5 hours. What is its average speed for the whole journey, in mph?';
const FOUR_NUM_TRIP = 'A car drives 60 km at 30 km/h and then another 60 km at 60 km/h. What is its average speed for the whole trip, in km/h?';

test('extractTaskInvariants: classifies families accurately with strict false-positive guards', () => {
  const rt = extractTaskInvariants(TRACTOR);
  assert.equal(rt.family, 'round_trip_average');
  assert.deepEqual(rt.speeds, [10, 15]);
  assert.ok(rt.checks.includes('cauchy_bounds'));
  assert.ok(rt.checks.includes('equal_input_idempotence'));

  assert.notEqual(extractTaskInvariants(UNEQUAL_TRIP).family, 'round_trip_average', 'unequal-leg distance/time journey is not a round trip');

  const fourNum = extractTaskInvariants(FOUR_NUM_TRIP);
  assert.equal(fourNum.family, 'round_trip_average');
  assert.deepEqual(fourNum.speeds, [30, 60]);

  const pw = extractTaskInvariants(PIPES);
  assert.equal(pw.family, 'parallel_work_rate');
  assert.deepEqual(pw.times, [3, 6]);
  assert.ok(pw.checks.includes('faster_than_fastest'));
  assert.ok(pw.checks.includes('equal_worker_halving'));

  assert.notEqual(extractTaskInvariants(DRAIN).family, 'parallel_work_rate', 'drain/empty tasks must not be classified as parallel_work_rate');
  assert.notEqual(extractTaskInvariants('3 workers build a wall in 12 days. Working at the same rate, how many days do 4 workers need?').family, 'parallel_work_rate');

  const disc = extractTaskInvariants(DISCOUNT);
  assert.equal(disc.family, 'sequential_percent');
  assert.equal(disc.basePrice, 50);
  assert.ok(disc.checks.includes('discount_price_bounds'));
  assert.ok(disc.checks.includes('zero_discount_identity'));

  const rev = extractTaskInvariants(REVERSE_DISCOUNT);
  assert.equal(rev.family, 'sequential_percent');
  assert.ok(!rev.checks.includes('discount_price_bounds'), 'original-price-before-discount answer exceeds sale price');
  assert.ok(!rev.checks.includes('zero_discount_identity'));

  const mix = extractTaskInvariants(FRUIT);
  assert.equal(mix.family, 'weighted_average_mixture');
  assert.deepEqual(mix.rates, [2, 5]);
  assert.ok(mix.checks.includes('convex_hull'));

  const grd = extractTaskInvariants(GRADE);
  assert.equal(grd.family, 'weighted_average_mixture');
  assert.deepEqual(grd.rates, [70, 90]);

  assert.notEqual(extractTaskInvariants(DILUTION).family, 'weighted_average_mixture', 'dilution asking for added water is not a convex-hull concentration average');
});

test('checkProgramInvariants: deterministically vetoes Phase 20 1/(1/v1+1/v2) bug, parallel-work t1+t2, constant, and non-deterministic programs', async () => {
  // Phase 20 exact bug: 1/(1/v1 + 1/v2) returns 6 for [10, 15]
  const buggyRt = await checkProgramInvariants(
    'function solve(v1, v2) { return 1 / (1 / v1 + 1 / v2); }',
    [10, 15], TRACTOR, { sandbox: runSandboxedJs },
  );
  assert.equal(buggyRt.ok, false);
  assert.equal(buggyRt.answer, 6);
  assert.ok(buggyRt.checks.some((c) => c.name === 'cauchy_bounds' && !c.pass));
  assert.ok(buggyRt.checks.some((c) => c.name === 'equal_input_idempotence' && !c.pass));
  assert.ok(buggyRt.vetoReason);

  // Even parameterless Phase 20 bug is caught by output-only cauchy_bounds
  const buggyParamless = await checkProgramInvariants(
    'console.log(1 / (1 / 10 + 1 / 15));',
    [], TRACTOR, { sandbox: runSandboxedJs },
  );
  assert.equal(buggyParamless.ok, false);
  assert.equal(buggyParamless.answer, 6);
  assert.match(buggyParamless.vetoReason, /cauchy_bounds/);

  // Non-symmetric bug fails symmetry; shifted bug fails scale_homogeneity
  const asym = await checkProgramInvariants('function solve(v1, v2) { return (2 * v1 + v2) / 3; }', [10, 15], TRACTOR, { sandbox: runSandboxedJs });
  assert.equal(asym.ok, false);
  assert.ok(asym.checks.some((c) => c.name === 'symmetry' && !c.pass));

  const shifted = await checkProgramInvariants('function solve(v1, v2) { return 2 * v1 * v2 / (v1 + v2) + 1; }', [10, 15], TRACTOR, { sandbox: runSandboxedJs });
  assert.equal(shifted.ok, false);
  assert.ok(shifted.checks.some((c) => c.name === 'scale_homogeneity' && !c.pass));

  // Valid first-principles simulation passes every check
  const goodRt = await checkProgramInvariants(
    'function solve(v1, v2) { const d = 100; return (2 * d) / (d / v1 + d / v2); }',
    [10, 15], TRACTOR, { sandbox: runSandboxedJs },
  );
  assert.equal(goodRt.ok, true, JSON.stringify(goodRt));
  assert.equal(goodRt.answer, 12);
  assert.equal(goodRt.vetoReason, null);

  // Valid 4-param equal-distance trip (60 km at 30 km/h, 60 km at 60 km/h) must NOT suffer false positive from arg permutation
  const goodFour = await checkProgramInvariants(
    'function solve(d1, v1, d2, v2) { return (d1 + d2) / (d1 / v1 + d2 / v2); }',
    [60, 30, 60, 60], FOUR_NUM_TRIP, { sandbox: runSandboxedJs },
  );
  assert.equal(goodFour.ok, true, JSON.stringify(goodFour));
  assert.equal(goodFour.answer, 40);

  // Parallel work rate: t1 + t2 vetoed, valid 1/(1/t1+1/t2) passes
  const buggyPw = await checkProgramInvariants('function solve(a, b) { return a + b; }', [3, 6], PIPES, { sandbox: runSandboxedJs });
  assert.equal(buggyPw.ok, false);
  assert.ok(buggyPw.checks.some((c) => c.name === 'faster_than_fastest' && !c.pass));
  assert.ok(buggyPw.checks.some((c) => c.name === 'equal_worker_halving' && !c.pass));

  const goodPw = await checkProgramInvariants('function solve(a, b) { return 1 / (1 / a + 1 / b); }', [3, 6], PIPES, { sandbox: runSandboxedJs });
  assert.equal(goodPw.ok, true, JSON.stringify(goodPw));
  assert.equal(goodPw.answer, 2);

  // Drain task valid solution (3 hours) is NOT falsely vetoed
  const goodDrain = await checkProgramInvariants('function solve(a, b, d) { return 1 / (1 / a + 1 / b - 1 / d); }', [4, 6, 12], DRAIN, { sandbox: runSandboxedJs });
  assert.equal(goodDrain.ok, true, JSON.stringify(goodDrain));
  assert.equal(goodDrain.answer, 3);

  // Sequential discount: valid passes, buggy price * d1/100 * d2/100 fails zero_discount_identity
  const goodDisc = await checkProgramInvariants('function solve(p, d1, d2) { return p * (1 - d1 / 100) * (1 - d2 / 100); }', [50, 10, 10], DISCOUNT, { sandbox: runSandboxedJs });
  assert.equal(goodDisc.ok, true, JSON.stringify(goodDisc));
  assert.equal(goodDisc.answer, 40.5);

  const badDisc = await checkProgramInvariants('function solve(p, d1, d2) { return p * (d1 / 100) * (d2 / 100); }', [50, 10, 10], DISCOUNT, { sandbox: runSandboxedJs });
  assert.equal(badDisc.ok, false);
  assert.ok(badDisc.checks.some((c) => c.name === 'zero_discount_identity' && !c.pass));

  // Reverse discount valid answer 80 (> $64) passes cleanly
  const goodRev = await checkProgramInvariants('function solve(d, sale) { return sale / (1 - d / 100); }', [20, 64], REVERSE_DISCOUNT, { sandbox: runSandboxedJs });
  assert.equal(goodRev.ok, true, JSON.stringify(goodRev));
  assert.equal(goodRev.answer, 80);

  // Mixture convex hull: valid 3.2 passes, out-of-hull 7 vetoed
  const goodMix = await checkProgramInvariants('function solve(w1, p1, w2, p2) { return (w1 * p1 + w2 * p2) / (w1 + w2); }', [3, 2, 2, 5], FRUIT, { sandbox: runSandboxedJs });
  assert.equal(goodMix.ok, true, JSON.stringify(goodMix));
  assert.equal(goodMix.answer, 3.2);

  const badMix = await checkProgramInvariants('function solve(w1, p1, w2, p2) { return p1 + p2; }', [3, 2, 2, 5], FRUIT, { sandbox: runSandboxedJs });
  assert.equal(badMix.ok, false);
  assert.ok(badMix.checks.some((c) => c.name === 'convex_hull' && !c.pass));

  // Hard-coded constant function vetoed by non_constant_sensitivity
  const constantFn = await checkProgramInvariants('function solve(a, b) { return 42; }', [8, 3], 'How many different groups of 3 people can be chosen from 8 people?', { sandbox: runSandboxedJs });
  assert.equal(constantFn.ok, false);
  assert.ok(constantFn.checks.some((c) => c.name === 'non_constant_sensitivity' && !c.pass));

  // Non-deterministic function vetoed by deterministic
  const randFn = await checkProgramInvariants('function solve(a, b) { return a + b + Math.random(); }', [8, 3], 'What is 8 plus 3?', { sandbox: runSandboxedJs });
  assert.equal(randFn.ok, false);
  assert.ok(randFn.checks.some((c) => c.name === 'deterministic' && !c.pass));
});

test('programVoice: representation-diverse ROLE_PROMPTS, vetoed-pair fallback to 3rd program, correlated-bug silence, distinct-model enforcement, and ledgering', async () => {
  // 3 distinct role prompts all keep the expected quantitative-question prefix
  for (const role of ['code', 'reason', 'plan']) {
    assert.match(ROLE_PROMPTS[role], /You compute the answer to a quantitative question/);
  }
  assert.notEqual(ROLE_PROMPTS.code, ROLE_PROMPTS.reason);
  assert.notEqual(ROLE_PROMPTS.reason, ROLE_PROMPTS.plan);
  assert.notEqual(ROLE_PROMPTS.code, ROLE_PROMPTS.plan);

  const routerWith = (map) => ({
    chat: async ({ role }) => {
      const entry = map[role];
      return { model: entry?.model ?? `m-${role}`, text: JSON.stringify(entry?.body ?? entry ?? { program: '' }) };
    },
  });

  // Correlated bug: BOTH code & reason return 1/(1/v1+1/v2) = 6 -> BOTH vetoed; plan also wrong -> answer is null (never 6!)
  const bothWrong = await programVoice(TRACTOR, {
    router: routerWith({
      code: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return 1 / (1 / a + 1 / b); }' },
      reason: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return (a * b) / (a + b); }' },
      plan: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { const d = 100; return (2 * d) / (d / a + d / b); }' },
    }),
    sandbox: runSandboxedJs,
  });
  assert.equal(bothWrong.answer, null, 'only 1 valid non-vetoed vote: never guesses');
  assert.equal(bothWrong.vetoes.length, 2);
  assert.equal(bothWrong.family, 'round_trip_average');

  // Vetoed-pair fallback: code vetoed (6), reason passes (12), plan passes (12) -> 2 of 3 agree on 12!
  const rescued = await programVoice(TRACTOR, {
    router: routerWith({
      code: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return 1 / (1 / a + 1 / b); }' },
      reason: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return (2 * a * b) / (a + b); }' },
      plan: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { const d = 100; return (2 * d) / (d / a + d / b); }' },
    }),
    sandbox: runSandboxedJs,
  });
  assert.equal(rescued.answer, 12);
  assert.equal(rescued.verdict, 'two of 3 programs agree');
  assert.equal(rescued.vetoes.length, 1);
  assert.equal(rescued.votes[0].vetoed, true);

  // Distinct-model enforcement: two votes from the SAME model cannot form an agreeing pair
  const sameModelAll = await programVoice(TRACTOR, {
    router: routerWith({
      code: { model: 'qwen2.5-coder:7b', body: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return (2 * a * b) / (a + b); }' } },
      reason: { model: 'qwen2.5-coder:7b', body: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { const d = 100; return (2 * d) / (d / a + d / b); }' } },
      plan: { model: 'qwen2.5-coder:7b', body: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return 2 / (1 / a + 1 / b); }' } },
    }),
    sandbox: runSandboxedJs,
  });
  assert.equal(sameModelAll.answer, null, 'same model cannot self-corroborate');

  // Same model on code+reason, distinct model on plan -> succeeds 2 of 3!
  const distinctThird = await programVoice(TRACTOR, {
    router: routerWith({
      code: { model: 'qwen2.5-coder:7b', body: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return (2 * a * b) / (a + b); }' } },
      reason: { model: 'qwen2.5-coder:7b', body: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { const d = 100; return (2 * d) / (d / a + d / b); }' } },
      plan: { model: 'hermes3:8b', body: { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return 2 / (1 / a + 1 / b); }' } },
    }),
    sandbox: runSandboxedJs,
  });
  assert.equal(distinctThird.answer, 12);

  // Grounding check on params: comma-formatted $1,200 and decimal 0.2 for 20% pass; invented 999 rejected
  const commaTask = 'A $1,200 laptop is discounted by 20%. What is the final price?';
  const groundedOk = await programVoice(commaTask, {
    router: routerWith({
      code: { ambiguous: false, params: [1200, 0.2], program: 'function solve(price, rate) { return price * (1 - rate); }' },
      reason: { ambiguous: false, params: [1200, 20], program: 'function solve(price, pct) { return price * (1 - pct / 100); }' },
    }),
    sandbox: runSandboxedJs,
  });
  assert.equal(groundedOk.answer, 960);

  const ungrounded = await programVoice(commaTask, {
    router: routerWith({
      code: { ambiguous: false, params: [1200, 999], program: 'function solve(price, x) { return price - x; }' },
      reason: { ambiguous: false, params: [1200, 999], program: 'function solve(price, x) { return price - x; }' },
      plan: { ambiguous: false, params: [1200, 999], program: 'function solve(price, x) { return price - x; }' },
    }),
    sandbox: runSandboxedJs,
  });
  assert.equal(ungrounded.answer, null);
  assert.equal(ungrounded.votes[0].error, 'ungrounded params');

  // Agency.programAnswer logs program.veto and judge.program.vetoes without leaking task text
  const A = await makeAgency((req) => {
    const sys = systemOf(req);
    if (/You compute the answer to a quantitative question/.test(sys)) {
      if (req.role === 'code') return { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { return 1 / (1 / a + 1 / b); }' };
      return { ambiguous: false, params: [10, 15], program: 'function solve(a, b) { const d = 100; return (2 * d) / (d / a + d / b); }' };
    }
    return { final: 'FINAL 12' };
  });
  try {
    const out = await A.agency.programAnswer(TRACTOR);
    assert.equal(out, 'FINAL 12');
    const vetoEntry = A.agency.ledger.list({ limit: 5, kind: 'program.veto' })[0];
    assert.ok(vetoEntry, 'program.veto entry ledgered');
    assert.equal(vetoEntry.data.role, 'code');
    assert.ok(!JSON.stringify(vetoEntry.data).includes('tractor'), 'task text never ledgered');
    const progEntry = A.agency.ledger.list({ limit: 1, kind: 'judge.program' })[0].data;
    assert.equal(progEntry.answer, 12);
    assert.equal(progEntry.vetoes.length, 1);
    assert.ok(!JSON.stringify(progEntry).includes('tractor'), 'task text never ledgered');
  } finally { await A.cleanup(); }
});

test('crystallizer auditor fixes: nearAnswer, extractAnswerNumber, #voices 4th voice, and correctAnswer extra + pctTask', async () => {
  // 1. nearAnswer: small numbers must NOT falsely match under dec === 0 rounding
  assert.equal(nearAnswer(0.6, 1), false);
  assert.equal(nearAnswer(0.4, 0), false);
  assert.equal(nearAnswer(0.55, 0.6), false);
  assert.equal(nearAnswer(51.3, 51), true);
  assert.equal(nearAnswer(23.85, 24), true);
  assert.equal(nearAnswer(110.1600001, 110.16), true);

  // 2. extractAnswerNumber: explicit FINAL / **Answer:** markers bypass inTask filtering
  const TASK_WITH_10 = 'A $10 item is 50% off, then doubled. What is the final price?';
  assert.equal(extractAnswerNumber('FINAL 10', TASK_WITH_10), '10');
  assert.equal(extractAnswerNumber('Working: 10 * 0.5 * 2 = 10.\nFINAL: $10', TASK_WITH_10), '10');
  assert.equal(extractAnswerNumber('**Answer: 10**\n\nChecked.', TASK_WITH_10), '10');
  assert.equal(extractAnswerNumber('Start from 10 and get 25.', 'Start from 10. What do you get?'), '25');
  assert.equal(extractAnswerNumber('Only repeats 10.', 'Start from 10. What do you get?'), undefined);

  // 3. #voices() keeps 4th+ local voice before removing firstId; judge can reach all 3 remaining local voices
  const A = await makeAgency(() => ({ final: 'ok' }));
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => false };
    A.agency.store.kvSet('judge:study', {
      items: 20,
      voices: ['forge_keeper', 'program', 'tycho', 'lumen'],
      accuracy: { forge_keeper: 0.95, program: 0.85, tycho: 0.70, lumen: 0.60 },
    });
    const asked = [];
    const replies = { program: 'FINAL 11', tycho: 'FINAL 13', lumen: 'FINAL 10' };
    cz.agentAnswer = async (t, id) => { asked.push(id); return replies[id]; };
    // First answer is forge_keeper (wrong: 99); skillOut is 10 (which ALSO appears in task!);
    // program (11) and tycho (13) split, so the 4th local voice (lumen: FINAL 10) MUST be asked and side with the skill!
    const j = await cz.judge(TASK_WITH_10, 10, 'FINAL 99', 'forge_keeper');
    assert.deepEqual(asked, ['program', 'tycho', 'lumen'], '4th local voice lumen was not sliced away before removing firstId');
    assert.equal(j.agree, true, 'lumen sided with skillOut 10 even though 10 appears in the task');
    assert.equal(j.extra.length, 1);
    assert.equal(j.extra[0].by, 'lumen');

    // 4. correctAnswer honors v.extra AND pctTask fraction/percent equivalence
    const corrExtra = cz.correctAnswer({ ...j, skill: 'price_calc' }, 'first said 99');
    assert.ok(corrExtra, 'correctAnswer honors v.extra voice');
    assert.match(corrExtra, /\*\*Answer: 10\*\*/);
    assert.match(corrExtra, /lumen \(10\) agreed/);

    const corrPct = cz.correctAnswer(
      { agree: true, skillOut: 0.675, agentAnswer: 0.54, second: 67.5, secondBy: 'program', skill: 'remaining_fraction', pctTask: true },
      'first said 0.54',
    );
    assert.ok(corrPct, 'correctAnswer honors pctTask 0.675 vs 67.5 equivalence');
    assert.match(corrPct, /\*\*Answer: 0\.675\*\*/);
    assert.match(corrPct, /67\.5/);
  } finally { await A.cleanup(); }
});
