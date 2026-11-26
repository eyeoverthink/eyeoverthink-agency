# Phase 22: Deterministic Claim-and-Evidence Auditor (Missions, LogicChain & Private Work)

Previous: [Phase 21](PHASE-21.md) · Next: [Phase 23](PHASE-23.md) · [Index](README.md)

> Built on the `phase-22-claim-auditor` branch from `phase-20-program-judge`. `master` stays untouched (`contest-freeze`).

## The problem
Phases 17–20 made direct `privacy: "normal"` numeric replies strongly verified, leaving four major surfaces relying on prose alone:
1. **`MissionEngine.#critique` and `#finish`** judged tasks and synthesized deliverables using a single prose critic (`solon` / `hermes3:latest`), which routinely passed crashing JavaScript code blocks and subtle assertion failures.
2. **Synthesis numeric fabrication:** Lumen could introduce ungrounded figures absent from upstream task outputs or tool evidence without deterministic detection.
3. **`LogicChain` brief synthesis:** Open protected warnings (`contradictions` and `unsupported_claims`) could be omitted from the final brief with no score penalty.
4. **Private and sealed replies (`src/agents/runtime.js:262`):** Because `checkAnswer` only runs for `privacy === 'normal'`, the user's most sensitive `private` and `sealed` tasks received zero automated verification.

## The design
Added `src/orchestrator/auditor.js` (`ClaimAuditor`, zero runtime dependencies, 100% local `privacy: 'private'`) wired into `MissionEngine`, `LogicChain`, and `AgentRuntime`:
1. **Double-isolated JS code-block auditing (`extractCodeBlocks`, `auditCodeBlocks`):**
   - Extracts self-contained fenced `js`/`javascript`/`mjs` blocks (skipping empty, >32 KB, ESM, external I/O/DOM/`process`/`fetch`, and pseudocode blocks; capped at 10 runnable blocks per deliverable).
   - Executes each block inside `runSandboxedJs` (`node --permission --max-old-space-size=128`) **and** a clean `vm.createContext(Object.create(null))` with zero host-realm objects/functions, host `fetch`/`WebSocket`/`XMLHttpRequest`/`EventSource`/`process.getBuiltinModule` neutralized, dynamic `import()` disabled, and a VM-realm frozen, non-writable/non-configurable `console.assert` that throws `AssertionError` on falsy checks.
2. **Numeric provenance auditing (`auditNumericProvenance`):**
   - Extracts numeric claims from synthesis prose (masking code fences, URLs, hashes, ISO dates/times, technical identifiers like `SHA-256`/`HTTP 404`, month-day dates, ordinals, list indices, years, and counts `0..12`).
   - Grounds figures matching upstream sources within tolerance, proper fraction/percent equivalents (`0 < |s| < 1`), pair sums/differences, small 3-term sums, and derived percentage ratios. Flags remaining ungrounded figures and caps deliverable score (`<= 0.55`).
3. **Mission self-healing & `LogicChain` accountability:**
   - In `MissionEngine.#critique`, failing code blocks or unresolved tool-failure contradictions cap `score <= 0.45`/`0.50`, force `pass: false`, and prepend exact sandbox errors so `#runTask`'s retry loop fixes the bug.
   - In `MissionEngine.#finish`, `auditDeliverable` attaches `result.audit`, caps score on hard defects, and appends `## Audit Notes` when defects remain.
   - In `LogicChain.run`, `auditLogicChain` checks every open protected warning by warning ID or `>= 2` word-boundary content tokens; unacknowledged warnings cap `score <= 0.55` and append `## Unacknowledged Open Warnings (Auditor)` to the brief.
4. **Local-only private/sealed reply auditing (`auditPrivateReply`):**
   - Runs in `AgentRuntime.run` for `privacy: 'private' | 'sealed'` (non-seeded, non-mission, `check !== false`): runs local `auditCodeBlocks` (0 GPU) plus a single strictly local (`privacy: 'private'`) numeric cross-check on quantitative tasks (`>= 2` numbers).
   - Measures actual `remoteCalls` via the enclosing `AsyncLocalStorage` meter (`router.meters.getStore()` / `router.metered()`), never hardcoding `0`, and ledgers ONLY `{ agentId, privacy, taskSha256, ok, codeChecked, codeFailed, numericChecked, numericAgree, remoteCalls }` — zero raw task/reply text or PII.
   - Ledger events: `audit.task`, `audit.deliverable`, `audit.logic_chain`, `audit.private`.

## Measured on real local models
Measured locally on RTX 3070 8 GB (`hermes3:latest`, `qwen2.5-coder:7b`, `fraymus-prime:v1`, `cloudJudge: false`, `edge: { enabled: false }`) via `scripts/measure-phase22-auditor.mjs`.

### Suite 1 — 12 Deliverables (4 broken JS, 4 numeric fabrications, 4 clean controls)
| Evaluator | Overall Defect Recall (8) | Broken JS Recall (4) | Numeric Fabrication Recall (4) | False Positives (4 clean) | Mean Latency |
|---|---:|---:|---:|---:|---:|
| Baseline prose critic (`hermes3:latest`) | 6/8 (**75.0%**) | 2/4 (**50.0%**) | 4/4 (100%) | 2/4 | 1,772 ms |
| **`ClaimAuditor` alone (deterministic)** | **8/8 (100%)** | **4/4 (100%)** | **4/4 (100%)** | **0/4 (0%)** | **60 ms** |
| Combined (critic + `ClaimAuditor`) | **8/8 (100%)** | **4/4 (100%)** | **4/4 (100%)** | 2/4 (both from prose critic) | — |

The baseline prose critic scored `0.9 (pass)` on both `code_assert_fail` (wrong additive discount formula) and `code_type_err` (`dollars.trimLeftSpaces is not a function`); `ClaimAuditor` caught both deterministically in ~118 ms.

### Suite 2 — 3 Live Self-Healing Code Tasks (`forge_keeper` / `qwen2.5-coder:7b`)
| Task | Attempt 1 Defect Caught by Auditor | Attempt 2 Repaired & Passed | Repair Time |
|---|---|---|---:|
| `heal_palindrome` | `ReferenceError: inputStr is not defined` | **PASS** (1/1 block) | 8.96 s |
| `heal_discount` | `AssertionError: expected 135` | **PASS** (1/1 block) | 4.88 s |
| `heal_flatten` | `SyntaxError: Unexpected end of input` | **PASS** (1/1 block) | 5.11 s |

**Result:** **3/3 (100%)** repaired on retry.

### Suite 3 — 4 `private` / `sealed` Tasks with Synthetic PII
- All 4 tasks (`priv_math_1`, `priv_code_2`, `sealed_math_3`, `sealed_code_4`) completed with `audit.private` recorded (`numericChecked: true, numericAgree: true` on both math tasks; `codeChecked: 1, codeFailed: 0` on both code tasks).
- **`totalRemoteCalls = 0`** (16 local calls total), **`piiLeakedToLedger = 0`** across 47 scanned ledger entries, **`ledgerVerifyOk = true`**.
- Honest note: all 4 local answers happened to be correct in Suite 3 (`defectsCaughtLocally = 0` in that live run; defect catching under `private` mode is verified deterministically in `test/auditor.test.js` and Suites 1–2).

Evidence: [evidence-phase22-auditor.json](evidence-phase22-auditor.json).

## Tests
**168 tests pass** (`npm test`), including 10 new tests in `test/auditor.test.js`:
- `extractCodeBlocks` filtering (ESM, external env, pseudocode, non-JS);
- `auditCodeBlocks` (valid JS, `SyntaxError`, `ReferenceError`, failing `console.assert`, timeout);
- `auditNumericProvenance` (grounded, formatted, percent/fraction, derived diff/sum/%, fabricated figures);
- `auditLogicChain` (unacknowledged open warnings, word-boundary matching, score cap + appended brief warnings);
- `MissionEngine` self-healing retry even when prose critic scores `0.95`;
- `MissionEngine` deliverable fabrication audit + `## Audit Notes`;
- `auditPrivateReply` privacy invariant (`privacy: 'private'`, `remoteCalls === 0`, zero PII in SQLite ledger);
- `auditTask` unresolved tool-failure contradiction;
- Red-team regressions (frozen `console.assert`, VM network/process isolation, `console.assert.constructor('return process')()` host-realm escape blocked, strict `numbersAgree(1, 0.6) === false`, integer-1 `$100` false-negative guard, null safety).

## Known limits
- **Runnable JS only:** Code execution covers self-contained JavaScript blocks; Python, shell, and ESM/network snippets are intentionally skipped (`runnable: false`).
- **Heuristic provenance:** Complex multi-step calculations (e.g., 4+ term sums or nonlinear formulas) not stated in upstream task outputs may still be flagged as ungrounded unless the upstream task records intermediate results.
- **Single local numeric cross-check on private work:** `auditPrivateReply` uses 1 independent local check voice (not full 2-of-3 N-version voting) to keep interactive private latency reasonable (~6–16 s); disagreement appends a `**Local audit note:**` and caps confidence `<= 0.45` rather than overwriting the answer.
