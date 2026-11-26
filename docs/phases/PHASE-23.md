# Phase 23: Cross-Agency Immune System (Verified Skill Revocation & Peer Reputation)

Previous: [Phase 22](PHASE-22.md) · [Index](README.md)

> Built on the `phase-23-mesh-immune` branch from `phase-20-program-judge`. `master` stays untouched (`contest-freeze`).

## The problem
Phases 15 and 16 let trusted agencies exchange verified skills as signed DNA plasmids over the HTTP mesh, starting on local probation. Once adopted, however, immunity was strictly solitary:
- If Agency A discovered a crash or semantic bug in an active skill, Peers B and C kept executing that exact code with zero-call binders.
- `peers.trust` had no empirical memory of whether a peer sends valid warnings or Byzantine false flags.
- Auditing `src/core/dna.js:226` also exposed a Critical signature-bypass bug (`openPlasmid` skipped signature verification whenever `plasmid.sig` was omitted or `null`), and `src/protocols/mesh.js:70` accepted non-numeric `NaN` timestamps outside the ±300 s clock window.

## The design
1. **Hardened plasmid & envelope security (`src/core/dna.js`, `src/protocols/mesh.js`):**
   - `openPlasmid(plasmid, verify)` now fails closed whenever `verify` is provided (requiring non-empty string `sig` and `signer`), uses `Object.create(null)` for `parts`, and rejects prototype-polluting or traversal part names (`__proto__`, `constructor`, `prototype`, `..`).
   - `Mesh.receive()` enforces `Number.isFinite(ts)` before the ±300 s clock-window check and requires `trusted` peer status for `skill.advisory`.
2. **Schema Migration v9 (`src/storage/db.js`):**
   - Adds `skill_advisories (id, code_sha256, skill_name, sender_key, kind, counterexample, verdict, detail, created)` with index `skill_advisories_sha`.
   - Adds empirical reputation columns `rep_confirmed` and `rep_false_flags` to `peers`.
3. **Zero-rumor local reproduction (`src/protocols/immune.js`):**
   - **Outbound Privacy Membrane guard (`emitAdvisory`):** Scans `task`, `error`, `skillName`, `expectedAnswer`, and all keys & values of `input` (with depth/cycle guards and optional fail-closed local NER) via `detect()`; refuses broadcast and ledgers `immune.advisory_blocked` (hashes/types only) on any PII/secret hit. Broadcasts only to `trusted` peers.
   - **Inbound verification (`handleAdvisory`):** Never revokes on rumor. Enforces trusted-only sender, per-peer rate limit, input depth/byte bounds (`<= 6` depth, `<= 4096` bytes) before `canonical()`, and in-flight/DB dedup.
     - `crash`: validates recursive JSON schema (`Object.hasOwn`, `integer`, `array.items`, bounds) and runs the local skill (+ active/probation dependency library) in `runSandboxedJs` at **0 GPU calls**. Timeouts yield `inconclusive` (never DoS-quarantine).
     - `wrong_output`: rejects prompt injection (`scanInjection`), schema violations, ungrounded inputs (`groundingProblem`), binding/answer-form mismatches (`bindingProblem`), domain/relevance mismatches (`relevance`, opposing domain terms, learned block words), and active-binder disagreements at **0 GPU calls** before running local `programVoice` (`privacy: 'private'`).
   - **Containment & gossip:** Locally confirmed defects call `crystallizer.quarantine()` (sets `status = 'quarantined'`, unregisters `skill_<name>`, retires active binder, ledgers `skill.quarantine` and `immune.quarantine`), block re-import of the confirmed `code_sha256` (and enforce valid `admission.kind` in `importSkill`), increment `peers.rep_confirmed`, and relay an allowlisted, privacy-checked, clamped-TTL (`<= 3`) advisory to other `trusted` peers.
   - **Byzantine defense:** Unreproducible / false-flag advisories leave the healthy skill `active`, increment `peers.rep_false_flags`, ledger `immune.false_flag` (fixed reason codes only), and automatically demote `trusted → known` at `falseFlagDemoteAt` (default `2`), immediately blocking further advisories from that peer.
4. **Inspection endpoint:** Authenticated `GET /api/mesh/immune` returns advisories, quarantined skills, and per-peer reputation counters.

## Measured on real local models
Measured across **4 real local Agency HTTP servers** (`A, B, C, D` on `127.0.0.1`, real Ed25519 keys, real SQLite, real `/mesh/inbox` signed envelopes, real local Ollama `programVoice`, `cloudJudge: false`, RTX 3070 8 GB) via `scripts/measure-phase23-immune.mjs`.

| Scenario | Result | Measured Metrics |
|---|---|---|
| **1. Crash containment (`A → B → C`, 1-hop gossip)** | **PASS** | **143 ms**, **0 GPU calls**, B & C both `quarantined`, `rep_confirmed = 1` on B & C |
| **2. Semantic bug containment (`A → B, C`, local Ollama `programVoice`)** | **PASS** | **55.7 s**, **5 local GPU calls**, B & C both `quarantined`, plasmid re-import **blocked** on both |
| **3. Byzantine false-flag attack (`D → B, C` vs healthy `compound_discount`)** | **PASS** | **34.0 s**, **0 false quarantines**, healthy skill stays `active` on B & C, `D` auto-demoted `trusted → known` (`rep_false_flags = 2`) on both |
| **4. Security & privacy negative controls** | **PASS** | Unsigned plasmid rejected (`true`), PII advisory blocked (`true`, 0 PII in ledger), **0 remote calls** (11 local calls total), all 4 agency ledgers verify `ok: true` |

Total end-to-end 4-agency run time: **90.2 s**. Evidence: [evidence-phase23-immune.json](evidence-phase23-immune.json).

## Tests
**167 tests pass** (`npm test`), including 9 new tests in `test/immune.test.js`:
- Audit C2 unsigned plasmid rejection in `openPlasmid`;
- Migration v9 schema verification (fresh and v8 → v9 upgrade);
- Crash advisory over real HTTP Mesh (0 router calls, quarantine, tool removal, binder retirement, `rep_confirmed`, re-import blocked, `/api/mesh/immune`);
- Wrong-output advisory with 1-hop gossip (`ttl: 1`) and loop-safe dedup;
- Byzantine 2× false-flag auto-demotion (`trusted → known`);
- Ungrounded trap rejection at 0 GPU calls;
- Privacy Membrane egress block with zero PII in ledger;
- `crystallizer.onSkillRefuted` crash hook;
- Red-team regressions (domain mismatch, prompt injection, untrusted `known` rejection, malformed array items, deep nesting DoS, PII in `error` string, `NaN` timestamp, `__proto__` plasmid part name).

## Known limits
- **Code-hash identity only:** Quarantining blocks the exact `code_sha256`. A malicious peer adding a whitespace comment creates a new hash (which still lands on local probation and must pass 2 local verdicts, but is not pre-blocked by hash).
- **Semantic verification cost:** Reproducing a `wrong_output` advisory invokes local `programVoice` (2–3 local GPU calls, ~17–28 s per peer on an 8 GB GPU). Crash advisories cost 0 GPU calls (~143 ms).
- **Non-numeric skills:** `wrong_output` local verification currently relies on numeric `programVoice`; non-numeric skill outputs return `inconclusive`.
- **Dependent composed skills:** Quarantining a dependency unregisters its tool and prevents new imports, but does not yet automatically cascade quarantine to active composed skills that invoke it.
