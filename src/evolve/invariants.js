// Metamorphic & domain invariants for program-verified judging (Phase 21).
//
// In Phase 20, two independent local models wrote the SAME broken harmonic-mean formula `1 / (1/v1 + 1/v2)` on
// round-trip speed problems (missing the factor of 2) and agreed on the wrong answer (6 instead of 12, 30 instead of
// 60, 4.2 instead of 8.4). Agreement between correlated models is not proof.
//
// Metamorphic invariants test structural mathematical properties that any valid solution MUST satisfy, in ONE batched
// sandbox execution (~40 ms, 0 GPU calls), double-isolated via `node --permission` + `vm.runInNewContext` with an
// unforgeable per-call random output marker nonce:
//   - round_trip_average      : Cauchy bounds, equal-input idempotence (kills 1/(1/v1+1/v2)), symmetry, scale homogeneity
//   - parallel_work_rate      : faster-than-fastest bound, equal-worker halving, symmetry (strictly guarded against drains)
//   - sequential_percent      : non-negativity, discount price bounds & zero-discount identity (discount-only final prices)
//   - weighted_average_mixture: convex-hull bounds over identifiable same-unit rates
//   - general_numeric         : determinism & non-constant sensitivity (kills hard-coded constant functions)
//
// False-positive discipline: NEVER veto valid programs. Domain-specific metamorphic probes only fire when parameter
// roles are unambiguous; otherwise we fall back cleanly to safe output bounds + general_numeric.
import crypto from 'node:crypto';
import { numberTokens } from './binder-induction.js';
import { answerKey } from './examiner.js';
import { runSandboxedJs } from '../tools/builtin.js';

const SPEED_UNIT = /^(?:mph|km\/h|kph|knots?|m\/s|ft\/s|mi\/h|km\/hr|mi\/hr)$/i;
const MAX_PARAMS = 24;

function stripCommas(text) {
  return String(text ?? '').replace(/(?<=\d),(?=\d{3}\b)/g, '');
}

function normSpeedUnit(u) {
  if (!u || !SPEED_UNIT.test(u)) return null;
  const s = u.toLowerCase();
  if (s === 'kph' || s === 'km/hr') return 'km/h';
  if (s === 'mi/h' || s === 'mi/hr') return 'mph';
  if (s === 'knot') return 'knots';
  return s;
}

function timeUnitFamily(u) {
  if (!u) return null;
  if (/^(?:hours?|hrs?|h)$/i.test(u)) return 'hour';
  if (/^(?:minutes?|mins?|min)$/i.test(u)) return 'minute';
  if (/^(?:days?|d)$/i.test(u)) return 'day';
  if (/^(?:seconds?|secs?|sec|s)$/i.test(u)) return 'second';
  return null;
}

export function hasSolveFn(program) {
  return /\bfunction\s+solve\s*\(|\b(?:const|let|var)\s+solve\s*=/.test(String(program ?? ''));
}

function relClose(a, b, rel = 1e-4, abs = 1e-6) {
  return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= Math.max(abs, Math.max(Math.abs(a), Math.abs(b)) * rel);
}

function sameMultiset(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => Math.abs(v - sb[i]) <= Math.max(1e-9, Math.abs(v) * 1e-9));
}

/**
 * Classify a task's wording and grounded numeric parameters into an applicable invariant family.
 * Returns { family, checks, speeds?, times?, basePrice?, discounts?, rates?, rateUnit? }.
 */
export function extractTaskInvariants(task) {
  const text = stripCommas(task);
  const toks = numberTokens(text);
  const currToks = toks.filter((t) => t.kind === 'currency');
  const pctToks = toks.filter((t) => t.kind === 'percent');
  const plainToks = toks.filter((t) => t.kind === 'plain');

  // 1. Round-trip / equal-distance average speed
  const asksAvgSpeed = /\b(average\s+speed|mean\s+speed)\b/i.test(text) || (/\bround\s*trip\b/i.test(text) && /\bspeed\b/i.test(text));
  const distToks = plainToks.filter((t) => t.v > 0 && /^(?:km|mi|miles?|m|meters?|metres?)$/i.test(t.unit || ''));
  const equalDistPair = distToks.length === 2 && Math.abs(distToks[0].v - distToks[1].v) < 1e-9;
  const equalLegWording = /\b(round\s*trip|same\s+(?:trail|route|road|path|distance|stretch|way|track|course)|there\s+and\s+back|out\s+and\s+back|back\s+(?:down|along|at|by|on)|returns?\s+(?:along|at|on|by|downstream|upstream|home|back)|comes?\s+back|trots?\s+back|flies?\s+back|drives?\s+back|walks?\s+back|rides?\s+back|paddles?\s+back)\b/i.test(text)
    || equalDistPair;
  const hasExplicitDuration = /\b(?:for|in|a|an)\s+\d+(?:\.\d+)?[-\s]*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i.test(text);
  // Guard against boat+current/wind and mid-trip rests/breaks/stops (red-team P21-3).
  const currentOrStopGuard = /\b(current|stream|river\s+speed|still[-\s]*water|wind|headwind|tailwind|break|rest|stop|stops|stopped|pause|delay|waits?|waiting)\b/i.test(text);

  if (asksAvgSpeed && equalLegWording && !hasExplicitDuration && !currentOrStopGuard) {
    const speedToks = plainToks.filter((t) => t.v > 0 && normSpeedUnit(t.unit));
    let speeds = null;
    let inUnit = null;
    if (speedToks.length === 2 && normSpeedUnit(speedToks[0].unit) === normSpeedUnit(speedToks[1].unit)) {
      speeds = [speedToks[0].v, speedToks[1].v];
      inUnit = normSpeedUnit(speedToks[0].unit);
    } else if (toks.length === 2 && plainToks.length === 2 && plainToks.every((t) => t.v > 0)) {
      speeds = [plainToks[0].v, plainToks[1].v];
    }
    // Guard against output speed unit conversion (e.g. km/h inputs asked in m/s).
    const qSpeedMatch = text.match(/\bin\s+(mph|km\/h|kph|knots?|m\/s|ft\/s|mi\/h|km\/hr|mi\/hr)\b/i);
    const qSpeedUnit = qSpeedMatch ? normSpeedUnit(qSpeedMatch[1]) : null;
    const speedUnitMismatch = inUnit && qSpeedUnit && qSpeedUnit !== inUnit;
    if (speeds && !speedUnitMismatch) {
      return {
        family: 'round_trip_average',
        speeds,
        checks: ['cauchy_bounds', 'equal_input_idempotence', 'symmetry', 'scale_homogeneity', 'deterministic', 'non_constant_sensitivity'],
      };
    }
  }

  // 2. Parallel work rate (strictly guarded against drains, leaks, subtractive flows, job multipliers, and N-vs-M workers)
  const togetherWording = /\b(working\s+together|together|both\s+(?:pipes?|pumps?|printers?|machines?|workers?|open|running)|at\s+the\s+same\s+time)\b/i.test(text);
  const workContext = /\b(fills?|paints?|prints?|cleans?|finishes?|completes?|builds?|mows?|packs?|types?|digs?|job|tank|pool|batch|fence|house|wall|pipe|printer|machine|pump|worker)\b/i.test(text);
  const drainOrDelayGuard = /\b(drain|drains|draining|leak|leaks|leaking|empties|empty|emptying|outlet|remove|removes|subtract|minus|loses?|against|oppos|later|alone|head\s+start|stops?|leaves?|breaks?\s+down|turns?\s+off|fraction|percent|percentage|how\s+much\s+of|what\s+part)\b/i.test(text);
  const workerCountGuard = /\b\d+\s+(?:workers?|people|men|women|machines?|painters?|builders?|printers?|pipes?)\b/i.test(text);
  const multiJobGuard = /\b(?:two|three|four|five|six|twice|half|double|triple)\s+(?:tanks?|jobs?|pools?|houses?|walls?|fences?|batches?|rooms?)\b|\bper\s+(?:hour|minute|day|second)\b/i.test(text);
  const asksTime = /\b(how\s+long|how\s+many\s+(?:hours?|hrs?|minutes?|mins?|days?|seconds?|secs?)|time\s+(?:to|needed|taken|does|will))\b/i.test(text);

  if (togetherWording && workContext && asksTime && !drainOrDelayGuard && !workerCountGuard && !multiJobGuard) {
    const timeToks = plainToks.filter((t) => t.v > 0 && timeUnitFamily(t.unit));
    const families = [...new Set(timeToks.map((t) => timeUnitFamily(t.unit)))];
    const qUnitMatch = text.match(/how\s+many\s+(hours?|hrs?|minutes?|mins?|days?|seconds?|secs?)\b/i);
    const qFamily = qUnitMatch ? timeUnitFamily(qUnitMatch[1]) : null;
    const unitMismatch = qFamily && families.length === 1 && qFamily !== families[0];
    if (timeToks.length >= 2 && families.length === 1 && !unitMismatch && toks.length === timeToks.length) {
      const times = timeToks.map((t) => t.v);
      const checks = ['faster_than_fastest'];
      if (times.length === 2) checks.push('equal_worker_halving', 'symmetry');
      checks.push('deterministic', 'non_constant_sensitivity');
      return { family: 'parallel_work_rate', times, checks };
    }
  }

  // 3. Weighted average / mixture (checked before sequential_percent because weighted grades use % weights)
  const mixWording = /\b(weighted\s+average|average\s+price\s+per|average\s+cost\s+per|final\s+grade|course\s+grade|blended|mixture|concentration|combined\s+average)\b/i.test(text);
  const mixExclude = /\b(how\s+many\s+(?:liters?|litres?|ml|grams?|kg|gallons?|ounces?|pounds?|cups?)|what\s+(?:volume|amount|mass|weight|quantity)\s+of|must\s+be\s+added|to\s+add|removed|total\s+(?:cost|price|value|weight))\b/i.test(text);

  if (mixWording && !mixExclude) {
    let rates = null;
    let rateUnit = null;
    const hasUnitPriceCue = /\$\s*\d+(?:\.\d+)?\s*(?:per\b|each\b|\/(?:kg|lb|pound|l|liter|litre|g|gram|oz|ounce|gallon|unit|item)\b|a\s+(?:kg|lb|pound|liter|litre|gallon|ounce|gram|unit|item)\b)/i.test(text);
    const hasBatchTotalCue = /\$\s*\d+(?:\.\d+)?\s+total\b|\btotal\s+of\s+\$/i.test(text);
    const asksPctConc = /\b(concentration|percent|percentage|strength|ratio|grade|score)\b/i.test(text.split(/[.?]/).slice(-2).join(' '));
    if (currToks.length >= 2 && /\b(price|cost)\b/i.test(text) && hasUnitPriceCue && !hasBatchTotalCue) {
      rates = currToks.map((t) => t.v);
      rateUnit = 'currency';
    } else if (pctToks.length >= 2 && plainToks.length === pctToks.length &&
      Math.abs(pctToks.reduce((s, t) => s + t.v, 0) - 100) < 1e-6 &&
      /\b(grade|score|test|exam|homework|quiz|course)\b/i.test(text)) {
      rates = plainToks.map((t) => t.v);
      rateUnit = 'score';
    } else if (pctToks.length >= 2 && asksPctConc && /\b(concentration|percent|percentage|mixture|solution|blend|blended|acid|salt|alcohol|juice|milk|fat)\b/i.test(text)) {
      rates = pctToks.map((t) => t.v);
      rateUnit = 'percent';
    }
    if (rates && rates.length >= 2) {
      return {
        family: 'weighted_average_mixture',
        rates,
        rateUnit,
        checks: ['convex_hull', 'deterministic', 'non_constant_sensitivity'],
      };
    }
  }

  // 4. Sequential percentage (discount / tax / tip / increase)
  const pctWording = /\b(discount(?:ed|s)?|off|marked\s+down|reduced\s+by|cut\s+by|coupon|tax|tip|gratuity|increase|increased|rise|rises|rose|markup|surcharge|sale\s+price)\b/i.test(text);
  if (pctToks.length >= 1 && pctWording) {
    const checks = [];
    const signedGuard = /\b(net\s+change|change|delta|difference|temperature|below\s+zero|profit\s+or\s+loss|gain\s+or\s+loss|signed)\b/i.test(text);
    if (!signedGuard) checks.push('non_negative');

    const hasDiscount = /\b(discount(?:ed|s)?|off|marked\s+down|reduced\s+by|cut\s+by|coupon)\b/i.test(text);
    const hasIncrease = /\b(tax|tip|gratuity|increase|increased|rise|rises|rose|markup|surcharge|interest|added|add|plus|raises?|doubled|tripled)\b/i.test(text);
    const nonFinalTarget = /\b(original\s+price|before\s+the|was\s+(?:its|the)\s+(?:original|initial|starting)|sav(?:e|es|ed|ing|ings)|how\s+much\s+(?:less|cheaper|off)|fraction|percent|percentage|proportion|each\s+(?:person|friend)|per\s+person|split)\b/i.test(text);
    // Require plainToks.length === 0 (no quantity multipliers like "buy 3 shirts at $50 each").
    const discountOnlyFinal = hasDiscount && !hasIncrease && !nonFinalTarget &&
      plainToks.length === 0 && currToks.length === 1 && currToks[0].v > 0 && pctToks.every((t) => t.v > 0 && t.v < 100);

    const out = { family: 'sequential_percent', checks };
    if (discountOnlyFinal) {
      out.basePrice = currToks[0].v;
      out.discounts = pctToks.map((t) => t.v);
      checks.push('discount_price_bounds', 'zero_discount_identity');
    }
    checks.push('deterministic', 'non_constant_sensitivity');
    return out;
  }

  // 5. General numeric fallback
  return {
    family: 'general_numeric',
    checks: ['deterministic', 'non_constant_sensitivity'],
  };
}

/** Identify unambiguous discount parameter indices when params = [basePrice, d1, d2, ...] (in any order). */
function findDiscountParamLayout(params, basePrice, discounts) {
  if (!Array.isArray(params) || params.length !== 1 + discounts.length) return null;
  const approx = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
  const matchesDiscount = (v, d) => approx(v, d) || approx(v, d / 100);
  if (discounts.some((d) => matchesDiscount(basePrice, d))) return null;
  const baseIndices = params.map((v, i) => (approx(v, basePrice) ? i : -1)).filter((i) => i >= 0);
  if (baseIndices.length !== 1) return null;
  const baseIdx = baseIndices[0];
  const pool = [...discounts];
  for (let i = 0; i < params.length; i++) {
    if (i === baseIdx) continue;
    const j = pool.findIndex((d) => matchesDiscount(params[i], d));
    if (j < 0) return null;
    pool.splice(j, 1);
  }
  return { baseIdx, zeroParams: params.map((v, i) => (i === baseIdx ? v : 0)) };
}

/** Output-only invariant checks (run for both parameterized and parameterless programs). */
function evaluateOutputChecks(answer, inv, task) {
  const checks = [];
  const eps = 1e-9;

  if (inv.family === 'round_trip_average' && inv.speeds?.length === 2) {
    const lo = Math.min(inv.speeds[0], inv.speeds[1]);
    const hi = Math.max(inv.speeds[0], inv.speeds[1]);
    const pass = answer >= lo - eps && answer <= hi + eps;
    checks.push({
      name: 'cauchy_bounds',
      pass,
      detail: pass ? `${answer} in [${lo}, ${hi}]` : `${answer} outside [${lo}, ${hi}]`,
    });
  }

  if (inv.family === 'parallel_work_rate' && inv.times?.length >= 2) {
    const fastest = Math.min(...inv.times);
    const pass = answer > 0 && answer < fastest - eps;
    checks.push({
      name: 'faster_than_fastest',
      pass,
      detail: pass ? `0 < ${answer} < ${fastest}` : `${answer} not in (0, ${fastest})`,
    });
  }

  if (inv.family === 'sequential_percent') {
    if (inv.checks.includes('non_negative')) {
      const pass = answer >= -eps;
      checks.push({
        name: 'non_negative',
        pass,
        detail: pass ? `${answer} >= 0` : `${answer} < 0`,
      });
    }
    if (inv.checks.includes('discount_price_bounds') && typeof inv.basePrice === 'number') {
      const pass = answer >= -eps && answer <= inv.basePrice + eps;
      checks.push({
        name: 'discount_price_bounds',
        pass,
        detail: pass ? `${answer} in [0, ${inv.basePrice}]` : `${answer} outside [0, ${inv.basePrice}]`,
      });
    }
  }

  if (inv.family === 'weighted_average_mixture' && inv.rates?.length >= 2) {
    const lo = Math.min(...inv.rates);
    const hi = Math.max(...inv.rates);
    const decimalMode = inv.rateUnit === 'percent' && /\b(decimal|fraction)\b/i.test(String(task));
    const inRaw = answer >= lo - eps && answer <= hi + eps;
    const inDec = decimalMode && answer >= lo / 100 - eps && answer <= hi / 100 + eps;
    const pass = inRaw || inDec;
    checks.push({
      name: 'convex_hull',
      pass,
      detail: pass ? `${answer} in [${lo}, ${hi}]` : `${answer} outside convex hull [${lo}, ${hi}]`,
    });
  }

  return checks;
}

/**
 * Run a candidate program + all applicable metamorphic probes in ONE batched, VM-isolated sandbox call (~40 ms, 0 GPU calls).
 * Supports both parameterized `function solve(...params)` and legacy parameterless scripts printing one number.
 * Returns { ok, answer, family, checks: [{ name, pass, detail }], vetoReason, error? }.
 */
export async function checkProgramInvariants(program, params, task, { sandbox = runSandboxedJs, timeoutMs = 4000, invariants = null } = {}) {
  const inv = invariants || extractTaskInvariants(task);
  const src = String(program ?? '').trim();
  const hasParams = Array.isArray(params) && params.length > 0 && params.length <= MAX_PARAMS && params.every((x) => typeof x === 'number' && Number.isFinite(x));
  const parameterized = hasSolveFn(src) && hasParams;
  const nonce = crypto.randomBytes(12).toString('hex');
  const marker = `__INV_${nonce}__:`;

  // Parameterless path: execute inside vm.runInNewContext (no process/fetch/require) and collect printed output.
  if (!parameterized) {
    const isolated = [
      'const vm = require("node:vm");',
      'const __write = process.stdout.write.bind(process.stdout);',
      'const __lines = [];',
      'const __safeConsole = Object.freeze({',
      '  log: (...a) => __lines.push(a.map(String).join(" ")),',
      '  info: () => {}, warn: () => {}, error: () => {},',
      '});',
      'const __ctx = vm.createContext({ console: __safeConsole });',
      `vm.runInContext(${JSON.stringify(src)}, __ctx, { timeout: ${Math.min(timeoutMs, 3500)} });`,
      '__write(__lines.join("\\n") + "\\n");',
    ].join('\n');
    const run = await sandbox(isolated, { timeoutMs });
    if (run.exitCode !== 0 || run.timedOut) {
      return { ok: false, answer: null, family: inv.family, checks: [], vetoReason: null, error: 'program failed' };
    }
    const raw = answerKey('number', run.stdout);
    if (raw == null) {
      return { ok: false, answer: null, family: inv.family, checks: [], vetoReason: null, error: 'not exactly one number' };
    }
    const answer = Number(Number(raw).toPrecision(12));
    const checks = evaluateOutputChecks(answer, inv, task);
    const failed = checks.find((c) => !c.pass);
    return {
      ok: !failed,
      answer,
      family: inv.family,
      checks,
      vetoReason: failed ? `${failed.name}: ${failed.detail}` : null,
    };
  }

  // Parameterized path: plan all applicable metamorphic probes and execute in ONE batched VM-isolated sandbox subprocess.
  const probes = [];
  const rtMeta = inv.family === 'round_trip_average' && params.length === 2 && inv.speeds?.length === 2 && sameMultiset(params, inv.speeds);
  if (rtMeta) {
    probes.push({ id: 'rt_idemp', args: [params[0], params[0]] });
    probes.push({ id: 'rt_sym', args: [params[1], params[0]] });
    probes.push({ id: 'rt_scale', args: [2 * params[0], 2 * params[1]] });
  }

  const pwMeta = inv.family === 'parallel_work_rate' && params.length === 2 && inv.times?.length === 2 && sameMultiset(params, inv.times);
  if (pwMeta) {
    probes.push({ id: 'pw_half', args: [params[0], params[0]] });
    probes.push({ id: 'pw_sym', args: [params[1], params[0]] });
  }

  const discLayout = inv.family === 'sequential_percent' && inv.checks.includes('zero_discount_identity')
    ? findDiscountParamLayout(params, inv.basePrice, inv.discounts || [])
    : null;
  if (discLayout) {
    probes.push({ id: 'disc_zero', args: discLayout.zeroParams });
  }

  // Sensitivity probes: +10% (or +1 if 0), integer +1, and wider 2x perturbation (handles step/floor/ceil plateaus).
  const sensIds = [];
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    const p1 = [...params];
    p1[i] = v === 0 ? 1 : v * 1.1;
    const id1 = `sens_rel_${i}`;
    probes.push({ id: id1, args: p1 });
    sensIds.push(id1);

    const pWide = [...params];
    pWide[i] = v === 0 ? 5 : v * 2;
    const idWide = `sens_wide_${i}`;
    probes.push({ id: idWide, args: pWide });
    sensIds.push(idWide);

    if (Number.isInteger(v) && v !== 0 && Math.abs(v) < 10) {
      const p2 = [...params];
      p2[i] = v + 1;
      const id2 = `sens_int_${i}`;
      probes.push({ id: id2, args: p2 });
      sensIds.push(id2);
    }
  }

  const vmTimeout = Math.min(timeoutMs, 3000);
  // Double-isolated harness: candidate code executes inside a clean vm.Context with NO process, NO fetch,
  // NO console output channel, and NO access to the random per-call marker or outer JSON.stringify.
  const harness = [
    'const vm = require("node:vm");',
    'const __stringify = JSON.stringify;',
    'const __write = process.stdout.write.bind(process.stdout);',
    'const __silentConsole = Object.freeze({ log(){}, info(){}, warn(){}, error(){} });',
    'const __ctx = vm.createContext({ console: __silentConsole });',
    `const __solve = vm.runInContext(${JSON.stringify(src + '\n; typeof solve === "function" ? solve : null;')}, __ctx, { timeout: ${vmTimeout} });`,
    'const __toNum = (v) => {',
    '  if (typeof v === "number") return Number.isFinite(v) ? v : null;',
    '  if (typeof v === "string" && /^-?\\d+(?:\\.\\d+)?$/.test(v.trim())) { const n = Number(v.trim()); return Number.isFinite(n) ? n : null; }',
    '  return null;',
    '};',
    'const __call = (args) => {',
    '  try {',
    '    __ctx.__a = args;',
    `    const out = vm.runInContext("__solve(...__a)", Object.assign(__ctx, { __solve }), { timeout: ${Math.min(vmTimeout, 1500)} });`,
    '    const n = __toNum(out);',
    '    return n === null ? { err: "non-finite output" } : { val: n };',
    '  } catch (e) {',
    '    return { err: e && e.name ? String(e.name).slice(0, 40) : "Error" };',
    '  }',
    '};',
    'const __res = { hasSolve: typeof __solve === "function", probes: {} };',
    'if (__res.hasSolve) {',
    `  const __base = ${JSON.stringify(params)};`,
    '  __res.run1 = __call(__base);',
    '  __res.run2 = __call(__base);',
    `  for (const __p of ${JSON.stringify(probes)}) { __res.probes[__p.id] = __call(__p.args); }`,
    '}',
    `__write("\\n" + ${JSON.stringify(marker)} + __stringify(__res) + "\\n");`,
  ].join('\n');

  const run = await sandbox(harness, { timeoutMs });
  if (run.exitCode !== 0 || run.timedOut) {
    return { ok: false, answer: null, family: inv.family, checks: [], vetoReason: null, error: 'program failed' };
  }
  const lines = String(run.stdout ?? '').split(/\r?\n/);
  let line = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(marker)) { line = lines[i]; break; }
  }
  if (!line) {
    return { ok: false, answer: null, family: inv.family, checks: [], vetoReason: null, error: 'program failed' };
  }
  let payload;
  try { payload = JSON.parse(line.slice(marker.length)); } catch {
    return { ok: false, answer: null, family: inv.family, checks: [], vetoReason: null, error: 'program failed' };
  }
  if (!payload.hasSolve || payload.run1?.val == null) {
    return { ok: false, answer: null, family: inv.family, checks: [], vetoReason: null, error: 'not exactly one number' };
  }

  const rawAnswer = payload.run1.val;
  const answer = Number(rawAnswer.toPrecision(12));
  const checks = [];

  // Output-only bounds first
  checks.push(...evaluateOutputChecks(answer, inv, task));

  // Determinism check
  const run2Val = payload.run2?.val;
  const detPass = run2Val != null && Math.abs(rawAnswer - run2Val) <= Math.max(1e-12, Math.abs(rawAnswer) * 1e-12);
  checks.push({
    name: 'deterministic',
    pass: detPass,
    detail: detPass ? 'repeated run matches' : `run1=${rawAnswer}, run2=${run2Val ?? payload.run2?.err}`,
  });

  // Domain metamorphic checks
  if (rtMeta) {
    const idemp = payload.probes.rt_idemp;
    const idempPass = idemp?.val != null && relClose(idemp.val, params[0], 1e-4);
    checks.push({
      name: 'equal_input_idempotence',
      pass: idempPass,
      detail: idempPass ? `solve(${params[0]},${params[0]})=${idemp.val}` : `solve(${params[0]},${params[0]})=${idemp?.val ?? idemp?.err}, expected ${params[0]}`,
    });

    const sym = payload.probes.rt_sym;
    const symPass = sym?.val != null && relClose(sym.val, rawAnswer, 1e-4);
    checks.push({
      name: 'symmetry',
      pass: symPass,
      detail: symPass ? `solve(${params[1]},${params[0]})=${sym.val}` : `solve(${params[1]},${params[0]})=${sym?.val ?? sym?.err}, expected ${rawAnswer}`,
    });

    const scale = payload.probes.rt_scale;
    const scalePass = scale?.val != null && relClose(scale.val, 2 * rawAnswer, 1e-4);
    checks.push({
      name: 'scale_homogeneity',
      pass: scalePass,
      detail: scalePass ? `solve(2a,2b)=${scale.val}` : `solve(2a,2b)=${scale?.val ?? scale?.err}, expected ${2 * rawAnswer}`,
    });
  }

  if (pwMeta) {
    const half = payload.probes.pw_half;
    const expectedHalf = params[0] / 2;
    const halfPass = half?.val != null && relClose(half.val, expectedHalf, 1e-4);
    checks.push({
      name: 'equal_worker_halving',
      pass: halfPass,
      detail: halfPass ? `solve(${params[0]},${params[0]})=${half.val}` : `solve(${params[0]},${params[0]})=${half?.val ?? half?.err}, expected ${expectedHalf}`,
    });

    const sym = payload.probes.pw_sym;
    const symPass = sym?.val != null && relClose(sym.val, rawAnswer, 1e-4);
    checks.push({
      name: 'symmetry',
      pass: symPass,
      detail: symPass ? `solve(${params[1]},${params[0]})=${sym.val}` : `solve(${params[1]},${params[0]})=${sym?.val ?? sym?.err}, expected ${rawAnswer}`,
    });
  }

  if (discLayout) {
    const z = payload.probes.disc_zero;
    const zPass = z?.val != null && relClose(z.val, inv.basePrice, 1e-4);
    checks.push({
      name: 'zero_discount_identity',
      pass: zPass,
      detail: zPass ? `solve(zero discounts)=${z.val}` : `solve(zero discounts)=${z?.val ?? z?.err}, expected ${inv.basePrice}`,
    });
  }

  // General non-constant sensitivity check
  const sensResults = sensIds.map((id) => payload.probes[id]).filter((r) => r && r.val != null);
  const changed = sensResults.some((r) => Math.abs(r.val - rawAnswer) > Math.max(1e-9, Math.abs(rawAnswer) * 1e-9));
  const sensPass = sensResults.length === 0 ? true : changed;
  checks.push({
    name: 'non_constant_sensitivity',
    pass: sensPass,
    detail: sensPass ? 'output responds to parameter perturbation' : `output remained constant at ${answer} under all perturbations`,
  });

  const failed = checks.find((c) => !c.pass);
  return {
    ok: !failed,
    answer,
    family: inv.family,
    checks,
    vetoReason: failed ? `${failed.name}: ${failed.detail}` : null,
  };
}
