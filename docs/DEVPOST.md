# Devpost submission text — EyeOverThink Agency

Paste each section into the Devpost field of the same name. The "About the project" field takes everything from **Inspiration** through **What's next**.

## Project name
EyeOverThink Agency

## Try it out
- Code (Apache-2.0): https://github.com/eyeoverthink/eyeoverthink-agency
- **30-second check (no GPU, no Ollama, no Firebase account):** clone it and run `npm test` (Node.js 22.13+; 152 deterministic tests covering the ledger, Privacy Membrane, receipts, skills, judge and mesh). Then read `web/src/hybrid.ts`, `web/src/edge.ts`, `src/guard/membrane.js` and the raw evidence JSON files in `docs/phases/`.
- **Full run:** `node bin/agency.js serve` (needs Ollama; the dashboard in `web/` needs a Firebase project, see `web/.env.example`; `node bin/agency.js edge doctor` checks the setup offline).

## Video
https://www.youtube.com/watch?v=dXUTdhnmbvA (2:52, recorded live on real local models; narration in my own voice).

## Elevator pitch (tagline, 190 characters; Devpost's limit is 200)
Local AI that compiles verified answers into 0-call code. Gemini via Firebase AI Logic is its measured 40/40 judge, Privacy Membrane cloud tier and GPU overflow. Every act is Ed25519-signed.

## Image gallery (upload in this order)
1. `docs/screenshots/ask-the-agency.jpg`: 0 calls, 0.13 s, a skill the agency composed itself.
2. `docs/screenshots/membrane-firebase-saw.jpg`: what Firebase actually received (placeholders only).
3. `docs/screenshots/sovereignty-map.jpg`: local GPU and membrane vs Firebase AI Logic at a glance.
4. `docs/screenshots/skill-family-tree.jpg` and `judge-voices.jpg`: crop out the red "OFFLINE" sidebar badge first.
5. `docs/screenshots/mission-control.jpg` or `agents-dna.jpg`.

Leave out `edge-proof-real.jpg` (its big "0 ON_DEVICE" reads as a failure without context), `second-voice-check.jpg` (too small to read) and `program-voice.jpg` (made after the code freeze).

## Inspiration
Agent tools usually trust whatever the model says it did, forget everything between runs, and send your private work to someone else's servers. I wanted an agency I could run and audit myself, one that uses the cloud only when I allow it.

The people who need this most are privacy-bound teams: clinics, accounting and finance operations, legal practices. Cloud-only AI rents intelligence per call and sees their clients' data. Small local models keep the data private, but in my measurements the default local agent got only 50–70% of multi-step number problems right, with no record of how. This project is my answer to that trade-off: private by default, cloud power when it's safe, and proof for every answer.

## What it does
- You give it a goal. **Genesis** plans a task graph, and specialists (research, engineering, analysis, writing) run in parallel on local models.
- **Solon**, the critic, scores every result against the tool record. A rejected result goes back with the critique; if tasks keep failing, Genesis replans.
- **Lumen** writes the final deliverable and **Sentinel** reviews it for leaks and unsafe actions.
- Every consequential act is Ed25519-signed into a hash-chained ledger with Merkle proofs.
- Agents remember through signed memory with semantic, keyword and knowledge-graph recall, and build playbooks from their own verified work.
- Each agent's behavior is encoded as a DNA genome, and evolution mutates it. A promotion must hold up on fresh seeds, pass a sign test that ignores the cells it was selected on, and is re-checked on held-out tasks. The agency also measures its own noise floor by running the same genome twice on identical seeds.

## It keeps what it learns
Most AI products rent intelligence per call and keep nothing. This agency turns what its agents work out into **verified code it owns**:
- **Skills.** A solved task is distilled into a pure function. It is admitted only if it agrees with an independent implementation that a different model wrote from the description alone.
- **Zero-call routing.** Before agents spend model turns, the agency checks whether a skill it owns answers the task. It learns, with no model, how to read each skill's inputs from the task text. Then the next task of that kind costs **zero model calls**.
- **It doesn't trust itself blindly.** A skill answers only task wording it has verified. Unfamiliar wording goes to the agents, and the skill's output is checked against their answer afterwards. A verdict needs two of three different agents to agree.
- **Refusals become skills.** When a skill refuses a task and the agents agree on its answer, that's a solved example of something the agency doesn't own yet. Once at least three agree (the default), the agency tries to crystallize a new skill, which must reproduce those answers before it is admitted. In the live run, five refusals became a tax skill that matched the answer key 5 of 5.
- **Composition.** Owned skills chain together (discount, then tax, then split the bill). After the judge verifies a chain shape twice, the agency **writes the combined skill itself, with no model**.

Measured live on my laptop (real local models): a new kind of bill-splitting task cost **4 model calls and 15.6 s** the first time, **1 call and 4.6 s** the second, and **0 calls and 0.13 s** the third, the same run shown in the video. All answers were exact. Earlier phases did route some tasks to the wrong skill; how each case was caught and blocked is documented in Phases 11 and 12, and the final runs of Phases 13–15 had no misroutes.

**Why number problems?** Pricing, tax, splits and rates mirror real quoting and invoicing work, and they have exact answers, so every claim here is checked against ground truth instead of another model's opinion.

## It measures who to believe, and checks every number
- **Skills travel safely.** Verified skills move between agencies as signed plasmids. The receiver re-checks every signature and test case and keeps the skill on probation until its own agents agree with it twice. Over the signed mesh, an agency pulls the skills it lacks from trusted peers by name, and **the peer never sees the task**.
- **A measured judge.** When a skill and an agent disagree, more voices are asked and two of three decide. A study of 40 tasks with known answers measured every voice: **Gemini (Firebase AI Logic) 100%**, forge_keeper 95%, the old default agent 50–70%. So Gemini is asked first, and the most accurate local agent answers first. That choice was confirmed on a held-out set before it was used.
- **Every number checked.** An answer that no skill checked gets one more independent voice. With the weaker agent answering first, 8 of 12 first answers were right and **all 12 replies were**: 4 were corrected 2 of 3, with the dissent stated, and none went out wrong unflagged.
- **Where every skill came from.** A family tree drawn only from signed ledger entries.

## How Firebase AI Logic is used
The dashboard is also an **edge inference node**. `web/src/hybrid.ts` calls, at runtime:
- `initializeApp` and `initializeAppCheck`;
- `getAI(app, { backend: new GoogleAIBackend() })`;
- `getGenerativeModel` with an official `InferenceMode`;
- `initializeDeviceModel()` after a click;
- `generateContent()` and `response.inferenceSource`.

`web/src/edge.ts` registers the browser with the agency, takes jobs, runs them, and reports `ON_DEVICE` or `IN_CLOUD` for each one. Firebase AI Logic has three jobs in the agency: the Privacy Membrane's cloud tier, the measured judge, and GPU overflow.

**Private work, cloud power: the Privacy Membrane.** In `sealed` mode, deterministic detectors (emails, phones, card numbers, SSNs, IBANs, secrets, owner terms) and a local-only name finder replace every sensitive value with a placeholder such as `⟦PERSON_1⟧`. A fail-closed audit checks the outgoing text, only placeholders go to Firebase AI Logic, and the reply is restored on the machine. Live test: a clinic appointment email with five private fields. Gemini (`IN_CLOUD`, 1.7 s) saw only `⟦PERSON_1⟧`, `⟦EMAIL_1⟧`, `⟦ADDRESS_1⟧`, `⟦ID_1⟧` and `⟦PHONE_1⟧`, kept all five, and the agency restored the real values locally (ledger entry #1173, `membrane.crossing`).

**Honest note on Gemini Nano.** `web/src/hybrid.ts` supports all four `InferenceMode`s. On my laptop, Chrome exposed the Prompt API but reported Gemini Nano as unavailable, so `PREFER_ON_DEVICE` fell back to the cloud as designed and `ONLY_ON_DEVICE` kept private work on the local GPU instead of sending it anywhere. Every measured Firebase call therefore ran `IN_CLOUD`; the on-device path is implemented and tested, not yet exercised on real hardware.

**Why the agency calls Firebase at runtime: GPU overflow.** The local 8 GB GPU runs one model call at a time. While it is busy, waiting planning, reasoning and critic calls go to a dashboard tab acting as a Firebase AI Logic worker, instead of queueing. It's real extra capacity, not a demo path:
- Benchmark and evolution calls never overflow, so their comparisons stay on one model.
- Private work overflows only to a browser whose Gemini Nano is actually available, pinned to `ONLY_ON_DEVICE`. Otherwise it stays on the local GPU.
- If the edge fails, each call falls straight back to the GPU.

**Gemini is the agency's most accurate judge.** While a dashboard tab serves Firebase AI Logic, the agency asks Gemini first whenever its own answers need checking. In the measurements it was right 40 of 40 times (20 tasks, then 20 held-out), at a median of about 1.3 s per call. A guard in front of every judge call means a task holding private values (emails, keys, owner terms) never reaches it.

**Proof, not claims.** A finished mission exports a receipt that anyone can verify offline, with zero dependencies, in Node or a browser (`bin/verify-receipt.js`). Every Firebase call is signed into the agency's Ed25519 hash-chained ledger as an `edge.inference` entry: the inference path, latency, project and a SHA-256 of the output (never the prompt or text). On my machine, a real mission sent 3 of its 160 model calls through Firebase AI Logic while the GPU was busy, each ledgered as `IN_CLOUD`.

**Setup that tells you what's wrong.** `agency edge doctor` checks the Firebase config offline, masks secrets, refuses an env file git could commit, and catches a dashboard build older than its config. First-call errors are translated into their fix.

## How I built it
- **Core:** Node.js with zero runtime dependencies: `node:sqlite`, `node:crypto` (Ed25519) and `node:http`.
- **Models:** Ollama on an 8 GB RTX 3070 for local agents.
- **Dashboard:** Vite + TypeScript with the `firebase` SDK.
- **Protocols:** an MCP server and client so other tools can use the agency, and signed peer-to-peer messaging between agencies.
- **Tests:** 152 automated tests plus deterministic benchmark and evolution suites, and every phase measured again on real models.

## Challenges
- **Small local models drift from protocol.** Fixes: a JSON repair turn, a forced final answer, and a "narration guard" that rejects answers claiming tool use that never happened.
- **Self-review can destroy good work.** A reflection pass once rewrote verified output into a vague summary. Now a review that finds no issues keeps the draft, and a revision that drops content is rejected.
- **An 8 GB GPU.** Each request pins the context window and local generations are serialized. Otherwise Ollama's default context spills to CPU and runs about 5× slower.
- **Real Firebase calls found bugs simulated ones couldn't.** The SDK reports its inference path in lower case (`in_cloud`), so every real call was first logged as `UNKNOWN`; and the presence of Chrome's Prompt API doesn't mean Gemini Nano is available. Both are fixed and covered by tests.
- **Evolution kept fooling itself.** A behaviorally identical copy of an agent "beat" the original on the same seeds, because GPU runs aren't fully repeatable. Promotion now needs fresh seeds, a sign test that excludes the cells a challenger was selected on, and a held-out check, and the agency measures its own noise floor.
- **A learning system can teach itself mistakes.** Early on, wrong skill answers were saved as good examples and then shielded themselves from correction. Now a skill trusts only wording it has verified, one agent's dissent is never enough to change what it learned, and an answer key outranks any vote between models.
- **A 3B model can't plan a chain of skills, but it reads numbers well.** So the small model reads the values and the agency works out the structure itself.

## Accomplishments
- A full mission completes on a laptop GPU: plan, verify, self-heal, synthesize, security review.
- Missions resume after a crash from their checkpoints.
- The ledger catches any tampering, and every memory carries a signature.
- Agents move between agencies as signed DNA plasmids.
- Firebase AI Logic serves real agency work as overflow capacity, with a signed record of every call.
- A library of verified skills grows from the agency's own work, its refusals and its combinations, and answers repeat tasks with zero model calls.
- Skills travel between agencies over a signed mesh, and are re-verified and adopted only after local agreement.
- Its judge is measured, not assumed, and every number it gives is checked by an independent voice.

## What I learned
- **Measure every voice before trusting it.** The default agent I would have picked as judge was right 50–70% of the time. Gemini was right 40 of 40. Only the measurement showed that.
- **Independent models are not independent.** When agents were wrong, they were often wrong together, with the same misreading of the question. Two of three agreeing is strong evidence, not proof.
- **Real calls beat simulated ones.** The first real Firebase AI Logic calls exposed two bugs that every mocked test had passed.
- **A system that learns must be able to unlearn.** The hardest part wasn't learning skills. It was stopping a wrong example from protecting itself, and letting the agency demote it later.

## What's next
- A program-verified judge for tasks the agents can't solve reliably themselves. (Started after the code freeze on branch `phase-20-program-judge`; not part of the submitted build.)
- Multi-turn on-device sessions.
- A visual workflow canvas.
- Gossip-based memory sync between trusted agencies.

## Built with
`firebase` (AI Logic, App Check) · Gemini Nano · Gemini Developer API · Node.js · SQLite · Ollama · TypeScript · Vite · Ed25519 · Model Context Protocol
