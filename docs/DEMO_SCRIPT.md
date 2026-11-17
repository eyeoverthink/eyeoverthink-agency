# Demo video script (≤ 3:00) — EyeOverThink Agency · #BuildHybridAI 2026

Only the first 3 minutes are judged. Target 2:45, hard cap 2:55. Record the dashboard at 1080p with browser zoom around 125% so text is readable.

**Every claim in this script has been run on this machine.** Phase 5 proved Firebase AI Logic `IN_CLOUD` calls and GPU overflow from a real mission. Phase 6 measured the evolution noise floor. On-device Gemini Nano is **not** proven yet, so it has its own branch in segment 3: say it on camera only if the recording browser shows it working.

**Before recording (about 15 minutes)**
- [ ] `node bin/agency.js preflight` prints **READY TO RECORD**. It runs the self-test, edge doctor, ledger verification, model checks and the Firebase proof count.
- [ ] Open the dashboard in the browser you will record. On **Hybrid Edge**, make one direct call. If the console prints an App Check debug token, register it: debug tokens are per browser *and* per origin. Run `firebase appcheck:debugtokens:create <token> --project eyeoverthink-agency --app 1:359346606211:web:636de318994baad69c8bb6`, then reload.
- [ ] Note the Hybrid Edge stat **"Gemini Nano on-device"**. If it is `available`, use branch A in segment 3. Otherwise use branch B. If it is `downloadable`, you can click *Prepare on-device model* and wait for the download to finish before recording.
- [ ] Have one finished mission in Mission Control as a fallback shot.
- [ ] Agents & DNA: the Evolution lab shows the Phase 6 runs (noise floor and fleet results). Re-run the A/A noise measurement only if you have about 25 GPU minutes to spare.
- [ ] Nothing secret on screen: no `.env.local`, no API token, no debug tokens, and the browser console closed.
- [ ] Turn off notifications and close other tabs.

---

**1 · 0:00–0:15 · Hook** (Mission Control)
"This is an AI agency running on my own laptop. A local GPU does the work, Firebase AI Logic adds Gemini when the GPU is busy, every result is checked before it counts, and every act is signed so you can audit it."

**2 · 0:15–0:45 · Launch a mission** (Mission Control)
Before this segment, switch to Hybrid Edge, click **Start serving**, and come back. This tab is now the edge worker.
Type: *"Compare three ways a small bakery could reduce food waste (donations, dynamic pricing, smaller batches): give one benefit and one risk for each, then recommend one."* Click **Launch mission**.
- Task graph: "Genesis planned the team; independent tasks run in parallel."
- **Live thinking**: "Tokens are streaming from the local model."
- If the critic sends a task back: "Solon rejected that attempt and returned the defect; the agent fixed it. That's self-healing."

**3 · 0:45–1:25 · Firebase AI Logic at runtime** (Hybrid Edge)
- Point at **0 · Setup check: ready**: "The agency checks its own Firebase config, and refuses to run with a stale build or an env file that could be committed."
- Point at **workers online 1** and **GPU overflow calls**: "My GPU runs one model call at a time. While the mission keeps it busy, waiting calls overflow to this tab, which runs them through Firebase AI Logic." If the counter has moved, say: "There — real mission calls just went through Firebase."
- Scroll to **4 · Proof**: "Every Firebase call is signed into the ledger: the inference path, the latency, and a hash of the output, never the prompt. These `agency-job` rows came from the mission; the ledger re-verifies on every load."
- **Branch A (Nano `available`):** choose `only_on_device` and type a private note, e.g. *"Draft a polite reply declining Friday's meeting; I have a medical appointment."* Click Generate and point at the **ON_DEVICE** chip: "Private work is pinned to Gemini Nano on-device. It never left the laptop."
- **Branch B (Nano not available):** choose `prefer_on_device`, type a public prompt, and point at the **IN_CLOUD** chip: "This browser has no Gemini Nano, so Firebase fell back to the cloud and the ledger says so. Private work never takes this path: it stays on the local GPU."

**4 · 1:25–1:50 · Trust** (Ledger)
- "Every plan, tool call, memory write, evolution step and Firebase call is Ed25519-signed and hash-chained." Point at **VERIFIED** and the Merkle root, then request an inclusion proof for one `edge.inference` entry.
- Optional, if time allows: Approvals. "Risky tools wait for me; approving mints a signed, single-use writ."

**5 · 1:50–2:30 · Honest evolution** (Agents & DNA → Evolution lab)
- "Each agent's behavior is a DNA genome, and evolution mutates it. Most demos would show a line going up. Here's what ours does instead."
- Show the **noise floor** result: "We ran the same genome twice on identical seeds. It disagreed with itself on [N]% of cells. That's the noise every improvement has to beat." Read N off the screen.
- Show a generation whose verdict reads *"not significant … treated as noise"* or *"did not hold on fresh seeds"*: "So a promotion needs fresh seeds, a sign test that ignores the cells it was selected on, and a check on held-out tasks it never trained on. This one looked better, and the agency refused it."
- If a promotion passed, show its held-out verdict instead.

**6 · 2:30–2:45 · Close** (back on the finished mission deliverable)
"EyeOverThink Agency: local first, Firebase when the GPU is busy, verified before it counts, signed so you can check. Apache 2.0; the link is below."

Stop before 2:55.

---

**If something goes wrong on camera**
- **Overflow counter stays at 0:** the mission didn't hit a busy-GPU moment. Point at the existing `agency-job` rows in the proof table, which are earlier real overflow calls, and keep going.
- **A Firebase call errors:** the page explains the fix in the toast. Cut, fix (usually an unregistered debug token for this origin), and re-record the segment.
- **The mission is slow:** cut to the finished mission from the checklist, and record the overflow segment while a fresh mission runs in the background.

---

**Recording and upload**
- **Recorder:** OBS Studio (free) at 1920×1080, 30 fps, MP4. Windows Game Bar (Win+Alt+R) also works for a single window. Record the browser window only.
- **Audio:** record the narration live, or record the screen silently and add the voiceover afterward. Keep each segment to its time box, and trim dead waiting time (a long model call) with a jump cut rather than talking over it.
- **Length check:** the exported file must be **under 3:00**. Only the first 3 minutes are judged, so aim for 2:45.
- **YouTube:** upload the MP4, set the visibility the contest rules require (check whether public or unlisted is accepted), and put the repo link and "#BuildHybridAI" in the description. Paste the YouTube URL into Devpost.
