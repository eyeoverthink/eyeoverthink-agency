// Phase 22: Deterministic Claim-and-Evidence Auditor.
// Verifies runnable JS code blocks in the permission-locked sandbox, checks numeric provenance
// against source tasks, enforces logic-chain open-warning acknowledgement, and audits private
// replies 100% locally without leaking PII to remote models or the signed ledger.
import { makeAgency, lastUser, systemOf } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCodeBlocks,
  auditCodeBlocks,
  auditNumericProvenance,
  auditLogicChain,
  ClaimAuditor,
} from '../src/orchestrator/auditor.js';
import { runSandboxedJs } from '../src/tools/builtin.js';

test('extractCodeBlocks: separates runnable JS from pseudocode, ESM, external env, python and bash', () => {
  const md = [
    'Here is a self-contained helper:',
    '```js',
    'const nums = [1, 2, 3];',
    'const copy = [...nums, 4];',
    'console.assert(copy.length === 4, "spread works");',
    '```',
    '',
    'An ESM module:',
    '```mjs',
    'import fs from "node:fs";',
    'export function read() { return fs.readFileSync("x"); }',
    '```',
    '',
    'Browser / fetch snippet:',
    '```javascript',
    'const r = await fetch("https://example.com");',
    'document.body.textContent = await r.text();',
    '```',
    '',
    'Pseudocode with placeholder:',
    '```js',
    'function solve(x) {',
    '  // your code here',
    '  ...',
    '}',
    '```',
    '',
    'Python and bash should be ignored:',
    '```python',
    'print(1 + 1)',
    '```',
    '```bash',
    'echo "hello"',
    '```',
  ].join('\n');

  const blocks = extractCodeBlocks(md);
  assert.equal(blocks.length, 4, 'only JS/JavaScript/MJS blocks are extracted (python/bash excluded)');
  assert.equal(blocks[0].runnable, true, 'self-contained JS with spread syntax is runnable');
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[1].runnable, false, 'ESM import/export is not runnable');
  assert.equal(blocks[2].runnable, false, 'fetch/document snippet is not runnable');
  assert.equal(blocks[3].runnable, false, 'placeholder pseudocode is not runnable');
});

test('auditCodeBlocks: passes valid JS and catches SyntaxError, ReferenceError, failing console.assert, and timeout', async () => {
  const validMd = [
    '```js',
    'function fib(n) { return n <= 1 ? n : fib(n - 1) + fib(n - 2); }',
    'console.assert(fib(6) === 8, "fib(6) should be 8");',
    'console.log(fib(6));',
    '```',
    '```javascript',
    'import x from "y";',
    '```',
  ].join('\n');

  const clean = await auditCodeBlocks(validMd, { sandbox: runSandboxedJs, timeoutMs: 4000 });
  assert.equal(clean.checked, 1);
  assert.equal(clean.passed, 1);
  assert.equal(clean.failed, 0);
  assert.equal(clean.skipped, 1);
  assert.deepEqual(clean.findings, []);

  const brokenMd = [
    '```js',
    'function bad( { return 1;',
    '```',
    '```js',
    'const x = undefinedVariable + 1;',
    '```',
    '```js',
    'console.assert(2 + 2 === 5, "math mismatch");',
    '```',
    '```js',
    'while (true) {}',
    '```',
  ].join('\n');

  const broken = await auditCodeBlocks(brokenMd, { sandbox: runSandboxedJs, timeoutMs: 800 });
  assert.equal(broken.checked, 4);
  assert.equal(broken.passed, 0);
  assert.equal(broken.failed, 4);
  assert.equal(broken.findings.length, 4);
  assert.match(broken.findings[0].error, /SyntaxError/i);
  assert.match(broken.findings[1].error, /ReferenceError/i);
  assert.match(broken.findings[2].error, /AssertionError|math mismatch/i);
  assert.match(broken.findings[3].error, /timed out/i);
});

test('auditNumericProvenance: accepts grounded/formatted/percent/benign numbers and flags fabricated figures', () => {
  const sources = [
    'Goal: Summarize Q3 revenue for 2026.',
    'Task 1 output: Base revenue was $1,450 and expansion revenue was $350. Margin fraction is 0.675. Growth rate reached 18.4%.',
  ];

  const groundedSynthesis = [
    '1. In 2026, total revenue reached $1,800 (combining $1,450 base and $350 expansion across 2 lines).',
    '2. Margin stands at 67.5% (0.675), with 18.4% growth in Step 3.',
    '3. This marks the 4th consecutive quarter of positive performance.',
  ].join('\n');

  const clean = auditNumericProvenance(groundedSynthesis, sources);
  assert.equal(clean.ungrounded, 0, `expected 0 ungrounded, got ${JSON.stringify(clean.findings)}`);
  assert.ok(clean.grounded >= 4, 'grounded base, expansion, exact sum, percent, and growth');

  const fabricatedSynthesis = [
    '1. In 2026, base revenue was $1,450.',
    '2. Net profit hit $942.50 with an operating uplift of 42.7% across 3 regions.',
  ].join('\n');

  const dirty = auditNumericProvenance(fabricatedSynthesis, sources);
  assert.equal(dirty.ungrounded, 2, `expected 2 fabricated claims, got ${JSON.stringify(dirty.findings)}`);
  const values = dirty.findings.map((f) => f.value).sort((a, b) => a - b);
  assert.deepEqual(values, [42.7, 942.5]);
});

test('auditLogicChain: flags unacknowledged open protected warnings and passes when addressed', () => {
  const ledgerObj = {
    contradictions: [
      { id: 'con1', text: 'Cache eviction policy conflicts with strict write-through durability guarantee', stage: 'Critic#1' },
    ],
    unsupported_claims: [
      { id: 'uns1', text: 'Latency remains under five milliseconds at peak throughput', stage: 'Critic#1' },
    ],
  };
  const review = {
    open: [
      { id: 'con1', text: 'Cache eviction policy conflicts with strict write-through durability guarantee', confirmed: true },
      { id: 'uns1', text: 'Latency remains under five milliseconds at peak throughput' },
    ],
    dismissed: [],
  };

  const silentBrief = '# Design Brief\n\nEverything is complete and ready to deploy cleanly.';
  const miss = auditLogicChain(ledgerObj, review, silentBrief);
  assert.equal(miss.openWarnings, 2);
  assert.equal(miss.acknowledged, 0);
  assert.equal(miss.unacknowledged, 2);
  assert.deepEqual(miss.findings.map((f) => `${f.id}:${f.kind}`), ['con1:contradiction', 'uns1:unsupported_claim']);

  const honestBrief = [
    '# Design Brief',
    '## Open Issues',
    '- Issue con1 must be resolved before rollout.',
    '- Benchmark needed to verify whether latency stays under five milliseconds during peak throughput.',
  ].join('\n');
  const ok = auditLogicChain(ledgerObj, review, honestBrief);
  assert.equal(ok.openWarnings, 2);
  assert.equal(ok.acknowledged, 2);
  assert.equal(ok.unacknowledged, 0);
  assert.deepEqual(ok.findings, []);
});

test('MissionEngine integration: crashing JS block fails critique even when prose critic scores 0.95, triggering self-healing retry', async () => {
  let codeAttempts = 0;
  const { agency, cleanup } = await makeAgency((req) => {
    const sys = systemOf(req);
    const u = lastUser(req);
    if (/director of an AI agency/.test(sys)) {
      return {
        summary: 'single code task',
        tasks: [
          { id: 'code1', title: 'Write sumSquares helper', agent: 'forge_keeper', instructions: 'Write runnable JS for sumSquares', deps: [] },
        ],
      };
    }
    if (/You are Solon, a strict but fair critic/.test(sys)) {
      // Prose critic blindly rubber-stamps both attempts with 0.95!
      return { score: 0.95, pass: true, defects: [], fix: '' };
    }
    if (/reviewing your own draft/.test(sys)) {
      return { issues: [], final: '', confidence: 0.9 };
    }
    if (/Sentinel, a security reviewer/.test(sys)) {
      return { risk: 'none', findings: [] };
    }
    if (/previous attempt was rejected/.test(u)) {
      codeAttempts++;
      assert.match(u, /Code block #1 failed sandbox execution/i, 'retry prompt receives exact deterministic sandbox defect');
      return {
        thought: 'fixing ReferenceError from auditor feedback',
        final: 'Fixed implementation:\n```js\nfunction sumSquares(arr) { return arr.reduce((s, x) => s + x * x, 0); }\nconsole.assert(sumSquares([3, 4]) === 25);\nconsole.log(sumSquares([3, 4]));\n```',
        confidence: 0.9,
      };
    }
    codeAttempts++;
    return {
      thought: 'drafting code with bug',
      final: 'Implementation:\n```js\nfunction sumSquares(arr) { return arr.reduce((s, x) => s + missingVar * x, 0); }\nconsole.log(sumSquares([3, 4]));\n```',
      confidence: 0.9,
    };
  });

  try {
    const m = agency.missions.create('Write a sumSquares JS helper.');
    const done = await agency.missions.waitFor(m.id, 30000);
    assert.equal(done.status, 'completed', done.error);
    const t = done.tasks.find((x) => x.id.endsWith(':code1'));
    assert.equal(codeAttempts, 2, 'attempt 1 rejected by deterministic auditor despite 0.95 critic score');
    assert.equal(t.attempts, 2);
    assert.equal(t.status, 'done');
    assert.ok(t.score >= 0.9, 'repaired attempt passes with high score');
    assert.equal(done.result.audit.ok, true);
    const taskAudits = agency.ledger.list({ kind: 'audit.task', limit: 10 });
    assert.equal(taskAudits.length, 2);
    assert.equal(taskAudits[1].data.ok, false, 'attempt 1 audit failed');
    assert.equal(taskAudits[0].data.ok, true, 'attempt 2 audit passed');
    assert.ok(agency.ledger.verify().ok);
  } finally {
    await cleanup();
  }
});

test('MissionEngine integration: deliverable audit catches fabricated synthesis numbers, caps score, and adds Audit Notes', async () => {
  const { agency, cleanup } = await makeAgency((req) => {
    const sys = systemOf(req);
    const u = lastUser(req);
    if (/director of an AI agency/.test(sys)) {
      return {
        summary: 'gather then summarize',
        tasks: [
          { id: 't1', title: 'Gather revenue', agent: 'tycho', instructions: 'Report base revenue', deps: [] },
          { id: 't2', title: 'Gather costs', agent: 'tycho', instructions: 'Report costs', deps: [] },
        ],
      };
    }
    if (/You are Solon, a strict but fair critic/.test(sys)) {
      return { score: 0.94, pass: true, defects: [], fix: '' };
    }
    if (/reviewing your own draft/.test(sys)) return { issues: [], final: '', confidence: 0.9 };
    if (/Sentinel, a security reviewer/.test(sys)) return { risk: 'none', findings: [] };
    if (/Combine the team's verified work/.test(u)) {
      return {
        thought: 'synthesizing with hallucinated number',
        final: '# Summary\nRevenue is $1,450, costs are $400, and projected churn dropped by 42.7% saving $942.50.',
        confidence: 0.9,
      };
    }
    if (/Gather costs/.test(u)) return { thought: 'costs', final: 'Operating costs are $400.', confidence: 0.9 };
    return { thought: 'rev', final: 'Base revenue is $1,450.', confidence: 0.9 };
  });

  try {
    const m = agency.missions.create('Summarize revenue and costs.');
    const done = await agency.missions.waitFor(m.id, 30000);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.result.audit.ok, false);
    assert.equal(done.result.audit.provenanceAudit.ungrounded, 2);
    assert.ok(done.result.finalCritique.score <= 0.55, 'score capped at 0.55 on ungrounded claims');
    assert.match(done.result.deliverable, /## Audit Notes/);
    assert.match(done.result.deliverable, /42\.7%|942\.50/);
    const delivAudits = agency.ledger.list({ kind: 'audit.deliverable', limit: 5 });
    assert.equal(delivAudits.length, 1);
    assert.equal(delivAudits[0].data.ungroundedNumbers, 2);
  } finally {
    await cleanup();
  }
});

test('auditPrivateReply privacy invariant: 100% local (privacy: private, remoteCalls === 0) and zero PII in SQLite ledger', async () => {
  const PII_TASK = 'Patient Elena Vance (phone 555-0199, SSN 123-45-6789) has a $200 bill with 25% discount and 10% tax. What is the final total?';
  const routerCalls = [];
  const { agency, cleanup } = await makeAgency((req) => {
    routerCalls.push(req);
    const sys = systemOf(req);
    if (/reviewing your own draft/.test(sys)) {
      return { issues: [], final: '', confidence: 0.9 };
    }
    if (/independent local numeric checker/i.test(sys)) {
      return 'Step 1: 200 * 0.75 = 150. Step 2: 150 * 1.10 = 165.\nFINAL 165';
    }
    return {
      thought: 'answering private billing question with arithmetic error',
      final: 'For Elena Vance (555-0199, SSN 123-45-6789), the final total is $170.\n```js\nconst broken = nonExistentVar + 1;\n```',
      confidence: 0.9,
    };
  });

  try {
    // Register a remote provider to prove private audit NEVER touches remote providers.
    let remoteHits = 0;
    agency.router.addProvider({
      name: 'remote_trap',
      remote: true,
      has: () => true,
      available: async () => true,
      listModels: async () => ['scripted'],
      chat: async () => {
        remoteHits++;
        throw new Error('remote provider must never be called for private audit');
      },
    });

    const { result, meter } = await agency.router.metered(() =>
      agency.runtime.run('forge_keeper', PII_TASK, { privacy: 'private' })
    );

    assert.equal(remoteHits, 0, 'remote provider was never touched');
    assert.equal(meter.remote, 0, 'router meter confirms zero remote calls');
    assert.ok(routerCalls.length >= 2, 'agent call + local auditor numeric cross-check both ran');
    for (const req of routerCalls) {
      assert.equal(req.privacy, 'private', 'every single router call is pinned to privacy: private');
    }

    assert.match(result.final, /\*\*Local audit note:\*\*/);
    assert.match(result.final, /165/);
    assert.ok(result.confidence <= 0.45, 'confidence capped when local private audit fails');

    const [auditEntry] = agency.ledger.list({ kind: 'audit.private', limit: 5 });
    assert.ok(auditEntry, 'audit.private ledger entry recorded');
    assert.equal(auditEntry.data.ok, false);
    assert.equal(auditEntry.data.codeFailed, 1);
    assert.equal(auditEntry.data.numericChecked, true);
    assert.equal(auditEntry.data.numericAgree, false);
    assert.equal(auditEntry.data.remoteCalls, 0);
    assert.match(auditEntry.data.taskSha256, /^[0-9a-f]{64}$/);

    // Scan ENTIRE SQLite ledger table for any PII leakage!
    const allLedgerRows = agency.store.all('SELECT * FROM ledger');
    const serialized = JSON.stringify(allLedgerRows);
    for (const token of ['Elena Vance', 'Elena', 'Vance', '555-0199', '123-45-6789']) {
      assert.ok(!serialized.includes(token), `PII token "${token}" must NEVER appear in SQLite ledger`);
    }
    assert.ok(agency.ledger.verify().ok, 'hash-chained Ed25519 ledger verifies cleanly');
  } finally {
    await cleanup();
  }
});

test('ClaimAuditor.auditTask: flags tool-failure contradiction when final claims success after failed tool', async () => {
  const { agency, cleanup } = await makeAgency(() => '{}');
  try {
    const task = { id: 'ms_1:t1', mission_id: 'ms_1', title: 'Fetch data' };
    const result = {
      final: 'The tool succeeded and verified the endpoint status.',
      steps: [{ tool: 'http_get', ok: false, summary: 'HTTP 500 error' }],
    };
    const audit = await agency.auditor.auditTask(task, result);
    assert.equal(audit.ok, false);
    assert.ok(audit.scoreCap <= 0.5);
    assert.ok(audit.defects.some((d) => /unresolved tool failure/i.test(d)));

    // Honest acknowledgment passes:
    const honest = await agency.auditor.auditTask(task, {
      final: 'The http_get tool failed with an error, so the status could not be verified.',
      steps: [{ tool: 'http_get', ok: false, summary: 'HTTP 500 error' }],
    });
    assert.equal(honest.ok, true);
  } finally {
    await cleanup();
  }
});

test('LogicChain integration: attaches auditLogicChain result and ledgers audit.logic_chain', async () => {
  const { agency, cleanup } = await makeAgency((req) => {
    const sys = systemOf(req);
    if (/design relay/.test(sys)) {
      return {
        new_logic: ['Use hash-chained ledger'],
        improved_logic: [],
        contradictions: ['Write-through cache contradicts async batching'],
        implementation_steps: ['Implement store'],
        test_cases: ['Verify hash chain'],
        unsupported_claims: [],
        remaining_dependencies: [],
      };
    }
    if (/Write a design brief/.test(sys)) {
      return '# Summary\nAll components are straightforward and complete.';
    }
    return { votes: [] };
  });
  try {
    const out = await agency.logicChain.run('Design an audit store', { missionId: 'ms_lc1' });
    assert.ok(out.audit, 'logicChain.run attaches audit object');
    assert.equal(out.audit.openWarnings, 1);
    assert.equal(out.audit.unacknowledged, 1);
    const [entry] = agency.ledger.list({ kind: 'audit.logic_chain', limit: 5 });
    assert.ok(entry, 'audit.logic_chain ledger entry recorded');
    assert.equal(entry.data.missionId, 'ms_lc1');
    assert.equal(entry.data.unacknowledged, 1);
    assert.ok(out.score <= 0.55, 'unacknowledged open warnings penalize LogicChain score');
    assert.match(out.brief, /Unacknowledged Open Warnings/i);
  } finally {
    await cleanup();
  }
});

test('red-team regressions (P22-1..P22-4): VM network isolation, frozen assert, numbersAgree, provenance FP/FN, null safety', async () => {
  // P22-1: Frozen console.assert cannot be overridden, and fetch/process are absent inside VM context.
  const bypassAssert = await auditCodeBlocks('```js\ntry { console.assert = () => {}; } catch {}\nconsole.assert(2 + 2 === 5, "boom");\n```');
  assert.equal(bypassAssert.failed, 1, 'console.assert override must not bypass assertion check');

  const noNet = await auditCodeBlocks('```js\nconsole.assert(typeof globalThis["fe" + "tch"] === "undefined", "net leaked");\nconsole.assert(typeof globalThis["pro" + "cess"] === "undefined", "proc leaked");\n```');
  assert.equal(noNet.checked, 1);
  assert.equal(noNet.passed, 1, `VM context must not expose fetch/process: ${JSON.stringify(noNet.findings)}`);

  // P22-1b: Host-realm escape via console.assert.constructor('return process/fetch')() fails cleanly.
  const hostEscape = await auditCodeBlocks([
    '```js',
    'const F = console.assert.constructor;',
    'let escaped = false;',
    'try { if (typeof F("return fe" + "tch")() === "function") escaped = true; } catch {}',
    'try { const p = F("return pro" + "cess")(); if (p) p.exit(0); } catch {}',
    'console.assert(!escaped, "host realm escaped");',
    'console.assert(2 + 2 === 5, "must still fail");',
    '```',
  ].join('\n'));
  assert.equal(hostEscape.failed, 1, 'host-realm escape must not bypass console.assert or access process/fetch');

  // P22-2: numbersAgree rejects 1 vs 0.6 and 0.6 vs 0.55.
  const { numbersAgree } = await import('../src/orchestrator/auditor.js');
  assert.equal(numbersAgree(1, 0.6), false);
  assert.equal(numbersAgree(0, 0.49), false);
  assert.equal(numbersAgree(0.6, 0.55), false);
  assert.equal(numbersAgree(51, 51.3), true);

  // P22-3: Provenance allows pair differences, 3-term sums, derived %, SHA-256, May 25; catches integer-1 $100 fabrication.
  const cleanDerived = auditNumericProvenance(
    'On May 25, 2026, SHA-256 verified net profit was $830, total revenue across regions was $600, with an 8% escalation rate (100% local).',
    ['Revenue $1,450 and costs $620. Regional sales: $100, $200, $300. Tickets: 184 resolved, 16 escalated.'],
  );
  assert.equal(cleanDerived.ungrounded, 0, `benign derived figures falsely flagged: ${JSON.stringify(cleanDerived.findings)}`);

  const fab100 = auditNumericProvenance(
    'The verified savings reached $100.',
    ['Step 1 completed with status ok.'],
  );
  assert.equal(fab100.ungrounded, 1, 'integer 1 in source must NOT ground fabricated $100');

  // P22-4: Null-safety on malformed inputs and word-boundary matching in auditLogicChain.
  const auditor = new ClaimAuditor();
  const nullTask = await auditor.auditTask(null, { final: 'ok', steps: [null] });
  assert.equal(nullTask.ok, true);
  const nullDeliv = await auditor.auditDeliverable('goal', 'clean summary', 'not-an-array');
  assert.equal(nullDeliv.ok, true);
  const lcSub = auditLogicChain({ contradictions: 'bad' }, { open: [{ id: 'con1', text: 'rate limit broken' }] }, 'The modules are separate and solid.');
  assert.equal(lcSub.unacknowledged, 1, '"rate" must not match substring inside "separate"');
});
