# Phase 2: Proof

Previous: [Phase 1](PHASE-1.md) · [Index](README.md)

## Summary
Phase 2 turned "implemented" into "proven". It added the following:
- The deterministic benchmark ran on real local models, and each failure was traced to its cause.
- The mesh was proven between two live HTTP servers, and MCP was proven against a real spawned process.
- Model tokens now stream live to the dashboard.
- A mobile layout bug was fixed.
- The contest demo script and Devpost text were written.

The phase's main finding is that **single benchmark runs on small local models are noisy**. The suite now repeats items and reports Wilson 95% confidence intervals.

## Measured results (RTX 3070, `fraymus-prime:v1` / `qwen2.5-coder:7b` / `niles-continuity-8b`)

| Run | Score |
|---|---|
| Baseline, single run (before fixes) | 5/8 = 0.625 |
| After fixes, 3 repeats | **21/24 = 0.875, 95% CI [0.69, 0.96]** |

Per item after fixes:

| Item | Passed | Rate |
|---|---|---|
| syllogism, code-verified, dna-tool, injection-resist, honesty | 3/3 each | 1.0 |
| math-exact, tool-time, json-shape | 2/3 each | 0.67 |

The two scores above aren't directly comparable: the baseline is a single 8-item run, so its uncertainty is large.

## What was built and fixed

**Harness fixes**, each one found by reading the traces of a failed benchmark item:
1. **Reflection** destroyed verified output. A review that reports no issues now keeps the draft, and a revision that drops more than half the content is rejected.
2. **Forced-final path.** Broken protocol JSON (`"tool": null`) now triggers a forced final answer instead of being accepted as the answer.
3. **Untrusted content rule.** The agent ignores instructions inside quarantined content but still completes its task on the rest.
4. **Placeholder guard.** A final answer containing unresolved `{{templates}}` or `<source>` placeholders is sent back once.
5. **Echo guard.** A final answer that just repeats the argument it sent to a tool is sent back once.
6. **Context pollution.** Automatic memory injection now requires a recall score of at least 0.3. A logic puzzle had been answered "unknown" because of an irrelevant recalled memory.
7. **Reasoning rule.** Self-contained reasoning is answered directly, without searching for evidence the task already gives.
8. **JSON tasks.** Object finals stay as JSON when the task asks for JSON (the Markdown rendering was a Phase 2 regression).
9. **Roster updates.** Built-in agents pick up tool and prompt changes on boot while keeping their evolved genomes. Tycho gained `time_now`.

**Benchmark**
- Semantic checkers: the honesty check now fails on a fabricated price, not on wording.
- The code check accepts "is / is not a palindrome" but still requires an actual `code_run`.
- `--repeat N` reports per-item pass rates and Wilson 95% intervals. `--only` runs selected items.

**Protocols proven**
- Two agencies on real HTTP ports pair through `/mesh/identity`.
- An untrusted `task.request` is refused. A trusted one runs on the peer, and a signed `task.result` comes back.
- Shared memory arrives quarantined, and both ledgers still verify afterwards.
- MCP: the agency's MCP server was driven by `McpClient` through in-memory pipes and as a real spawned child process.

**MCP client bug fixed.** On Windows the client spawned through a shell, so a command path with spaces (`C:\Program Files\nodejs\node.exe`) was split apart and the server died on start. The client now uses a shell only for bare commands like `npx`, quotes arguments, and includes the server's stderr in error messages.

**Live token streaming**
- Each agent turn streams model tokens on the event bus as ephemeral `agent.stream` events, batched every 200 ms and kept out of the replay buffer.
- The dashboard shows a "Live thinking" panel per agent, plus streaming in the Ask dialog, rendered as 💭 thought / 🔧 tool / ✅ final rather than raw JSON.
- Repaints are throttled with `setTimeout`, because `requestAnimationFrame` pauses in background tabs and froze the panel.

**Mobile layout.** At phone width the page scrolled horizontally (1069 px inside a 431 px viewport): the nav's min-content widened the single `1fr` grid column. Changed it to `minmax(0, 1fr)` with `min-width: 0` on grid children.

**Contest materials:** `docs/DEMO_SCRIPT.md` (≤ 3:00 shot list) and `docs/DEVPOST.md` (submission text).

## Files changed
- **Source:** `src/agents/runtime.js`, `src/agents/roster.js`, `src/agents/registry.js`, `src/memory/memory.js`, `src/telemetry/bench.js`, `src/protocols/mcp.js`, `src/core/bus.js`, `src/cli/cli.js`
- **Dashboard:** `web/src/main.ts`, `web/src/style.css`
- **Tests:** `test/mesh-http.test.js` (new), `test/agency.test.js`, `test/core.test.js`
- **Docs:** `docs/DEMO_SCRIPT.md`, `docs/DEVPOST.md`, `docs/phases/*`, `docs/screenshots/live-thinking-mobile.jpg`, `README.md`

## Patterns used
- Trace-driven debugging: read the agent's steps before changing anything.
- Every harness guard retries exactly once.
- Grade the failure mode, not the wording.
- Repeated trials with confidence intervals instead of single-run scores.
- Ephemeral bus events for high-frequency streams.
- Timer-based UI throttling that keeps working in background tabs.

## Running counts
| Metric | Phase 1 | Phase 2 |
|---|---|---|
| Tests | 27 | **32** (all passing) |
| Harness guards | narration | narration, placeholder, echo, reflection-preservation |
| Benchmark score | not measured | 0.875, CI [0.69, 0.96] |
| Protocols proven live | none | mesh over HTTP, MCP over stdio |
| Dashboard features | 9 views | + live thinking, mobile layout |
