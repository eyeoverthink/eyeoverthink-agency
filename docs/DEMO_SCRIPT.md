# Demo video script (≤ 3:00) — EyeOverThink Agency · #BuildHybridAI 2026

Only the first 3 minutes are judged. Target 2:45, hard cap 2:55. Record the dashboard at 1080p with browser zoom around 125% so text is readable.

**Every claim in this script has been run on this machine.** The story is the skill library (Phases 9–14): the agency keeps what it learns as verified code, so a kind of task it once paid model calls for ends up costing none. The skill segment was rehearsed live on real models on Nov 17, 2026 ([evidence](phases/evidence-demo-rehearsal.json)). The same kind of task went from 5–8 model calls and about 25 s, to 1 call and about 4 s, to **0 calls and 0.13 s**. All answers were correct, in a first run and again in a dress rehearsal from a fresh copy of the home. Firebase AI Logic answered `IN_CLOUD` in 1.5 s on the same day. Phase 5 proved GPU overflow from a real mission. On-device Gemini Nano is **not** proven yet, so it has its own branch in segment 4: say it on camera only if the recording browser shows it working.

**Before recording (about 15 minutes)**
- [ ] **Start from a fresh copy of the Phase 14 home**, so the "service charge" wording in segment 2 is new to the agency. The rehearsal verified it, and that home can't show the first step again:
  ```bash
  rm -rf F:/Claude-Work/eyeoverthink-agency/demo-home && cp -r F:/Claude-Work/eyeoverthink-agency/phase4-home F:/Claude-Work/eyeoverthink-agency/demo-home
  ```
  ```bash
  node bin/agency.js serve --home F:/Claude-Work/eyeoverthink-agency/demo-home --ollama http://127.0.0.1:11435
  ```
  Ollama on that port must serve the agency's models (llama3.2, fraymus-prime:v1, hermes3, qwen2.5-coder:7b). Keep `phase4-home` itself untouched: it is the Phase 14 evidence.
- [ ] `node bin/agency.js preflight --home F:/Claude-Work/eyeoverthink-agency/demo-home --ollama http://127.0.0.1:11435` prints **READY TO RECORD**. It runs the self-test, edge doctor, ledger verification, model checks and the Firebase proof count.
- [ ] **Warm the models** with one throwaway ask on a different topic (for example "What is 2 + 2?"). The first call after a restart loads the model and adds about 10 s.
- [ ] Open the dashboard in the browser you will record. On **Hybrid Edge**, make one direct call. If the console prints an App Check debug token, register it: debug tokens are per browser *and* per origin. Run `firebase appcheck:debugtokens:create <token> --project eyeoverthink-agency --app 1:359346606211:web:636de318994baad69c8bb6`, then reload.
- [ ] Note the Hybrid Edge stat **"Gemini Nano on-device"**. If it is `available`, use branch A in segment 4. Otherwise use branch B. If it is `downloadable`, you can click *Prepare on-device model* and wait for the download to finish before recording.
- [ ] Paste the three segment-2 tasks into a text file next to the browser, so you can paste rather than type on camera.
- [ ] Nothing secret on screen: no `.env.local`, no API token, no debug tokens, and the browser console closed.
- [ ] Turn off notifications and close other tabs.

---

**1 · 0:00–0:15 · Hook** (Agents & DNA → *Crystallized skills*)
"Most AI products rent intelligence: every question is paid for again, and nothing is kept. This agency runs on my laptop, and it keeps what it learns as verified code it owns. So the second time a kind of question comes up, it costs less, and eventually nothing."
Point at the stats: **tasks answered skill-first** and **of them with zero model calls**.

**2 · 0:15–1:05 · Watch it learn, live** (*Ask the agency* box, same section)
Paste one task at a time and click **Ask**. Keep the **model calls** number and the time in frame.
1. *"A $80 lunch is 10% off, then a 15% service charge is added, and the total is split evenly among 2 friends. How much does each friend pay?"*
   Rehearsed twice: about 25 s (jump-cut the wait), then **5–8 model calls** (it varies), answered by the agents.
   - Point at **Skill declined: unverified wording ("service after % #2" …)**: "It owns skills for this. But it has never verified the words 'service charge' in that position, so it doesn't trust itself, and the agents answer."
   - Point at **Shadow check: … agree**: "Then it quietly checked its own code against the agents' answer: 41.4 both ways. Now that wording is verified."
2. *"A $140 brunch is 20% off, then a 12% service charge is added, and the total is split evenly among 4 friends. How much does each friend pay?"*
   Rehearsed: **1 model call, about 4 s**, answered by a chain of two owned skills. "Same kind of task: one small model call to read the numbers, then a verified chain of two skills does the math."
3. *"A $60 breakfast is 5% off, then a 10% service charge is added, and the total is split evenly among 3 friends. How much does each friend pay?"*
   Rehearsed: **0 model calls, 0.13 s**, answered by the composed skill's learned binder. "And now **zero** model calls: 0.13 seconds, exact. Nobody wrote this skill. The agency composed it from skills it had already verified."

**3 · 1:05–1:30 · Why you can trust what it learned** (scroll down the same section)
- **Capability gaps**: "Tasks it had to refuse aren't thrown away. When two of three different agents agree on the answer, the refusal becomes a training example. Three of them crystallized a new skill, `calculate_final_price_with_tax`, and it had to reproduce the agents' answers before it was admitted."
- **Compositions**: "Chains are trusted only after the judge verified them against the agents twice. Then the agency writes the combined skill itself, with no model, and admits it only if it reproduces every verified chain."
- One line: "In our test runs, zero tasks were misrouted. When it isn't sure, it says so and asks the agents."

**4 · 1:30–2:10 · Firebase AI Logic at runtime** (Hybrid Edge)
- Point at **0 · Setup check: ready**: "The agency checks its own Firebase config, and refuses to run with a stale build or an env file that could be committed."
- "My GPU runs one model call at a time. While it's busy, this tab serves as extra capacity through Firebase AI Logic." Point at the **agency-job** rows in **4 · Proof**: "These calls came from a real mission while the GPU was busy."
- Make one live call in **3 · Try a prompt**:
  - **Branch A (Nano `available`):** choose `only_on_device` and type a private note, e.g. *"Draft a polite reply declining Friday's meeting; I have a medical appointment."* Click Generate and point at the **ON_DEVICE** chip: "Private work is pinned to Gemini Nano on-device. It never left the laptop."
  - **Branch B (Nano not available):** choose `prefer_on_device`, type a public prompt (rehearsed: *"In one sentence: why should a small bakery donate unsold bread?"*, `IN_CLOUD` in 1.5 s), and point at the **IN_CLOUD** chip: "This browser has no Gemini Nano, so Firebase fell back to the cloud, and the ledger says so. Private work never takes this path: it stays on the local GPU."
- Point at the new top row in the proof table: "Signed into the ledger: the path, the latency, a hash of the output, never the prompt."

**5 · 2:10–2:30 · Signed, so you can check** (Ledger)
"Every skill admission, every route, every shadow check and every Firebase call is Ed25519-signed and hash-chained." Point at **VERIFIED** and the Merkle root, then request an inclusion proof for one `skill.route` entry.

**6 · 2:30–2:45 · Close** (back on *Ask the agency*, showing the **0 model calls** card)
"EyeOverThink Agency: local first, Firebase when the GPU is busy, and a library of verified skills that grows from every task. The model is a teacher, not a landlord. Apache 2.0; the link is below."

Stop before 2:55.

---

**If something goes wrong on camera**
- **Task 1 is answered by a skill straight away:** the home has already verified "service charge" (for example, a retake). Stop the server, copy `phase4-home` over `demo-home` again, and restart. Or swap in wording the home has never seen, such as "a 12% delivery fee is added", in all three tasks.
- **The shadow check isn't conclusive** (the agents disagree with each other): nothing is learned, so task 2 also goes to the agents. Say so on camera ("it refuses to learn from a split vote"), or reset and retake. The rehearsal agreed on the first try.
- **Task 3 costs 1 call instead of 0:** the chain route in task 2 feeds the composed skill. If the binder needs one more example, ask a fourth task of the same shape; it will be 0.
- **A Firebase call errors:** the page explains the fix in the toast. Cut, fix (usually an unregistered debug token for this origin), and re-record the segment.
- **An agents' answer reads oddly** (in the rehearsal, a summary line said $38.70 while the working said $41.40): that's the agents, not the skill. "That's exactly why it checks before it learns."

---

**Recording and upload**
- **Recorder:** OBS Studio (free) at 1920×1080, 30 fps, MP4. Windows Game Bar (Win+Alt+R) also works for a single window. Record the browser window only.
- **Audio:** record the narration live, or record the screen silently and add the voiceover afterward. Keep each segment to its time box, and trim dead waiting time (a long model call) with a jump cut rather than talking over it.
- **Length check:** the exported file must be **under 3:00**. Only the first 3 minutes are judged, so aim for 2:45.
- **YouTube:** upload the MP4, set the visibility the contest rules require (check whether public or unlisted is accepted), and put the repo link and "#BuildHybridAI" in the description. Paste the YouTube URL into Devpost.
