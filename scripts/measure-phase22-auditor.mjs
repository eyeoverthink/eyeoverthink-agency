// Phase 22 measurement script: Deterministic Claim-and-Evidence Auditor.
// Boots a headless local Agency (no cloud judge, localConcurrency: 1) and runs:
//   Suite 1 (12 deliverables): 4 broken JS + 4 numeric fabrication + 4 clean controls
//     comparing baseline prose critic (Solon) alone vs prose critic + ClaimAuditor.
//   Suite 2 (3 self-healing code tasks): real local forge_keeper repairing seeded failing
//     attempt-1 drafts using deterministic sandbox defects.
//   Suite 3 (4 private/sealed tasks with synthetic PII): verifying local-only auditing,
//     meter.remote === 0, and zero PII leakage into the SQLite ledger.
//
// Usage: node scripts/measure-phase22-auditor.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agency } from '../src/agency.js';
import { criticPrompt } from '../src/orchestrator/plan.js';
import { extractJson, truncate } from '../src/core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'docs', 'phases', 'evidence-phase22-auditor.json');

const SUITE1_CASES = [
  // ---- 4 broken JS deliverables ----
  {
    id: 'code_ref_err',
    kind: 'broken_code',
    expectDefect: true,
    goal: 'Write a JavaScript function that computes the sum of squares of an array and verifies it.',
    sources: [{ output: 'Use Array.prototype.reduce to sum x*x and check [3, 4] === 25.' }],
    deliverable: [
      '# Sum of Squares Helper',
      'Here is the verified JavaScript implementation:',
      '```js',
      'function sumSquares(nums) {',
      '  return nums.reduce((acc, item) => acc + value * item, 0);',
      '}',
      'console.assert(sumSquares([3, 4]) === 25, "3^2 + 4^2 should equal 25");',
      'console.log(sumSquares([3, 4]));',
      '```',
    ].join('\n'),
  },
  {
    id: 'code_assert_fail',
    kind: 'broken_code',
    expectDefect: true,
    goal: 'Write a JavaScript function to compute compound discount (20% then 10% off $100 = 72) with self-test.',
    sources: [{ output: 'Sequential discounts multiply: 100 * 0.8 * 0.9 = 72.' }],
    deliverable: [
      '# Compound Discount Calculator',
      '```js',
      'function compoundDiscount(price, discounts) {',
      '  const totalRate = discounts.reduce((a, b) => a + b, 0);',
      '  return price * (1 - totalRate / 100);',
      '}',
      'console.assert(Math.abs(compoundDiscount(100, [20, 10]) - 72) < 1e-9, "expected 72");',
      'console.log(compoundDiscount(100, [20, 10]));',
      '```',
    ].join('\n'),
  },
  {
    id: 'code_syntax_err',
    kind: 'broken_code',
    expectDefect: true,
    goal: 'Write a JavaScript function that deduplicates an array while preserving order.',
    sources: [{ output: 'Use a Set to keep unique items in insertion order.' }],
    deliverable: [
      '# Ordered Deduplication',
      '```js',
      'function dedupe(items) {',
      '  const seen = new Set();',
      '  return items.filter((x) => {',
      '    if (seen.has(x)) return false;',
      '    seen.add(x);',
      '    return true;',
      '  };',
      '}',
      'console.log(dedupe([1, 2, 1, 3]));',
      '```',
    ].join('\n'),
  },
  {
    id: 'code_type_err',
    kind: 'broken_code',
    expectDefect: true,
    goal: 'Write a JavaScript helper that formats cents as dollars and verifies 1250 -> "$12.50".',
    sources: [{ output: 'Divide cents by 100 and format with two decimals.' }],
    deliverable: [
      '# Currency Formatter',
      '```js',
      'function formatUsd(cents) {',
      '  const dollars = (cents / 100).toFixed(2);',
      '  return "$" + dollars.trimLeftSpaces();',
      '}',
      'console.assert(formatUsd(1250) === "$12.50", "format check");',
      'console.log(formatUsd(1250));',
      '```',
    ].join('\n'),
  },

  // ---- 4 numeric-fabrication synthesis deliverables ----
  {
    id: 'num_fab_revenue',
    kind: 'numeric_fabrication',
    expectDefect: true,
    goal: 'Summarize Q3 revenue and operating costs from the analyst notes.',
    sources: [
      { output: 'Base subscription revenue was $1,450 and expansion revenue was $350.' },
      { output: 'Operating costs totaled $620 for the quarter.' },
    ],
    deliverable: '# Q3 Financial Summary\nTotal revenue reached $1,800 ($1,450 base plus $350 expansion) against $620 in operating costs. Net EBITDA margin expanded by 42.7% to $942.50.',
  },
  {
    id: 'num_fab_latency',
    kind: 'numeric_fabrication',
    expectDefect: true,
    goal: 'Report benchmark latency results from the two test runs.',
    sources: [
      { output: 'Local cache lookup median latency was 14.2 ms across 250 queries.' },
      { output: 'Fallback SQLite scan took 48.6 ms across 250 queries.' },
    ],
    deliverable: '# Benchmark Summary\nAcross 250 queries, cache lookups averaged 14.2 ms compared to 48.6 ms for SQLite scans, yielding a 3.4x speedup and cutting p99 tail latency to 89.3 ms while saving $1,280 monthly.',
  },
  {
    id: 'num_fab_energy',
    kind: 'numeric_fabrication',
    expectDefect: true,
    goal: 'Combine the two energy audit findings into one executive brief.',
    sources: [
      { output: 'Building A consumed 4,200 kWh in October 2026.' },
      { output: 'Building B consumed 3,150 kWh in October 2026.' },
    ],
    deliverable: '# October 2026 Energy Brief\nBuilding A used 4,200 kWh and Building B used 3,150 kWh (7,350 kWh combined). HVAC retrofits accounted for a 27.4% reduction saving 1,920 kWh compared to prior year.',
  },
  {
    id: 'num_fab_retention',
    kind: 'numeric_fabrication',
    expectDefect: true,
    goal: 'Synthesize customer support metrics from team reports.',
    sources: [
      { output: 'Support resolved 184 tickets with a 0.915 satisfaction score.' },
      { output: 'Escalations accounted for 16 tickets.' },
    ],
    deliverable: '# Support Operations Brief\nThe team resolved 184 tickets with 91.5% satisfaction and 16 escalations. Average handle time dropped to 6.8 minutes and renewal retention rose to 96.4%.',
  },

  // ---- 4 clean control deliverables ----
  {
    id: 'clean_code_fib',
    kind: 'clean_control',
    expectDefect: false,
    goal: 'Write a self-contained JavaScript Fibonacci function and verify fib(10) === 55.',
    sources: [{ output: 'Iterative Fibonacci computes fib(10) = 55 in O(n) time.' }],
    deliverable: [
      '# Iterative Fibonacci',
      'Computes the 10th Fibonacci number (55) in linear time across 2 state variables:',
      '```js',
      'function fib(n) {',
      '  let a = 0, b = 1;',
      '  for (let i = 0; i < n; i++) [a, b] = [b, a + b];',
      '  return a;',
      '}',
      'console.assert(fib(10) === 55, "fib(10) must be 55");',
      'console.log(fib(10));',
      '```',
    ].join('\n'),
  },
  {
    id: 'clean_num_revenue',
    kind: 'clean_control',
    expectDefect: false,
    goal: 'Summarize Q3 2026 revenue and margin from upstream reports.',
    sources: [
      { output: 'Base revenue: $1,450. Expansion revenue: $350.' },
      { output: 'Gross margin ratio: 0.675. YoY growth: 18.4%.' },
    ],
    deliverable: [
      '# Q3 2026 Revenue Summary',
      '1. Combined revenue reached $1,800 ($1,450 base and $350 expansion across 2 segments).',
      '2. Gross margin held at 67.5% (0.675) with 18.4% annual growth.',
      '3. Step 3 review confirmed all figures for the 4th quarter outlook.',
    ].join('\n'),
  },
  {
    id: 'clean_code_stats',
    kind: 'clean_control',
    expectDefect: false,
    goal: 'Provide a JavaScript mean and median helper verified on [10, 20, 30, 40].',
    sources: [{ output: 'Mean and median of [10, 20, 30, 40] are both 25.' }],
    deliverable: [
      '# Mean and Median Helper',
      'For the 4 sample values [10, 20, 30, 40], both mean and median equal 25.',
      '```js',
      'function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }',
      'function median(arr) {',
      '  const s = [...arr].sort((a, b) => a - b);',
      '  const m = Math.floor(s.length / 2);',
      '  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;',
      '}',
      'const sample = [10, 20, 30, 40];',
      'console.assert(mean(sample) === 25 && median(sample) === 25, "stats match");',
      'console.log(mean(sample), median(sample));',
      '```',
    ].join('\n'),
  },
  {
    id: 'clean_esm_doc',
    kind: 'clean_control',
    expectDefect: false,
    goal: 'Summarize the 2026 API migration notes with an ESM usage example.',
    sources: [
      { output: 'Rate limit increased from 120 requests/min to 300 requests/min in 2026.' },
    ],
    deliverable: [
      '# 2026 API Migration Notes',
      '1. The rate limit increased from 120 to 300 requests per minute.',
      '2. Update imports in Step 2 as shown below:',
      '```mjs',
      'import { createClient } from "./client.mjs";',
      'export const client = createClient({ rateLimit: 300 });',
      '```',
    ].join('\n'),
  },
];

const SUITE2_TASKS = [
  {
    id: 'heal_palindrome',
    title: 'Write isPalindrome JS helper',
    instructions: 'Write a self-contained runnable ```js code block defining isPalindrome(str) (case-insensitive, alphanumeric only) with console.assert tests for "A man, a plan, a canal: Panama" (true) and "hello" (false).',
    seededDraft: '```js\nfunction isPalindrome(str) {\n  const cleaned = inputStr.toLowerCase().replace(/[^a-z0-9]/g, "");\n  return cleaned === cleaned.split("").reverse().join("");\n}\nconsole.assert(isPalindrome("A man, a plan, a canal: Panama") === true);\nconsole.assert(isPalindrome("hello") === false);\n```',
  },
  {
    id: 'heal_discount',
    title: 'Write sequentialDiscount JS helper',
    instructions: 'Write a self-contained runnable ```js code block defining sequentialDiscount(price, percents) that applies discounts sequentially, with console.assert verifying sequentialDiscount(200, [25, 10]) === 135.',
    seededDraft: '```js\nfunction sequentialDiscount(price, percents) {\n  const sum = percents.reduce((a, b) => a + b, 0);\n  return price * (1 - sum / 100);\n}\nconsole.assert(Math.abs(sequentialDiscount(200, [25, 10]) - 135) < 1e-9, "expected 135");\n```',
  },
  {
    id: 'heal_flatten',
    title: 'Write flattenOne JS helper',
    instructions: 'Write a self-contained runnable ```js code block defining flatten(arr) that recursively flattens nested arrays, with console.assert verifying JSON.stringify(flatten([1, [2, [3, 4]], 5])) === "[1,2,3,4,5]".',
    seededDraft: '```js\nfunction flatten(arr) {\n  return arr.reduce((acc, v) => acc.concat(Array.isArray(v) ? flatten(v) : v), []);\n\nconsole.assert(JSON.stringify(flatten([1, [2, [3, 4]], 5])) === "[1,2,3,4,5]");\n```',
  },
];

const PII_TOKENS = [
  'Elena Vance',
  'Marcus Chen',
  '555-0199',
  '555-0147',
  '123-45-6789',
  '987-65-4321',
  'elena.vance@privateclinic.org',
  'marcus.chen@privateclinic.org',
  'PT-88213',
  'PT-99412',
];

const SUITE3_PRIVATE = [
  {
    id: 'priv_math_1',
    privacy: 'private',
    agent: 'forge_keeper',
    task: 'Patient Elena Vance (phone 555-0199, SSN 123-45-6789, ID PT-88213) has a $240 clinic bill with a 25% insurance discount and then 8% tax. What is the final amount owed? End with FINAL <number>.',
    truth: 194.4,
  },
  {
    id: 'priv_code_2',
    privacy: 'private',
    agent: 'forge_keeper',
    task: 'For internal record of elena.vance@privateclinic.org (ID PT-88213), write a small self-contained ```js snippet that computes a 15% copay on $180 and verifies the result with console.assert.',
    truth: 27,
  },
  {
    id: 'sealed_math_3',
    privacy: 'sealed',
    agent: 'tycho',
    task: 'Client Marcus Chen (marcus.chen@privateclinic.org, phone 555-0147, SSN 987-65-4321) splits a $360 lab invoice (10% discount first) equally across 4 installments. How much is each installment? End with FINAL <number>.',
    truth: 81,
  },
  {
    id: 'sealed_code_4',
    privacy: 'sealed',
    agent: 'forge_keeper',
    task: 'For client Marcus Chen (ID PT-99412), write a small self-contained ```js snippet that calculates remaining balance after 3 payments of $45 on a $200 invoice and verifies it with console.assert.',
    truth: 65,
  },
];

async function runProseCritic(agency, task, deliverable) {
  const t0 = Date.now();
  const res = await agency.router.chat({
    role: 'critic',
    messages: criticPrompt(task, truncate(deliverable, 6000), ''),
    json: true,
    temperature: 0.1,
    maxTokens: 700,
    privacy: 'private',
  });
  const ms = Date.now() - t0;
  const c = extractJson(res.text) || {};
  const score = Math.min(1, Math.max(0, Number(c.score) || 0));
  const pass = score >= 0.6 && c.pass !== false;
  return { score, pass, defects: Array.isArray(c.defects) ? c.defects : [], model: res.model, ms };
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-phase22-'));
  const agency = new Agency({
    home,
    apiToken: 'measure-phase22',
    limits: { localConcurrency: 1 },
    skills: { cloudJudge: false, first: false },
    edge: { enabled: false },
    dream: { enabled: false },
    crystallize: { auto: false },
  });

  try {
    await agency.boot({ schedulers: false, resume: false });

    // ==================== SUITE 1 ====================
    console.log('=== Suite 1: 12 Deliverables (Baseline Prose Critic vs Critic + ClaimAuditor) ===');
    const suite1Rows = [];
    for (const c of SUITE1_CASES) {
      const critic = await runProseCritic(agency, { title: c.id, instructions: c.goal }, c.deliverable);
      const t0 = Date.now();
      const audit = await agency.auditor.auditDeliverable(c.goal, c.deliverable, c.sources, { missionId: `bench_${c.id}`, privacy: 'normal' });
      const auditMs = Date.now() - t0;

      const baselineFlagged = !critic.pass;
      const combinedScore = audit.ok ? critic.score : Math.min(critic.score, audit.scoreCap);
      const combinedFlagged = !critic.pass || !audit.ok;

      const row = {
        id: c.id,
        kind: c.kind,
        expectDefect: c.expectDefect,
        criticScore: critic.score,
        criticPass: critic.pass,
        criticModel: critic.model,
        criticMs: critic.ms,
        baselineFlagged,
        auditorOk: audit.ok,
        auditorScoreCap: audit.scoreCap,
        auditorFindings: audit.findings.map((f) => f.message),
        auditMs,
        combinedScore,
        combinedFlagged,
      };
      suite1Rows.push(row);
      console.log(`  [${c.kind}] ${c.id}: critic=${critic.score} (${baselineFlagged ? 'FLAG' : 'pass'}) | auditor=${audit.ok ? 'pass' : 'FLAG'} (${auditMs}ms) -> combined=${combinedFlagged ? 'FLAG' : 'pass'}`);
    }

    const defective = suite1Rows.filter((r) => r.expectDefect);
    const clean = suite1Rows.filter((r) => !r.expectDefect);
    const brokenCode = suite1Rows.filter((r) => r.kind === 'broken_code');
    const numFab = suite1Rows.filter((r) => r.kind === 'numeric_fabrication');

    const suite1Summary = {
      total: suite1Rows.length,
      baseline: {
        defectRecall: +(defective.filter((r) => r.baselineFlagged).length / defective.length).toFixed(3),
        brokenCodeRecall: +(brokenCode.filter((r) => r.baselineFlagged).length / brokenCode.length).toFixed(3),
        numericFabricationRecall: +(numFab.filter((r) => r.baselineFlagged).length / numFab.length).toFixed(3),
        falsePositives: clean.filter((r) => r.baselineFlagged).length,
        meanCriticMs: Math.round(suite1Rows.reduce((s, r) => s + r.criticMs, 0) / suite1Rows.length),
      },
      withAuditor: {
        defectRecall: +(defective.filter((r) => r.combinedFlagged).length / defective.length).toFixed(3),
        brokenCodeRecall: +(brokenCode.filter((r) => r.combinedFlagged).length / brokenCode.length).toFixed(3),
        numericFabricationRecall: +(numFab.filter((r) => r.combinedFlagged).length / numFab.length).toFixed(3),
        falsePositives: clean.filter((r) => r.combinedFlagged).length,
        auditorOnlyFalsePositives: clean.filter((r) => !r.auditorOk).length,
        meanAuditMs: Math.round(suite1Rows.reduce((s, r) => s + r.auditMs, 0) / suite1Rows.length),
        maxAuditMs: Math.max(...suite1Rows.map((r) => r.auditMs)),
      },
    };

    // ==================== SUITE 2 ====================
    console.log('\n=== Suite 2: 3 Self-Healing Code Tasks ===');
    const suite2Rows = [];
    for (const t of SUITE2_TASKS) {
      const taskObj = { id: `heal:${t.id}`, mission_id: 'bench_heal', title: t.title };
      const attempt1Audit = await agency.auditor.auditTask(taskObj, { final: t.seededDraft, steps: [] });
      const repairPrompt = [
        `Your task: ${t.title}\n${t.instructions}`,
        `\nYour previous attempt was rejected by the critic (score ${attempt1Audit.scoreCap}). Defects:\n${attempt1Audit.defects.map((d) => `- ${d}`).join('\n')}`,
        `Fix: Fix the deterministic sandbox defect(s) above and return a complete, runnable \`\`\`js code block.`,
        `Previous attempt:\n${t.seededDraft}`,
      ].join('\n');

      const t0 = Date.now();
      const repaired = await agency.runtime.run('forge_keeper', repairPrompt, { missionId: 'bench_heal', taskId: taskObj.id, privacy: 'private', skillFirst: false });
      const repairMs = Date.now() - t0;
      const attempt2Audit = await agency.auditor.auditTask(taskObj, repaired);
      const healed = !attempt1Audit.ok && attempt2Audit.ok && attempt2Audit.codeAudit.passed >= 1;

      suite2Rows.push({
        id: t.id,
        attempt1Ok: attempt1Audit.ok,
        attempt1Defects: attempt1Audit.defects,
        attempt2Ok: attempt2Audit.ok,
        attempt2PassedBlocks: attempt2Audit.codeAudit.passed,
        attempt2Defects: attempt2Audit.defects,
        healed,
        model: repaired.model,
        repairMs,
      });
      console.log(`  ${t.id}: attempt1=${attempt1Audit.ok ? 'pass' : 'FAIL'} -> attempt2=${attempt2Audit.ok ? 'PASS' : 'FAIL'} (healed=${healed}, ${repairMs}ms)`);
    }

    const suite2Summary = {
      total: suite2Rows.length,
      attempt1Caught: suite2Rows.filter((r) => !r.attempt1Ok).length,
      healedCount: suite2Rows.filter((r) => r.healed).length,
      healRate: +(suite2Rows.filter((r) => r.healed).length / suite2Rows.length).toFixed(3),
    };

    // ==================== SUITE 3 ====================
    console.log('\n=== Suite 3: 4 Private / Sealed Tasks with Synthetic PII ===');
    const suite3Rows = [];
    for (const p of SUITE3_PRIVATE) {
      const t0 = Date.now();
      const beforeSeq = agency.ledger.list({ limit: 1, kind: 'audit.private' })[0]?.seq ?? 0;
      const r = await agency.ask(p.agent, p.task, { privacy: p.privacy });
      const ms = Date.now() - t0;
      const auditEntry = agency.ledger.list({ limit: 10, kind: 'audit.private' }).find((e) => e.seq > beforeSeq)?.data || null;

      suite3Rows.push({
        id: p.id,
        privacy: p.privacy,
        agent: p.agent,
        model: r.model,
        ms,
        remoteCalls: r.meter.remote,
        localCalls: r.meter.calls - r.meter.remote,
        auditRecorded: Boolean(auditEntry),
        auditOk: auditEntry?.ok ?? null,
        codeChecked: auditEntry?.codeChecked ?? 0,
        codeFailed: auditEntry?.codeFailed ?? 0,
        numericChecked: auditEntry?.numericChecked ?? false,
        numericAgree: auditEntry?.numericAgree ?? null,
        hadAuditNote: /\*\*Local audit note:\*\*/.test(r.final),
      });
      console.log(`  [${p.privacy}] ${p.id}: remote=${r.meter.remote}, local=${r.meter.calls - r.meter.remote}, auditOk=${auditEntry?.ok}, note=${/\*\*Local audit note:\*\*/.test(r.final)} (${ms}ms)`);
    }

    // Scan ENTIRE SQLite ledger for any synthetic PII token.
    const allLedger = agency.store.all('SELECT * FROM ledger');
    const serializedLedger = JSON.stringify(allLedger);
    const leakedTokens = PII_TOKENS.filter((tok) => serializedLedger.includes(tok));
    const ledgerValid = agency.ledger.verify();

    const suite3Summary = {
      total: suite3Rows.length,
      totalRemoteCalls: suite3Rows.reduce((s, r) => s + r.remoteCalls, 0),
      allRemoteZero: suite3Rows.every((r) => r.remoteCalls === 0),
      defectsCaughtLocally: suite3Rows.filter((r) => r.auditOk === false).length,
      piiLeakedToLedger: leakedTokens.length,
      leakedTokens,
      ledgerEntriesScanned: allLedger.length,
      ledgerVerifyOk: ledgerValid.ok,
    };

    const report = {
      phase: 'phase-22-claim-auditor',
      timestamp: new Date().toISOString(),
      suite1: { summary: suite1Summary, rows: suite1Rows },
      suite2: { summary: suite2Summary, rows: suite2Rows },
      suite3: { summary: suite3Summary, rows: suite3Rows },
    };

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log('\n=== Summary ===');
    console.log(`Suite 1: baseline recall=${suite1Summary.baseline.defectRecall} (FP=${suite1Summary.baseline.falsePositives}) vs withAuditor recall=${suite1Summary.withAuditor.defectRecall} (FP=${suite1Summary.withAuditor.falsePositives}, auditorOnlyFP=${suite1Summary.withAuditor.auditorOnlyFalsePositives}, meanAuditMs=${suite1Summary.withAuditor.meanAuditMs}ms)`);
    console.log(`Suite 2: healed ${suite2Summary.healedCount}/${suite2Summary.total} (${Math.round(suite2Summary.healRate * 100)}%)`);
    console.log(`Suite 3: totalRemoteCalls=${suite3Summary.totalRemoteCalls}, piiLeakedToLedger=${suite3Summary.piiLeakedToLedger}, ledgerVerifyOk=${suite3Summary.ledgerVerifyOk}`);
    console.log(`Saved evidence to ${OUT_FILE}`);
  } finally {
    await agency.shutdown();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
