# Devpost submission text — EyeOverThink Agency

## Tagline
A sovereign AI agency that runs on your own machine: local GPU agents, on-device Gemini Nano for private work through Firebase AI Logic, and every result verified before it counts.

## Inspiration
Agent tools usually trust whatever the model says it did, forget everything between runs, and send your private work to someone else's servers. I wanted an agency I could run and audit myself, one that uses the cloud only when I allow it.

## What it does
- You give it a goal. **Genesis** plans a task graph, and specialists (research, engineering, analysis, writing) run in parallel on local models.
- **Solon**, the critic, scores every result against the tool record. A rejected result goes back with the critique; if tasks keep failing, Genesis replans.
- **Lumen** writes the final deliverable and **Sentinel** reviews it for leaks and unsafe actions.
- Every consequential act is Ed25519-signed into a hash-chained ledger with Merkle proofs.
- Agents remember through signed memory with semantic, keyword and knowledge-graph recall, and build playbooks from their own verified work.
- Each agent's behavior is encoded as a DNA genome. Evolution promotes a mutation only if it measurably beats the incumbent on a deterministic benchmark.

## How Firebase AI Logic is used
The dashboard is also an **edge inference node**. `web/src/hybrid.ts` calls, at runtime:
- `initializeApp` and `initializeAppCheck`;
- `getAI(app, { backend: new GoogleAIBackend() })`;
- `getGenerativeModel` with an official `InferenceMode`;
- `initializeDeviceModel()` after a click;
- `generateContent()` and `response.inferenceSource`.

`web/src/edge.ts` registers the browser with the agency, takes jobs, runs them, and reports `ON_DEVICE` or `IN_CLOUD` for each one. Private work (`privacy: "private"`) is pinned to `ONLY_ON_DEVICE`, so it never leaves the machine. Public work can use `PREFER_ON_DEVICE` and fall back to cloud Gemini. Hybrid inference is how privacy actually works in this product.

## How I built it
- **Core:** Node.js with zero runtime dependencies: `node:sqlite`, `node:crypto` (Ed25519) and `node:http`.
- **Models:** Ollama on an 8 GB RTX 3070 for local agents.
- **Dashboard:** Vite + TypeScript with the `firebase` SDK.
- **Protocols:** an MCP server and client so other tools can use the agency, and signed peer-to-peer messaging between agencies.
- **Tests:** 29 automated tests plus a deterministic benchmark suite on real models.

## Challenges
- **Small local models drift from protocol.** Fixes: a JSON repair turn, a forced final answer, and a "narration guard" that rejects answers claiming tool use that never happened.
- **Self-review can destroy good work.** A reflection pass once rewrote verified output into a vague summary. Now a review that finds no issues keeps the draft, and a revision that drops content is rejected.
- **An 8 GB GPU.** Each request pins the context window and local generations are serialized. Otherwise Ollama's default context spills to CPU and runs about 5× slower.

## Accomplishments
- A full mission completes on a laptop GPU: plan, verify, self-heal, synthesize, security review.
- Missions resume after a crash from their checkpoints.
- The ledger catches any tampering, and every memory carries a signature.
- Agents move between agencies as signed DNA plasmids.

## What's next
- Multi-turn on-device sessions.
- A visual workflow canvas.
- Gossip-based memory sync between trusted agencies.

## Built with
`firebase` (AI Logic, App Check) · Gemini Nano · Gemini Developer API · Node.js · SQLite · Ollama · TypeScript · Vite · Ed25519 · Model Context Protocol
