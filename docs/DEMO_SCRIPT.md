# Demo video script (≤ 3:00) — EyeOverThink Agency · #BuildHybridAI 2026

Only the first 3 minutes are judged. Target 2:40, hard cap 2:55. Record in desktop Chrome 139+ with Gemini Nano already downloaded and `npm start` running against local Ollama. Font size large enough for 1080p.

**Before recording**
- [ ] `node bin/agency.js selftest` shows ALL_CLEAR.
- [ ] Dashboard → Hybrid Edge → *Prepare on-device model* (finish the download before recording).
- [ ] One short mission already completed, as a fallback shot.
- [ ] Nothing secret on screen: hide the API token and the `.env.local` values.

---

**0:00–0:15 · Hook** (Mission Control)
"This is an AI agency that runs on my own machine. A local GPU does the work, Gemini Nano on-device keeps private work private through Firebase AI Logic, and every result is checked before it counts."

**0:15–0:55 · Launch a mission** (Mission Control)
Type: *"Write a JavaScript function that returns the first 10 primes, prove it by running it, and explain its complexity."* Click **Launch mission**.
- Point at the task graph: "Genesis planned the team. Independent tasks run in parallel."
- Point at **Live thinking**: "You're watching the agents reason as tokens stream from the local model."
- When a critic retry happens: "Solon, the critic, rejected that first attempt and sent the defect back. The agent fixed it. That's self-healing."

**0:55–1:30 · Hybrid edge** (Hybrid Edge view)
- Click **Start serving**: "This browser tab is now an inference node for the agency."
- In Workflows, run **Private draft (on-device)** with personal notes. Back on Hybrid Edge, point at the **ON_DEVICE** counter and source chip: "Private work is pinned to ONLY_ON_DEVICE, so the text never leaves this laptop. Firebase AI Logic reports which path actually ran."
- Switch the mode to prefer_in_cloud and run a public prompt to show **IN_CLOUD**: "Same SDK; it falls back to cloud Gemini when Nano isn't there."

**1:30–2:00 · Trust** (Ledger, then Approvals)
- Ledger: "Every plan, tool call and memory write is signed with Ed25519 and hash-chained, and the whole chain is re-verified every time this page opens." Point at VERIFIED and the Merkle root, then request an inclusion proof for one entry.
- Approvals: "Risky tools wait for me. Approving mints a signed, single-use writ bound to the exact arguments."

**2:00–2:30 · It learns** (Agents & DNA, then Lab)
- Agents: "Each agent's behavior is a DNA genome. Evolution only promotes a mutation if it beats the incumbent on a deterministic benchmark."
- Lab: run the self-test (ALL_CLEAR) and show the benchmark history.

**2:30–2:45 · Close** (back on the finished mission deliverable)
"EyeOverThink Agency: local first, on-device when it's private, verified before it counts. Apache 2.0, the link is below."

Stop before 2:55.
