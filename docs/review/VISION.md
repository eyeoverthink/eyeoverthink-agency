# Vision & Architecture Ranking — Beyond Phases 1–20 (`eyeoverthink-agency`)

> Grounded in direct source inspection of `phase-20-program-judge` and real-model evidence in `docs/phases/PHASE-17..20.md`. All proposals preserve zero runtime dependencies in `src/`, free local-first execution (RTX 3070 8 GB Ollama), the Privacy Membrane, and `ONLY_ON_DEVICE`.

---

## Part 1 — All 9 Visionary Proposals

### P1. Metamorphic & Representation-Diverse Program Judging
- **Why it matters:** Phase 20 (`evidence-phase20-program-v2.json`) hit 30/40 (75%) on the standard set with **3 wrong** and **7 silent**. All 3 wrong answers and 6 of 7 silences were round-trip speed tasks where two different models received the same prompt and emitted the exact same algebraic bug: `1 / (1/v1 + 1/v2)` instead of `2 / (1/v1 + 1/v2)`. Every correlated wrong answer violated elementary invariants (`min(v1,v2) <= out <= max(v1,v2)` and equal-input idempotence `solve(v, v) === v`).
- **Builds on:** `src/evolve/program-voice.js` (`programVoice`, `programsAgree`, `normalizeProgram`), `src/evolve/binder-induction.js` (`numberTokens`), `src/tools/builtin.js` (`runSandboxedJs`), `src/evolve/crystallizer.js` (`#judge`, `correctAnswer`, `#voices`, `nearAnswer`), `src/agency.js` (`programAnswer`).
- **Smallest testable first step:** Add `src/evolve/invariants.js` with parameterized `function solve(...)` contracts, 3 representation-diverse prompts (`code`: first-principles simulation, `reason`: algebraic derivation, `plan`: dimensional unit decomposition), 0-GPU batched metamorphic probes (Cauchy bounds, equal-input idempotence, symmetry, scaling, parallel-work halving, non-constant sensitivity) vetoing broken programs before voting, plus enforcing distinct `model` identities across agreeing votes.
- **How to measure success:** Re-run Phase 20's exact 40 standard tasks + 13 hard tasks + 12 held-out adversarial tasks on local Ollama; target wrong rate `3/40 → <= 1/40` (ideally `0`), standard accuracy `75% → >= 85%`, hard accuracy `>= 69.2%`, and `0` false vetoes on valid reference programs.

### P2. Single-Model Proof-Carrying Verification (Witness Programs & Verified Computation Cache)
- **Why it matters:** `programVoice` averages 13.4–20.0 s (2–3 sequential GPU calls on 8 GB VRAM), and a lone correct program cannot break a 4-way split (`PHASE-20.md:127–129`). Many tasks have asymmetric inverse/conservation checks (e.g., plugging `t=3` back into `3/4 + 3/6 - 3/12 === 1`).
- **Builds on:** `src/evolve/program-voice.js`, `src/evolve/binder-induction.js` (`shapeOf`, `wordingOf`, `novelWording`), `src/evolve/crystallizer.js` (`#judge`, `checkAnswer`), `src/llm/router.js` (`metered`).
- **Smallest testable first step:** 3-tier verification cascade (`src/evolve/witness-verifier.js`): Tier 0 verified-wording template cache (~50 ms, 0 GPU), Tier 1 single-model `solve` + inverse `verify` with anti-tautology similarity check + 3 perturbed decoy rejections (~6 s, 1 GPU), Tier 2 fallback to N-version `programVoice`.
- **How to measure success:** ≥35% GPU call reduction and ≤7.5 s median latency on Standard 40 with zero increase in wrong-answer rate (falsified if ≥2 wrong answers falsely certify).

### P3. Typed Multi-Domain Skills, Binders & Differential Verification (`datetime`, `structured`, `text`)
- **Why it matters:** Phases 9–20 are locked inside a single-number cage (`typeof out === 'number'`, `skill_gaps.answer REAL NOT NULL`, numeric `binder-induction.js`), even though `Crystallizer.sameOutput` already handles deep JSON equality and `Examiner.answerKey` already supports `yesno` and `text`.
- **Builds on:** `src/evolve/binder-induction.js`, `src/evolve/crystallizer.js` (`sameOutput`, `groundingProblem`, `crystallize`), `src/evolve/program-voice.js`, `src/core/util.js` (`canonical`), `src/storage/db.js` (`skill_gaps`, `skill_chains`).
- **Smallest testable first step:** `src/evolve/typed-values.js` + `entityTokens()` (`iso_date`, `time_hhmm`, `fenced_block`, `quoted`, `code_id`) enabling zero-call induced binders and JSON-canonical differential testing for `datetime` and `structured` (CSV/JSON) tasks.
- **How to measure success:** 30-task multi-domain local Ollama benchmark (`datetime`, `structured`, `text`): ≥80% typed `programVoice` accuracy (≤1/30 wrong) and ≥12/15 fresh paraphrases answered at 0 model calls with 0 misroutes on 9 near-miss controls.

### P4. Self-Directed Epistemic Curriculum (Dreamer + Red Queen + 1-Shot Gap Amplification)
- **Why it matters:** `skill_gaps` requires 3 live user refusals before calling `learnGap`; `Examiner.propose` invents random questions ignoring actual mission failures (`tasks.score < 0.7`, `answer.check` splits, `skill.route_rejected`); `Dreamer` distills prose lessons without verifying executable skills; and voice routing averages accuracy globally rather than per domain.
- **Builds on:** `src/dream/dreamer.js` (`#cluster`, `cycle`), `src/evolve/examiner.js` (`propose`, `trial`), `src/evolve/evolution.js` (`run`, `validateHoldout`), `src/evolve/crystallizer.js` (`gaps`, `learnGap`, `#probationTrial`), `src/evolve/program-voice.js`.
- **Smallest testable first step:** Opt-in idle `src/evolve/curriculum.js` mining strictly `privacy = 'normal'` failure clusters, amplifying 1-shot gaps into `programVoice`-verified practice tasks (crystallized strictly into `status = 'probation'`), and feeding defect clusters to targeted `Examiner.propose({ focus })` with immediate abort on live mission creation.
- **How to measure success:** Controlled A/B vs blind Red Queen under equal GPU budget on untouched held-out items + ≥2/3 1-shot gaps promoted via real probation trials without holdout regression.

### P5. Deterministic Claim-and-Evidence Auditor (Missions, `LogicChain`, `Consensus`, & Private Work)
- **Why it matters:** `AgentRuntime.run` (`src/agents/runtime.js:262`) skips verification for all missions and all `private`/`sealed` tasks. `MissionEngine.#critique` and `#finish` (`src/orchestrator/missions.js:257–305`) rely solely on a single prose critic (`solon`), allowing crashing JS code blocks and fabricated synthesis numbers to pass unchecked, while `LogicChain` synthesis can silently omit open protected contradictions.
- **Builds on:** `src/orchestrator/missions.js` (`#critique`, `#runTask`, `#finish`), `src/orchestrator/logic-chain.js` (`review`, `synthesize`, `PROTECTED`), `src/agents/runtime.js` (line `262`), `src/tools/builtin.js` (`runSandboxedJs`), `src/agency.js`.
- **Smallest testable first step:** Local-only `src/orchestrator/auditor.js` (`ClaimAuditor`, `privacy: 'private'`, `meter.remote === 0`) verifying runnable JS code blocks in `runSandboxedJs`, auditing numeric provenance across synthesis vs upstream sources, guarding `LogicChain` open contradictions, capping `#critique` score to trigger self-healing retries, and auditing `private`/`sealed` replies locally.
- **How to measure success:** Injected-defect suite (8 defective + 4 clean controls) comparing baseline prose critic vs `ClaimAuditor` (target ≥87.5% recall, 0/4 false positives), 3 live self-healing code-repair missions, and 4 `private`/`sealed` tasks with `remoteCalls === 0` and `0` PII leaked to ledger.

### P6. Privacy-Membrane Gossip Sync for Signed Memories & Dreamer Lessons (Merkle Anti-Entropy)
- **Why it matters:** Signed memories (`src/memory/memory.js`) and Dreamer lessons (`src/dream/dreamer.js`) are siloed per agency; `memory.share` is manual, one-shot, and lacks a Privacy Membrane egress check.
- **Builds on:** `src/protocols/mesh.js`, `src/memory/memory.js`, `src/core/ledger.js` (`merkleRoot`), `src/guard/membrane.js`, `src/guard/sentinel.js`.
- **Smallest testable first step:** `src/protocols/gossip.js` implementing 16-bucket prefix Merkle digests (`memory.digest` / `memory.hashes` / `memory.batch`) over opt-in `shareable = 1` semantic/fact memories, Membrane + Sentinel egress filtering, `peer_probation` quarantine excluded from `contextPack()` until 2 distinct trusted peers corroborate or operator promotes.
- **How to measure success:** 3-agency local HTTP mesh (`A ↔ B ↔ C`) with 12 clean lessons + 6 private/PII/governance/injection traps: 12/12 convergence, 0/6 trap leaks, <1.5 KB steady-state round, positive quiz lift without `SUITES.core` regression.

### P7. Multi-Turn On-Device Sessions with Privacy-Locked Compaction & Persistent `SealSession`
- **Why it matters:** `web/src/hybrid.ts` flattens single turns, `EdgeHub` lacks worker affinity, and `server.js:245` deletes `SealSession` after one reply (breaking cross-turn placeholder stability `⟦PERSON_1⟧`).
- **Builds on:** `src/llm/edge.js`, `src/llm/router.js`, `src/guard/membrane.js` (`SealSession`), `src/agents/runtime.js` (`#compact`), `web/src/{hybrid,edge,main}.ts`.
- **Smallest testable first step:** `src/llm/sessions.js` with immutable privacy lock, rolling compaction preserving pinned facts + last 4 turns, persistent RAM `SealSession`, worker affinity, and multi-turn chat UI in `viewEdge()`.
- **How to measure success:** 12-turn stateful constraint-retention benchmark on local 3B/8B Ollama (≥+25 pp retention over sliding-window truncation, flat prompt token curve, 0 `IN_CLOUD` private turns, 100% sealed placeholder consistency).

### P8. Zero-Dep Interactive Visual Workflow Canvas & Live SSE Execution Inspector
- **Why it matters:** `web/src/main.ts:826–856` renders expressive parallel branching workflows as a flat 1-D flex strip edited via raw JSON textarea and ignores live `workflow.node` SSE events.
- **Builds on:** `src/workflows/engine.js` (`NODE_TYPES`, `validateWorkflow`, `workflow.node`), `src/server/server.js`, `web/src/main.ts` (`dagSvg`, `onEvent`).
- **Smallest testable first step:** Zero-dep SVG/Pointer-Event canvas `web/src/workflow-canvas.ts` with topological layout, port-to-port wiring, cycle + `private → normal` privacy-downgrade linter (`POST /api/workflows/validate`), live SSE node states, and inline `human_gate` Approve/Deny.
- **How to measure success:** 100% round-trip fidelity across all 5 `SEED_WORKFLOWS`, 100% SSE-vs-SQLite state match on a 6-node live Ollama workflow, 0 private preview leaks over SSE, 0 new npm dependencies.

### P9. Cross-Agency Immune System (Verified Skill Revocation & Peer Reputation)
- **Why it matters:** Phases 15–16 let agencies share skills as signed plasmids, but revocation is strictly solitary: once a subtly defective or crashing skill is adopted on peers, peers keep executing it with zero-call binders, and `peers.trust` has no empirical reputation memory. Meanwhile `openPlasmid` (`src/core/dna.js:226`) skips signature verification when `sig` is omitted (Audit C2).
- **Builds on:** `src/protocols/mesh.js`, `src/core/dna.js` (`openPlasmid`), `src/evolve/crystallizer.js` (`retire`, `retireBinder`, `importSkill`, `groundingProblem`), `src/evolve/program-voice.js`, `src/guard/membrane.js` (`detect`), `src/storage/db.js`.
- **Smallest testable first step:** Fix `openPlasmid` signature bypass; add `src/protocols/immune.js` + DB migration v9 (`skill_advisories`, `peers.rep_confirmed`, `peers.rep_false_flags`); emit Membrane-guarded signed `skill.advisory` keyed by `code_sha256`; receivers **never revoke on rumor** — they reproduce locally in `runSandboxedJs` (0 GPU for crashes) or local `programVoice` (semantic bugs), quarantine confirmed defects + retire binders + block re-import, and auto-demote Byzantine peers (`trusted → known`) after ≥2 false flags.
- **How to measure success:** 4-agency real HTTP mesh (`A, B, C, D`) + local Ollama `programVoice`: 2/2 crash containment at 0 GPU calls, 2/2 semantic bug containment + re-import block, 0 false quarantines + 2/2 Byzantine peer auto-demotions, unsigned plasmid rejected, PII advisory blocked.

---

## Part 2 — Chief Architect Ranking (Value ÷ Risk)

| Rank | ID | Proposal | Value (1–10) | Risk / Effort (1–10) | Value ÷ Risk | Rationale |
|---:|---|---|---:|---:|---:|---|
| **1** | **P1** | **Metamorphic & Representation-Diverse Program Judging** | **9** | **3** | **3.00** | Directly breaks Phase 20's correlated-failure ceiling (`30/40` std, `9/13` hard) via parameterized `solve(...)` + 0-GPU metamorphic vetoes + diverse prompts, while closing 5 High Auditor bugs in `program-voice.js`/`crystallizer.js` with zero DB migrations. |
| **2** | **P9** | **Cross-Agency Immune System (Verified Revocation & Reputation)** | **9** | **4** | **2.25** | Completes Phases 15–16's skill mesh with Byzantine-tolerant locally-verified revocation (`code_sha256` -> sandbox/`programVoice`, never rumor), fixes Critical `openPlasmid` signature bypass, and measures cleanly on a 4-agency local HTTP mesh. |
| **3** | **P5** | **Deterministic Claim-and-Evidence Auditor (Missions & Private Work)** | **8** | **4** | **2.00** | Extends local-only deterministic verification (`meter.remote === 0`) to multi-step missions, runnable JS blocks, synthesis provenance, `LogicChain` contradictions, and unchecked `private`/`sealed` replies with zero DB migration and zero file overlap with P1/P9. |
| 4 | P6 | Privacy-Membrane Gossip Sync for Signed Memories | 8 | 4 | 2.00 | Strong Merkle anti-entropy + quarantine design, but overlaps `mesh.js` with P9; ideal Phase 25 candidate atop P9's peer reputation table. |
| 5 | P3 | Typed Multi-Domain Skills, Binders & Verification | 9 | 5 | 1.80 | Strategically vital to escape single numbers, but heavily overlaps `crystallizer.js`/`program-voice.js` with P1; ideal Phase 24 atop P1. |
| 6 | P8 | Zero-Dep Interactive Visual Workflow Canvas | 6 | 4 | 1.50 | Great operator UX and privacy linter, but frontend tooling rather than core epistemic/sovereign verification advance. |
| 7 | P2 | Single-Model Witness Verification & Cache | 7 | 5 | 1.40 | Cuts latency, but same-model `solve`+`verify` risks correlated self-certification and collides with P1 in `program-voice.js`. |
| 8 | P7 | Multi-Turn On-Device Sessions | 7 | 5 | 1.40 | Useful stateful sessions, but Gemini Nano `ON_DEVICE` is unavailable on this Windows host for live measurement. |
| 9 | P4 | Self-Directed Epistemic Curriculum | 8 | 7 | 1.14 | High mode-collapse risk and 20–40+ min GPU runtime under `localConcurrency = 1`. |

---

## Part 3 — Selected Top 3 Engineering Plans (Parallel Branches from `phase-20-program-judge`)

| Phase & Branch | Proposal | Subsystem Pillar | DB Migration | Est. GPU Time |
|---|---|---|---|---|
| **Phase 21** — `phase-21-metamorphic-judge` | **P1** | Epistemic verification & judge (`src/evolve/`) | None (v8) | ~6–8 min |
| **Phase 22** — `phase-22-claim-auditor` | **P5** | Mission / LogicChain / private auditing (`src/orchestrator/`, `src/agents/`) | None (v8) | ~4–6 min |
| **Phase 23** — `phase-23-mesh-immune` | **P9** | Sovereign mesh security & revocation (`src/protocols/`, `src/core/dna.js`, `src/storage/db.js`) | **v9** | ~3–5 min |

### Plan 1: `phase-21-metamorphic-judge`
- **Add:** `src/evolve/invariants.js` (`extractTaskInvariants`, `checkProgramInvariants` running batched 0-GPU metamorphic probes for round-trip Cauchy bounds/idempotence/symmetry/scaling, parallel work-rate halving/bounds, sequential percent monotonicity, mixture convex hull, and general non-constant sensitivity), `test/invariants.test.js`, `scripts/measure-phase21-metamorphic.mjs`.
- **Modify:** `src/evolve/program-voice.js` (3 representation-diverse role prompts, parameterized `function solve(...)` + grounded `params`, metamorphic veto gate, distinct `model` enforcement across agreeing votes), `src/evolve/crystallizer.js` (fix `nearAnswer` 0-decimal over-tolerance, honor `FINAL <n>` before `inTask` filter, fix `#voices()` slicing before removing `firstId`, fix `correctAnswer()` checking `v.extra` + `pctTask`), `src/agency.js` (ledger `program.veto` with task hash only).
- **Measurement (`docs/phases/evidence-phase21-metamorphic.json`):** Re-run Phase 20 Standard 40 + Hard 13 + 12 fresh adversarial metamorphic tasks on local Ollama; falsification bar: wrong rate must drop below 3/40, standard accuracy >= 85% without regressing hard 13 below 69.2%, 0 false vetoes on valid reference programs.

### Plan 2: `phase-22-claim-auditor`
- **Add:** `src/orchestrator/auditor.js` (`extractCodeBlocks`, `auditCodeBlocks`, `auditNumericProvenance`, `auditLogicChain`, `ClaimAuditor` with `auditTask`, `auditDeliverable`, `auditPrivateReply`, strictly `privacy: 'private'`), `test/auditor.test.js`, `scripts/measure-phase22-auditor.mjs`.
- **Modify:** `src/orchestrator/missions.js` (`#critique` deterministic score cap + defects triggering self-healing retry; `#finish` deliverable audit), `src/orchestrator/logic-chain.js` (audit open protected contradictions in brief), `src/agents/runtime.js` (local-only `auditPrivateReply` for `private`/`sealed` replies), `src/agency.js` (wire `ClaimAuditor`).
- **Measurement (`docs/phases/evidence-phase22-auditor.json`):** 8 injected-defect deliverables + 4 clean controls (baseline prose critic vs `ClaimAuditor`), 3 live self-healing code-repair missions, 4 `private`/`sealed` tasks verifying `remoteCalls === 0` and `0` PII in ledger.

### Plan 3: `phase-23-mesh-immune`
- **Add:** `src/protocols/immune.js` (`ImmuneSystem`: Membrane-checked `emitAdvisory`, local sandbox/`programVoice` reproduction in `handleAdvisory`, quarantine + binder retirement + re-import blocking, Byzantine `false_flag` tracking + `trusted -> known` auto-demotion), `test/immune.test.js`, `scripts/measure-phase23-immune.mjs`.
- **Modify:** `src/core/dna.js` (fix Critical `openPlasmid` unsigned bypass at line `226`), `src/storage/db.js` (Migration v9: `skill_advisories` table + `peers.rep_confirmed` / `peers.rep_false_flags`), `src/evolve/crystallizer.js` (`quarantine()`, block re-import of confirmed bad `code_sha256`, `onSkillRefuted` hook), `src/protocols/mesh.js` (`skill.advisory` handler), `src/agency.js` (wire `ImmuneSystem`).
- **Measurement (`docs/phases/evidence-phase23-immune.json`):** 4 real local HTTP agencies (`A, B, C, D`) + local Ollama `programVoice`: crash containment (0 GPU), semantic bug containment + re-import block, Byzantine false-flag defense (0 false quarantines, 2/2 peer auto-demotions), unsigned plasmid & PII advisory negative controls.
