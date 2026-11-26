#!/usr/bin/env node
// Phase 21 measurement script: Metamorphic & Representation-Diverse Program Judging.
//
// Evaluates the Phase 21 program voice on:
//   - standard   : Phase 20 Standard 40 tasks (from docs/phases/evidence-phase20-program-v2.json)
//   - hard       : Phase 20 Hard 13 tasks (from docs/phases/evidence-phase20-hard-v2.json)
//   - adversarial: 12 fresh held-out metamorphic trap tasks (4 round-trip, 4 parallel work, 4 discount/mixture)
// Plus a 0-GPU reference check verifying falseVetoCount === 0 across known-good ground-truth functions for every
// invariant family and false-positive edge case.
//
// Usage:
//   node scripts/measure-phase21-metamorphic.mjs [--suite standard|hard|adversarial|all] [--ref-only]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agency } from '../src/agency.js';
import { programVoice } from '../src/evolve/program-voice.js';
import { checkProgramInvariants } from '../src/evolve/invariants.js';
import { nearAnswer } from '../src/evolve/crystallizer.js';
import { runSandboxedJs } from '../src/tools/builtin.js';
import { sha256, nowIso } from '../src/core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let suite = 'all';
  let refOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--suite' && argv[i + 1]) { suite = argv[++i].toLowerCase(); }
    else if (argv[i].startsWith('--suite=')) { suite = argv[i].slice('--suite='.length).toLowerCase(); }
    else if (argv[i] === '--ref-only') { refOnly = true; }
  }
  if (!['standard', 'hard', 'adversarial', 'all'].includes(suite)) {
    throw new Error(`Unknown --suite "${suite}". Expected standard|hard|adversarial|all.`);
  }
  return { suite, refOnly };
}

function loadEvidenceTasks(relPath) {
  const full = path.join(ROOT, relPath);
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  return (data.rows || []).map((r) => ({ task: r.task, truth: Number(r.truth) }));
}

const ADVERSARIAL_TASKS = [
  // 4 round-trip speed variants
  { task: 'A cyclist rides up a mountain pass at 12 km/h and descends the same road at 36 km/h. What is the average speed for the round trip, in km/h?', truth: 18 },
  { task: 'A ferry crosses a channel at 16 knots and returns along the same route at 24 knots. What is its average speed for the round trip, in knots?', truth: 19.2 },
  { task: 'A delivery drone flies to a depot at 20 mph and returns along the same path at 30 mph. What is its average speed for the round trip, in mph?', truth: 24 },
  { task: 'A swimmer swims across a lake at 2 km/h and swims back along the same stretch at 6 km/h. What is the average speed for the round trip, in km/h?', truth: 3 },
  // 4 parallel work-rate variants
  { task: 'Pump A fills a reservoir in 4 hours and pump B fills it in 12 hours. Working together, how many hours do they take to fill it?', truth: 3 },
  { task: 'Printer X prints a catalog in 10 hours and printer Y prints it in 15 hours. Working together, how many hours do they need?', truth: 6 },
  { task: 'Robot A assembles a batch in 6 minutes and robot B assembles it in 12 minutes. Working together, how many minutes do they take?', truth: 4 },
  { task: 'Crew A paves a road in 15 days and crew B paves it in 30 days. Working together, how many days do they need?', truth: 10 },
  // 4 multi-step discount / mixture traps
  { task: 'A $240 jacket is discounted by 25%, and then an extra 20% off coupon is applied to the sale price. What is the final price in dollars?', truth: 144 },
  { task: 'A $1,200 laptop is marked down 15%, then a further 10% off the reduced price. What is the final price in dollars?', truth: 918 },
  { task: '5 kg of Arabica beans cost $12 per kg and 3 kg of Robusta beans cost $4 per kg. What is the average price per kg of the blend, in dollars?', truth: 9 },
  { task: 'A chemist mixes 2 liters of 15% saline solution with 3 liters of 40% saline solution. What is the percent concentration of the mixture?', truth: 30 },
];

// 0-GPU ground-truth reference check across every invariant family and false-positive edge case.
const REFERENCE_CASES = [
  {
    name: 'round_trip_average (2-arg)',
    task: 'A tractor drives to a field at 10 mph and back at 15 mph on the same road. What is the average speed for the round trip?',
    params: [10, 15],
    program: 'function solve(v1, v2) { const d = 100; return (2 * d) / (d / v1 + d / v2); }',
    truth: 12,
  },
  {
    name: 'round_trip_average (4-arg equal distance)',
    task: 'A car drives 60 km at 30 km/h and then another 60 km at 60 km/h. What is its average speed for the whole trip, in km/h?',
    params: [60, 30, 60, 60],
    program: 'function solve(d1, v1, d2, v2) { return (d1 + d2) / (d1 / v1 + d2 / v2); }',
    truth: 40,
  },
  {
    name: 'parallel_work_rate (2-arg)',
    task: 'Pipe A fills a tank in 3 hours and pipe B fills it in 6 hours. Working together, how many hours do they take to fill it?',
    params: [3, 6],
    program: 'function solve(a, b) { return 1 / (1 / a + 1 / b); }',
    truth: 2,
  },
  {
    name: 'drain_guard (must not false-veto)',
    task: 'Pipe A fills a tank in 4 hours, pipe B fills it in 6 hours, and a drain empties it in 12 hours. With all three open, how many hours to fill the tank?',
    params: [4, 6, 12],
    program: 'function solve(a, b, d) { return 1 / (1 / a + 1 / b - 1 / d); }',
    truth: 3,
  },
  {
    name: 'sequential_percent (discount-only final)',
    task: 'A $1,200 laptop is marked down 15%, then a further 10% off the reduced price. What is the final price in dollars?',
    params: [1200, 15, 10],
    program: 'function solve(price, d1, d2) { return price * (1 - d1 / 100) * (1 - d2 / 100); }',
    truth: 918,
  },
  {
    name: 'sequential_percent (reverse original price)',
    task: 'After a 20% discount, a coat costs $64. What was its original price in dollars?',
    params: [20, 64],
    program: 'function solve(d, sale) { return sale / (1 - d / 100); }',
    truth: 80,
  },
  {
    name: 'weighted_average_mixture (price blend)',
    task: '5 kg of Arabica beans cost $12 per kg and 3 kg of Robusta beans cost $4 per kg. What is the average price per kg of the blend, in dollars?',
    params: [5, 12, 3, 4],
    program: 'function solve(w1, p1, w2, p2) { return (w1 * p1 + w2 * p2) / (w1 + w2); }',
    truth: 9,
  },
  {
    name: 'weighted_average_mixture (concentration)',
    task: 'A chemist mixes 2 liters of 15% saline solution with 3 liters of 40% saline solution. What is the percent concentration of the mixture?',
    params: [2, 15, 3, 40],
    program: 'function solve(v1, c1, v2, c2) { return (v1 * c1 + v2 * c2) / (v1 + v2); }',
    truth: 30,
  },
  {
    name: 'dilution_guard (must not false-veto)',
    task: 'A 20-liter drink is 30% juice. How many liters of water must be added to make it 20% juice?',
    params: [20, 30, 20],
    program: 'function solve(vol, c1, c2) { return (vol * (c1 / 100)) / (c2 / 100) - vol; }',
    truth: 10,
  },
  {
    name: 'general_numeric (combinations)',
    task: 'How many different groups of 3 people can be chosen from 8 people?',
    params: [8, 3],
    program: 'function solve(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }',
    truth: 56,
  },
];

async function runReferenceCheck() {
  const rows = [];
  for (const rc of REFERENCE_CASES) {
    const res = await checkProgramInvariants(rc.program, rc.params, rc.task, { sandbox: runSandboxedJs });
    const right = res.ok && res.answer != null && nearAnswer(res.answer, rc.truth);
    rows.push({
      name: rc.name,
      family: res.family,
      ok: res.ok,
      answer: res.answer,
      truth: rc.truth,
      right,
      vetoReason: res.vetoReason,
    });
  }
  const falseVetoCount = rows.filter((r) => !r.ok).length;
  return { total: rows.length, falseVetoCount, passed: rows.filter((r) => r.right).length, rows };
}

async function runSuite(name, items, agency) {
  const rows = [];
  let vetoes = 0;
  let distinctModelViolations = 0;
  let remoteCalls = 0;
  let totalMs = 0;

  for (const [idx, item] of items.entries()) {
    const t0 = Date.now();
    const { result: r, meter } = await agency.router.metered(() =>
      programVoice(item.task, {
        router: agency.router,
        sandbox: runSandboxedJs,
        ledger: agency.ledger,
        taskSha256: sha256(item.task),
      }),
    );
    const ms = Date.now() - t0;
    totalMs += ms;
    const right = r.answer != null && nearAnswer(r.answer, item.truth);
    const silent = r.answer == null;
    vetoes += (r.vetoes || []).length;
    if (r.verdict === 'same model cannot self-corroborate') distinctModelViolations++;
    remoteCalls += Number(meter?.remote || 0);

    rows.push({
      index: idx + 1,
      task: item.task,
      truth: item.truth,
      answer: r.answer,
      right,
      silent,
      family: r.family,
      verdict: r.verdict,
      vetoes: (r.vetoes || []).map((v) => ({ role: v.role, model: v.model, answer: v.answer, vetoReason: v.vetoReason })),
      votes: r.votes.map((v) => ({ role: v.role, model: v.model || null, answer: v.answer ?? null, vetoed: Boolean(v.vetoed), vetoReason: v.vetoReason || null, error: v.error || null })),
      ms,
    });
    const tag = right ? 'OK' : silent ? 'SILENT' : 'WRONG';
    process.stdout.write(`[${name} ${idx + 1}/${items.length}] ${tag} ans=${r.answer} truth=${item.truth} vetoes=${(r.vetoes || []).length} (${(ms / 1000).toFixed(1)}s)\n`);
  }

  const n = rows.length;
  const correct = rows.filter((r) => r.right).length;
  const silent = rows.filter((r) => r.silent).length;
  const wrong = n - correct - silent;
  return {
    name,
    items: n,
    accuracy: n ? +(correct / n).toFixed(3) : null,
    correct,
    wrong,
    silent,
    vetoes,
    distinctModelViolations,
    remoteCalls,
    avgSec: n ? +(totalMs / n / 1000).toFixed(2) : null,
    rows,
  };
}

async function main() {
  const { suite, refOnly } = parseArgs(process.argv.slice(2));
  const refCheck = await runReferenceCheck();
  console.log(`\n0-GPU Reference Check: ${refCheck.passed}/${refCheck.total} passed, falseVetoCount=${refCheck.falseVetoCount}`);
  if (refCheck.falseVetoCount > 0) {
    console.error('ERROR: False veto detected on known-good reference functions:', refCheck.rows.filter((r) => !r.ok));
    process.exitCode = 1;
    return;
  }
  if (refOnly) return;

  const suitesToRun = [];
  if (suite === 'standard' || suite === 'all') suitesToRun.push(['standard', loadEvidenceTasks('docs/phases/evidence-phase20-program-v2.json')]);
  if (suite === 'hard' || suite === 'all') suitesToRun.push(['hard', loadEvidenceTasks('docs/phases/evidence-phase20-hard-v2.json')]);
  if (suite === 'adversarial' || suite === 'all') suitesToRun.push(['adversarial', ADVERSARIAL_TASKS]);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-phase21-'));
  const agency = new Agency({
    home,
    edge: { enabled: false, overflow: { enabled: false } },
    skills: { cloudJudge: false, programVoice: true },
    limits: { localConcurrency: 1 },
    dream: { enabled: false },
    crystallize: { auto: false },
  });

  const results = {};
  try {
    await agency.boot({ schedulers: false, resume: false });
    for (const [name, items] of suitesToRun) {
      results[name] = await runSuite(name, items, agency);
    }
  } finally {
    await agency.shutdown();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }

  const report = {
    phase: 21,
    at: nowIso(),
    suite,
    referenceCheck: refCheck,
    suites: results,
  };

  const outPath = path.join(ROOT, 'docs', 'phases', 'evidence-phase21-metamorphic.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('\n=== Phase 21 Metamorphic Program Judging Summary ===');
  console.log('Suite        | Items | Acc    | Wrong | Silent | Vetoes | DistViol | Remote | AvgSec');
  console.log('-------------|-------|--------|-------|--------|--------|----------|--------|-------');
  for (const s of Object.values(results)) {
    const acc = `${(s.accuracy * 100).toFixed(1)}%`.padStart(6);
    console.log(
      `${s.name.padEnd(12)} | ${String(s.items).padStart(5)} | ${acc} | ${String(s.wrong).padStart(5)} | ${String(s.silent).padStart(6)} | ${String(s.vetoes).padStart(6)} | ${String(s.distinctModelViolations).padStart(8)} | ${String(s.remoteCalls).padStart(6)} | ${String(s.avgSec).padStart(6)}`,
    );
  }
  console.log(`\nSaved structured evidence to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
