# Demo video script (≤ 3:00) — EyeOverThink Agency · #BuildHybridAI 2026

Only the first 3 minutes are judged. Target 2:45, hard cap 2:55. Record the dashboard at 1080p with browser zoom around 125% so text is readable.

**Every claim in this script has been run on this machine**, most recently in a full dress rehearsal through the dashboard on Nov 17, 2026 ([evidence](phases/evidence-demo-rehearsal-2.json)).

The story: the agency **keeps what it learns as verified code** (Phases 9–14), **measures who to believe** and **checks every number it gives** (Phases 17–19), and uses **Firebase AI Logic (Gemini) as its most accurate judge** while local models do the work.

Rehearsed, all correct:
- the same kind of task went from **4 model calls (15.6 s), to 1 call (4.6 s), to 0 calls (0.13 s)**;
- a work-rate answer was confirmed live by Gemini via Firebase AI Logic.

On-device Gemini Nano is **not** proven, so it is not claimed.

**Before recording (about 15 minutes)**
- [ ] **Start from a fresh copy of the frozen demo base.** It is the Phase 14 home plus the two real voice studies, so the "service charge" wording is new and the measured voices and the measured first agent are present:
  ```bash
  rm -rf F:/Claude-Work/eyeoverthink-agency/demo-home && cp -r F:/Claude-Work/eyeoverthink-agency/demo-base F:/Claude-Work/eyeoverthink-agency/demo-home
  ```
  ```bash
  node bin/agency.js serve --home F:/Claude-Work/eyeoverthink-agency/demo-home --ollama http://127.0.0.1:11435
  ```
  Ollama on that port must serve the agency's models (llama3.2, fraymus-prime:v1, hermes3, qwen2.5-coder:7b). Never record into `demo-base` itself.
- [ ] `node bin/agency.js preflight --home F:/Claude-Work/eyeoverthink-agency/demo-home --ollama http://127.0.0.1:11435` prints **READY TO RECORD**.
- [ ] Open the dashboard in the browser you will record. On **Hybrid Edge**, click **Start serving** and check that **workers online** shows 1. **Without this, Gemini is not a judge in the video.** If the console prints an App Check debug token, register it (debug tokens are per browser *and* per origin): `firebase appcheck:debugtokens:create <token> --project eyeoverthink-agency --app 1:359346606211:web:636de318994baad69c8bb6`, then reload and start serving again. Keep this tab open for the whole recording.
- [ ] **Warm the models** with one throwaway ask in the Ask box: "What is 12 + 30?" The first call after a restart loads a model and adds about 10 s.
- [ ] Paste the four tasks below into a text file next to the browser, so you can paste rather than type on camera.
- [ ] Nothing secret on screen: no `.env.local`, no API token, no debug tokens, and the browser console closed.
- [ ] Turn off notifications and close other tabs.

---

**1 · 0:00–0:12 · Hook** (Agents & DNA → *Crystallized skills*, the Ask box in view)
"Most AI products rent intelligence: every question is paid for again, and nothing is kept. This agency runs on my laptop, keeps what it learns as verified code, and checks every number it gives."

**2 · 0:12–0:55 · Watch it learn, live** (*Ask the agency*)
Paste each task and click **Ask**. Keep the **model calls** number and the time in frame.
1. *"A $80 lunch is 10% off, then a 15% service charge is added, and the total is split evenly among 2 friends. How much does each friend pay?"*
   Rehearsed: **4 model calls, about 16 s** (jump-cut the wait).
   - "It owns skills for this, but has never verified the words 'service charge'. So it doesn't trust itself: an agent answers. forge_keeper is chosen because it was measured most accurate."
   - Point at **Shadow check … agree**: "Then it checked its own code against that answer. 41.40 both ways. Now that wording is verified."
2. *"A $140 brunch is 20% off, then a 12% service charge is added, and the total is split evenly among 4 friends. How much does each friend pay?"*
   Rehearsed: **1 call, about 4.6 s**. "One small call to read the numbers; a verified chain of two owned skills does the math."
3. *"A $60 breakfast is 5% off, then a 10% service charge is added, and the total is split evenly among 3 friends. How much does each friend pay?"*
   Rehearsed: **0 model calls, 0.13 s**. "And now zero model calls, exact. Nobody wrote this skill: the agency composed it from skills it had already verified."

**3 · 0:55–1:25 · It checks every number** (same section)
4. *"Printer A prints a batch in 6 hours and printer B prints it in 12 hours. Working together, how many hours do they need?"*
   Rehearsed: **4 hours**, with *"Checked: Gemini via Firebase AI Logic independently got 4."*
   - "No skill covers this, so nothing would have checked it. Now every number gets a second, independent voice. When they disagree, a third settles it, and if all three differ it says 'unverified' instead of guessing."
- Scroll to **Judge voices**: "Who to believe was measured, not assumed: 40 tasks with known answers. Gemini 100%, forge_keeper 95%, the old default agent 50 to 70%. So the most accurate local agent answers first, and Gemini judges."

**4 · 1:25–1:50 · Firebase AI Logic at runtime** (Hybrid Edge)
- Point at **workers online 1**: "This browser tab is the agency's Firebase AI Logic worker."
- Scroll to **4 · Proof**: "Every Gemini call is signed into the ledger: the inference path, the latency, a hash of the output, never the prompt. These rows with origin **judge** are the checks you just watched."
- "And it's guarded: if a task holds anything private, like an email, a key or my own sensitive terms, Gemini is never asked."

**5 · 1:50–2:20 · Where every skill came from** (Agents & DNA → *Skill family tree*)
- "This tree is drawn only from signed ledger entries. Gold skills came from solved tasks. This coral one was learned from tasks the agency had to *refuse*. Violet ones it composed itself."
- "Skills can also travel between agencies as signed plasmids. The receiver re-checks everything and keeps the skill on probation until its own agents agree. A brand-new agency pulled skills from a peer that way, and the peer never saw a single task."

**6 · 2:20–2:35 · Signed, so you can check** (Ledger)
Point at **VERIFIED** and the Merkle root: "Every skill, route, check and Firebase call is Ed25519-signed and hash-chained."

**7 · 2:35–2:48 · Close** (back on the Ask box, the **0 model calls** card)
"EyeOverThink Agency: local models do the work, Gemini through Firebase AI Logic keeps it honest, and everything it learns is verified, owned and signed. Apache 2.0; the link is below."

Stop before 2:55.

---

**If something goes wrong on camera**
- **Task 1 is answered by a skill straight away:** the home has already verified "service charge" (for example, a retake). Stop the server, copy `demo-base` over `demo-home` again, and restart. Or swap in wording the home has never seen, such as "a 12% delivery fee is added", in all three tasks.
- **The shadow check isn't conclusive** (the agents disagree with each other): nothing is learned, so task 2 also goes to the agents. Say so on camera ("it refuses to learn from a split vote"), or reset and retake. The rehearsal agreed on the first try.
- **Task 3 costs 1 call instead of 0:** the chain route in task 2 feeds the composed skill. If the binder needs one more example, ask a fourth task of the same shape; it will be 0.
- **Task 4 says "Checked: agent tycho…" instead of Gemini:** the Firebase worker isn't serving (a reload stops it). Open Hybrid Edge, click **Start serving**, and retake segment 3.
- **Task 4 comes back corrected or "Unverified":** that is the check working. Say what it shows ("the first answer was outvoted" / "the voices disagree, so it won't pretend to be sure") and keep going.
- **A Firebase call errors:** the page explains the fix in the toast. Cut, fix (usually an unregistered debug token for this origin), and re-record the segment.
- **An agents' answer reads oddly** (in the rehearsal, a summary line said $38.70 while the working said $41.40): that's the agents, not the skill. "That's exactly why it checks before it learns."

---

**Recording and upload**
- **Recorder:** OBS Studio (free) at 1920×1080, 30 fps, MP4. Windows Game Bar (Win+Alt+R) also works for a single window. Record the browser window only.
- **Audio:** record the narration live, or record the screen silently and add the voiceover afterward. Keep each segment to its time box, and trim dead waiting time (a long model call) with a jump cut rather than talking over it.
- **Length check:** the exported file must be **under 3:00**. Only the first 3 minutes are judged, so aim for 2:45.
- **YouTube:** upload the MP4, set the visibility the contest rules require (check whether public or unlisted is accepted), and put the repo link and "#BuildHybridAI" in the description. Paste the YouTube URL into Devpost.
