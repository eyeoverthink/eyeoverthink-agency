# Devpost submission text — EyeOverThink Agency

## Tagline
A sovereign AI agency on your own machine: local GPU agents, Firebase AI Logic as extra capacity when the GPU is busy, every result verified before it counts, and every act signed so you can audit it.

## Inspiration
Agent tools usually trust whatever the model says it did, forget everything between runs, and send your private work to someone else's servers. I wanted an agency I could run and audit myself, one that uses the cloud only when I allow it.

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
- **Refusals become skills.** When a skill refuses a task and the agents agree on its answer, that's a solved example of something the agency doesn't own yet. Three of them crystallize a new skill, which must reproduce those answers before it is admitted.
- **Composition.** Owned skills chain together (discount, then tax, then split the bill). After the judge verifies a chain shape twice, the agency **writes the combined skill itself, with no model**.

Measured live on my laptop (real local models): a new kind of bill-splitting task cost **5–8 model calls and about 25 s** the first time, **1 call and 4 s** the second, and **0 calls and 0.13 s** the third. All answers were exact. In the test runs, no task was routed to the wrong skill.

## How Firebase AI Logic is used
The dashboard is also an **edge inference node**. `web/src/hybrid.ts` calls, at runtime:
- `initializeApp` and `initializeAppCheck`;
- `getAI(app, { backend: new GoogleAIBackend() })`;
- `getGenerativeModel` with an official `InferenceMode`;
- `initializeDeviceModel()` after a click;
- `generateContent()` and `response.inferenceSource`.

`web/src/edge.ts` registers the browser with the agency, takes jobs, runs them, and reports `ON_DEVICE` or `IN_CLOUD` for each one.

**Why the agency calls Firebase at runtime: GPU overflow.** The local 8 GB GPU runs one model call at a time. While it is busy, waiting planning, reasoning and critic calls go to a dashboard tab acting as a Firebase AI Logic worker, instead of queueing. It's real extra capacity, not a demo path:
- Benchmark and evolution calls never overflow, so their comparisons stay on one model.
- Private work overflows only to a browser whose Gemini Nano is actually available, pinned to `ONLY_ON_DEVICE`. Otherwise it stays on the local GPU.
- If the edge fails, each call falls straight back to the GPU.

**Proof, not claims.** Every Firebase call is signed into the agency's Ed25519 hash-chained ledger as an `edge.inference` entry: the inference path, latency, project and a SHA-256 of the output (never the prompt or text). On my machine, a real mission sent 3 of its 160 model calls through Firebase AI Logic while the GPU was busy, each ledgered as `IN_CLOUD`.

**Setup that tells you what's wrong.** `agency edge doctor` checks the Firebase config offline, masks secrets, refuses an env file git could commit, and catches a dashboard build older than its config. First-call errors are translated into their fix.

## How I built it
- **Core:** Node.js with zero runtime dependencies: `node:sqlite`, `node:crypto` (Ed25519) and `node:http`.
- **Models:** Ollama on an 8 GB RTX 3070 for local agents.
- **Dashboard:** Vite + TypeScript with the `firebase` SDK.
- **Protocols:** an MCP server and client so other tools can use the agency, and signed peer-to-peer messaging between agencies.
- **Tests:** 132 automated tests plus deterministic benchmark and evolution suites, and every phase measured again on real models.

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

## What's next
- Carrying verified skills between agencies in signed plasmids, so one agency's lessons become another's.
- A program-verified judge for tasks the agents can't solve reliably themselves.
- Multi-turn on-device sessions.
- A visual workflow canvas.
- Gossip-based memory sync between trusted agencies.

## Built with
`firebase` (AI Logic, App Check) · Gemini Nano · Gemini Developer API · Node.js · SQLite · Ollama · TypeScript · Vite · Ed25519 · Model Context Protocol
