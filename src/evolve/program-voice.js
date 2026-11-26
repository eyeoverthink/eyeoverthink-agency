// Program-verified judge voice (Phase 20 + Phase 21 metamorphic & representation-diverse judging).
//
// The judge's other voices are agents: they reason in prose, and on hard arithmetic they can all be wrong (Phase 12).
// A single program is not proof (Phase 8: 5 of 6 ran cleanly and answered the wrong question). And two correlated
// programs are STILL not proof (Phase 20: two models wrote the same broken `1/(1/v1+1/v2)` formula and agreed on 6
// instead of 12). So this voice combines:
//   - representation-diverse role prompts ('code' concrete simulation, 'reason' algebraic derivation, 'plan' dimensional
//     unit decomposition) asking for a parameterized `function solve(...params)` with grounded `params`;
//   - metamorphic & domain invariants (`checkProgramInvariants`) executed in ONE batched sandbox call BEFORE voting,
//     vetoing formula bugs, constant functions, and out-of-bounds outputs;
//   - distinct-model enforcement: two votes from the same model cannot self-corroborate;
//   - 2-of-3 voting over surviving valid votes (never guessing).
// Everything runs locally; no task text leaves the machine.
import { extractTaskInvariants, checkProgramInvariants, hasSolveFn } from './invariants.js';

/** Two numbers agree: within a relative 1e-6, or equal when rounded to the coarser one's decimals (46.67 vs 46.6667). */
export function programsAgree(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-6)) return true;
  const dec = Math.min((String(a).split('.')[1] || '').length, (String(b).split('.')[1] || '').length);
  return dec >= 2 && dec <= 4 && Number(x.toFixed(dec)) === Number(y.toFixed(dec)); // 1 decimal is too loose: 0.55 would "agree" with 0.6
}

const JSON_RULES = 'Return JSON only with "ambiguous" (boolean), "params" (array of the exact numbers copied from the question in the order solve takes them), and "program" (a JavaScript `function solve(...) { ... return ans; }` returning ONLY the single finite numeric answer at full precision, no units, no comments, standard JS built-ins only; return a percent as a percent number like 25 for 25% unless a decimal or fraction is requested). Set "ambiguous": true if more than one reasonable answer exists.';

// Three representation-diverse role prompts (Phase 21) to break correlated formula mistakes across models.
// Note: each begins with "You compute the answer to a quantitative question." (matched by existing tests).
export const ROLE_PROMPTS = {
  code: `You compute the answer to a quantitative question. Use FIRST-PRINCIPLES CONCRETE SIMULATION: simulate the actual quantities step by step instead of relying on memorized shortcut formulas. For round-trip or equal-leg speed problems, explicitly choose a concrete leg distance such as const legDist = 100; const totalDist = 2 * legDist; compute the time for each leg (legDist / v1 and legDist / v2), and divide totalDist by totalTime. For work-rate problems, compute each worker's fraction of 1 job per unit time and sum rates. ${JSON_RULES} Example: {"ambiguous": false, "params": [10, 15], "program": "function solve(v1, v2) { const legDist = 100; const totalDist = 2 * legDist; const totalTime = legDist / v1 + legDist / v2; return totalDist / totalTime; }"}`,
  reason: `You compute the answer to a quantitative question. Use EXPLICIT ALGEBRAIC DERIVATION FROM DEFINITIONS: derive the governing equation from first definitions (average speed = totalDistance / totalTime; combinedRate = 1/t1 + 1/t2 so totalTime = 1/combinedRate; sequential percent changes multiply factors) using clear variable names that match the physical units. ${JSON_RULES} Example: {"ambiguous": false, "params": [120, 20], "program": "function solve(priceDollars, discountPct) { const remainingFactor = 1 - discountPct / 100; return priceDollars * remainingFactor; }"}`,
  plan: `You compute the answer to a quantitative question. Use DIMENSIONAL AND UNIT-DECOMPOSITION FORMULATION: write explicit intermediate variables for each unit-bearing rate or quantity (such as ratePerHour, hoursPerLeg, costPerKg, priceAfterStep1), check that units cancel to the requested output unit, and return the final numeric value. ${JSON_RULES} Example: {"ambiguous": false, "params": [3, 6], "program": "function solve(hoursA, hoursB) { const rateA = 1 / hoursA; const rateB = 1 / hoursB; const combinedRatePerHour = rateA + rateB; return 1 / combinedRatePerHour; }"}`,
};

const FALLBACK_SYSTEM = ROLE_PROMPTS.code;

/** Strip wrappers models put around code: <JavaScript> tags, markdown fences, a leading "javascript" label. */
export function normalizeProgram(p) {
  return String(p ?? '').trim()
    .replace(/^<\/?(?:javascript|js|code)>\s*/i, '').replace(/\s*<\/(?:javascript|js|code)>$/i, '')
    .replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```$/, '')
    .replace(/^(?:javascript|js)\s*\n/i, '').trim();
}

const WORD_NUMS = Object.assign(Object.create(null), {
  zero: 0, one: 1, two: 2, twice: 2, double: 2, doubles: 2, three: 3, triple: 3, triples: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, half: 0.5, quarter: 0.25,
});

/** Verify each numeric parameter appears in the task (directly, as a number word, or as exact percent/decimal of a percent token). */
export function paramsGrounded(params, task) {
  if (!Array.isArray(params) || !params.length || params.length > 24) return false;
  const clean = String(task ?? '').replace(/(?<=\d),(?=\d{3}\b)/g, '');
  const taskNums = (clean.match(/(?<![\w.])-?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  const pctNums = [...clean.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
  for (const w of clean.toLowerCase().match(/\b[a-z]+\b/g) || []) {
    if (Object.hasOwn(WORD_NUMS, w)) taskNums.push(WORD_NUMS[w]);
  }
  if (!taskNums.length) return false;
  const approx = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
  return params.every((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    return taskNums.some((n) => approx(v, n))
      || pctNums.some((p) => approx(v * 100, p) || approx(v / 100, p));
  });
}

/** One independent program for the task, by one model role. Runs invariants before returning a vote. */
async function writeAndRun(task, role, { router, sandbox, signal, invariants, ledger, taskSha256 }) {
  let res;
  try {
    res = await router.chat({
      role, privacy: 'private', json: true, temperature: 0.1, maxTokens: 900, signal,
      messages: [
        { role: 'system', content: ROLE_PROMPTS[role] || FALLBACK_SYSTEM },
        { role: 'user', content: `Question: ${String(task).slice(0, 3000)}` },
      ],
    });
  } catch { return { role, error: 'model unavailable' }; }
  let p = {};
  try { p = JSON.parse(String(res.text).match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return { role, model: res.model, provider: res.provider, error: 'no JSON' }; }
  if (p.ambiguous === true) return { role, model: res.model, provider: res.provider, error: 'ambiguous' };
  const program = normalizeProgram(p.program);
  if (!program) return { role, model: res.model, provider: res.provider, error: 'no program' };

  const rawParams = Array.isArray(p.params) ? p.params.map((x) => (typeof x === 'number' ? x : typeof x === 'string' && /^-?\d+(?:\.\d+)?$/.test(x.trim()) ? Number(x.trim()) : NaN)) : [];
  const wantsParameterized = hasSolveFn(program) && rawParams.length > 0;
  let useParams = [];
  let parameterized = false;

  if (wantsParameterized) {
    if (rawParams.every(Number.isFinite) && paramsGrounded(rawParams, task)) {
      useParams = rawParams;
      parameterized = true;
    } else if (/\bconsole\.log\s*\(/.test(program)) {
      // Fall back cleanly to parameterless execution if the script also prints its answer directly.
      useParams = [];
      parameterized = false;
    } else {
      return { role, model: res.model, provider: res.provider, error: 'ungrounded params' };
    }
  }

  const check = await checkProgramInvariants(program, useParams, task, { sandbox, timeoutMs: 5000, invariants });
  if (check.error) {
    return { role, model: res.model, provider: res.provider, parameterized, error: check.error };
  }
  if (!check.ok) {
    const failed = check.checks.find((c) => !c.pass);
    if (ledger) {
      ledger.append('program.veto', {
        role,
        model: res.model || null,
        invariant: failed?.name || 'unknown',
        detail: failed?.detail || check.vetoReason || '',
        taskSha256: taskSha256 || null,
      }, 'program-voice');
    }
    return {
      role,
      model: res.model,
      provider: res.provider,
      answer: check.answer,
      parameterized,
      vetoed: true,
      vetoReason: check.vetoReason,
      checks: check.checks,
    };
  }

  return {
    role,
    model: res.model,
    provider: res.provider,
    answer: check.answer,
    parameterized,
    vetoed: false,
    checks: check.checks,
  };
}

/**
 * The program voice's answer for a task: { answer, verdict, votes, vetoes, family }.
 * answer is null unless at least two independent, distinct-model, invariant-passing programs agree.
 */
export async function programVoice(task, {
  router,
  sandbox,
  roles = ['code', 'reason', 'plan'],
  signal,
  ledger = null,
  taskSha256 = null,
  enforceDistinctModels = true,
} = {}) {
  const invariants = extractTaskInvariants(task);
  const votes = [];
  const runOpts = { router, sandbox, signal, invariants, ledger, taskSha256 };

  for (const role of roles.slice(0, 2)) votes.push(await writeAndRun(task, role, runOpts));

  const ok = () => votes.filter((v) => v.answer != null && !v.vetoed);
  const vetoesOf = () => votes
    .filter((v) => v.vetoed)
    .map((v) => ({ role: v.role, model: v.model || null, answer: v.answer, vetoReason: v.vetoReason, checks: v.checks }));

  const sameModel = (a, b) => {
    if (enforceDistinctModels === false) return false;
    if (a.provider === 'scripted' && b.provider === 'scripted') return false;
    return Boolean(a.model && b.model && a.model === b.model);
  };

  let sameModelBlocked = false;
  const pair = () => {
    const o = ok();
    for (let i = 0; i < o.length; i++) {
      for (let j = i + 1; j < o.length; j++) {
        if (!programsAgree(o[i].answer, o[j].answer)) continue;
        if (sameModel(o[i], o[j])) { sameModelBlocked = true; continue; }
        return o[i];
      }
    }
    return null;
  };

  let hit = pair();
  if (hit) return { answer: hit.answer, verdict: 'two programs agree', votes, vetoes: vetoesOf(), family: invariants.family };

  if (roles[2]) {
    votes.push(await writeAndRun(task, roles[2], runOpts));
    hit = pair();
  }
  if (hit) return { answer: hit.answer, verdict: `two of ${votes.length} programs agree`, votes, vetoes: vetoesOf(), family: invariants.family };

  const vetoes = vetoesOf();
  const verdict = sameModelBlocked
    ? 'same model cannot self-corroborate'
    : ok().length
      ? 'programs disagree'
      : vetoes.length
        ? 'all candidate programs vetoed'
        : 'no program produced one number';
  return { answer: null, verdict, votes, vetoes, family: invariants.family };
}
