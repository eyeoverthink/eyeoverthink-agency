# Phase 21: Metamorphic & Representation-Diverse Program Judging

Previous: [Phase 20](PHASE-20.md) · Next: [Phase 22](PHASE-22.md) · [Index](README.md)

> Built on the `phase-21-metamorphic-judge` branch from `phase-20-program-judge`. `master` stays untouched (`contest-freeze`).

## The problem
Phase 20 (`docs/phases/evidence-phase20-program-v2.json`) proved that N-version programming achieved 0 wrong answers on the 13-task hard set (69.2%, 4 silent), but hit **3 wrong answers and 7 silences on the standard 40 tasks (75.0%)**. All 3 wrong answers and 6 of 7 silences were round-trip speed problems where two different models received the same prompt and emitted the exact same algebraic mistake (`1 / (1/v1 + 1/v2)` instead of `2 / (1/v1 + 1/v2)`), violating elementary mathematical invariants (`min(v1,v2) <= out <= max(v1,v2)` and `solve(v, v) === v`).

Auditing Phase 20 also uncovered 5 judge/crystallizer bugs:
1. `programVoice` never verified that two agreeing votes came from distinct `model` identities.
2. `nearAnswer` allowed `dec = 0/1` rounding to equate wildly different small numbers (`nearAnswer(0.6, 1) === true`).
3. `inTask` filtering discarded explicit `FINAL <n>` answers whenever the true answer happened to equal a number stated in the task.
4. `#voices()` sliced local voices to 3 before removing `firstId`, dropping the 4th local voice when Gemini was offline.
5. `correctAnswer()` ignored 4th+ voices (`v.extra`) and lacked Phase 20's `pctTask` fraction/percent equivalence.

## The design
1. **Metamorphic & domain invariant verifier (`src/evolve/invariants.js`, zero deps):**
   - `extractTaskInvariants(task)` classifies tasks into `round_trip_average` (Cauchy bounds, equal-input idempotence `solve(v,v) === v`, symmetry, scaling), `parallel_work_rate` (faster-than-fastest, equal-worker halving, symmetry — guarded against drains/leaks/job multipliers), `sequential_percent` (non-negativity, discount price bounds, zero-discount identity — guarded against quantities/tax/reverse-discount), `weighted_average_mixture` (convex hull), and `general_numeric` (determinism, non-constant sensitivity across +10%, integer +1, and 2× probes).
   - `checkProgramInvariants(program, params, task)` runs the original call plus all applicable metamorphic probes in **one** batched sandbox subprocess (~40 ms, 0 GPU calls), double-isolated via `node --permission` + `vm.createContext(Object.create(null))` (zero host-realm objects/functions, host `fetch`/`WebSocket`/`process.getBuiltinModule` neutralized, per-call random 96-bit stdout marker nonce scanned from the end).
2. **Representation-diverse prompts & pre-vote vetoing (`src/evolve/program-voice.js`):**
   - Three distinct `ROLE_PROMPTS`: `code` (first-principles concrete simulation), `reason` (algebraic derivation from definitions), `plan` (dimensional/unit decomposition), requesting parameterized `function solve(...)` + grounded `params` (with backward-compatible parameterless fallback still subject to output-only domain bounds).
   - `paramsGrounded()` verifies every param against task numbers/word-numbers (with `Object.create(null)` and percent-only `v*100`/`v/100` scaling, capped at 24 params).
   - Every candidate vote runs `checkProgramInvariants` BEFORE voting; vetoed votes cannot form an agreeing pair and are ledgered as `program.veto` (`taskSha256`, role, model, invariant, detail — never raw task text).
   - `pair()` enforces distinct `model` identities across agreeing votes.
3. **Judge & Crystallizer fixes (`src/evolve/crystallizer.js`, `src/agency.js`):**
   - Tightened `nearAnswer` (`<= 2%` relative error when `dec < 2`), added `extractAnswerNumber` honoring uppercase `FINAL` / `**Answer:**` before `inTask` filtering, removed premature `#voices().slice(0, 3)`, updated `correctAnswer()` to inspect `v.extra` and `pctTask`, and wired `ledger` + `taskSha256` into `Agency.programAnswer`.

## Measured on real local models
Measured locally on RTX 3070 8 GB (`qwen2.5-coder:7b`, `fraymus-prime:v1`, `hermes3:latest`, `cloudJudge: false`, `edge: { enabled: false }`) via `scripts/measure-phase21-metamorphic.mjs --suite all`.

### 0-GPU Reference Check (False-Veto Guard)
- **10/10** ground-truth reference functions across all invariant families and negative edge cases (drains, reverse discounts, dilution, 4-arg trips, combinatorics) passed with **`falseVetoCount = 0`**.

### Live Local Ollama Results (65 Tasks Total)
| Suite | Items | Right | **Wrong** | Silent | Vetoes | Distinct-Model Violations | Remote Calls | Avg Sec |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Standard 40 (Phase 20 baseline)** | 40 | 30 (75.0%) | **3 (7.5%)** | 7 | — | — | 0 | 13.4 |
| **Standard 40 (Phase 21)** | 40 | 30 (75.0%) | **0 (0.0%)** | 10 | **18** | 0 | 0 | 15.39 |
| **Hard 13 (Phase 20 baseline)** | 13 | 9 (69.2%) | 0 (0.0%) | 4 | — | — | 0 | 20.0 |
| **Hard 13 (Phase 21)** | 13 | **10 (76.9%)** | **0 (0.0%)** | 3 | **1** | 0 | 0 | 207.64* |
| **Adversarial 12 (held-out traps)** | 12 | 9 (75.0%) | **0 (0.0%)** | 3 | **8** | 0 | 0 | 15.49 |
| **Phase 21 Combined** | **65** | **49 (75.4%)** | **0 / 65 (0.0%)** | **16** | **27** | **0** | **0** | — |

*\*Note on Hard 13 latency: two tasks (`hard 11/13` = 2110 s, `hard 12/13` = 429 s) hit temporary external GPU contention on the shared Ollama server; the other 11 hard tasks averaged **13.5 s**.*

### Honest reading of what worked and what didn't
- **What worked (epistemic safety):** Wrong answers dropped from **3/40 → 0/40** on the Standard set, and stayed **0/13** on Hard and **0/12** on fresh Adversarial traps (**0 wrong in 65 tasks total**). Twenty-seven broken local programs were vetoed before voting (`cauchy_bounds`, `equal_input_idempotence`, `faster_than_fastest`, etc.). Hard 13 rose from **69.2% → 76.9%** (+7.7 pp).
- **What didn't reach target (honest partial negative):** Standard 40 accuracy stayed flat at **75.0% (30/40)** rather than reaching the Architect's `>= 85%` stretch goal. Inspecting `evidence-phase21-metamorphic.json` shows why: `qwen2.5-coder:7b` (`code`) frequently produced the exact right answer using first-principles simulation (e.g., Standard task 1: `8`), while BOTH `fraymus-prime:v1` (`reason`, `32`) and `hermes3:latest` (`plan`, `4`) still wrote broken formulas and were cleanly vetoed — leaving only 1 surviving program, so the 2-of-3 rule rightly abstained (`silent: 7 → 10`). **Metamorphic invariants reliably converted correlated errors into honest silence**, while representation-diverse prompting alone was not enough to make `fraymus-prime:v1` and `hermes3:latest` consistently write correct harmonic-mean code.

Evidence: [evidence-phase21-metamorphic.json](evidence-phase21-metamorphic.json).

## Tests
**163 tests pass** (`npm test`), including 5 comprehensive test groups in `test/invariants.test.js`:
- `extractTaskInvariants` classification and false-positive guards across all 5 families;
- `checkProgramInvariants` vetoing Phase 20's `1/(1/v1+1/v2)` bug, parallel-work `t1+t2`, constant, and non-deterministic programs;
- `programVoice` representation-diverse `ROLE_PROMPTS`, vetoed-pair fallback to 3rd program, correlated-bug silence, distinct-model enforcement, and `program.veto` / `judge.program` ledgering;
- All 4 `crystallizer.js` auditor fixes (`nearAnswer(0.6, 1) === false`, `extractAnswerNumber` on `FINAL 10`, `#voices()` keeping 4th local voice, `correctAnswer()` honoring `v.extra` + `pctTask`);
- Red-team regressions (VM host-realm escape `console.log.constructor('return fetch')()`, harness marker forgery, lowercase prose `"final 20%"`, boat+current / unit conversion / quantity discount / floor-step false-positive guards, `paramsGrounded` prototype & non-percent scaling guards).

## Known limits
- **Silence tradeoff when 2 of 3 models are vetoed:** Eliminating correlated wrong answers increased Standard 40 silences from 7 → 10 because vetoed models are not yet given a single invariant-feedback repair retry (a natural next step: passing `"Your program failed equal_input_idempotence: solve(10,10)=5 != 10"` back to the vetoed role once).
- **Domain scope:** Metamorphic probes cover round-trip averages, parallel work rates, sequential percentages, weighted averages/mixtures, and general determinism/sensitivity; other math classes only get general probes.
- **Numeric-only:** Like Phase 20, `programVoice` handles single numeric answers only.
