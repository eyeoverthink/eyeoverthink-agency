# #BuildHybridAI 2026 submission checklist

Deadline: **Nov 30, 2026, 2:00 PM PT**. Status as of Nov 17, 2026 (code frozen after Phase 19; script re-rehearsed), each line checked against the repo or a real run.

| Requirement | Status | Evidence |
|---|---|---|
| Firebase AI Logic called at runtime | **Done** | Real project `eyeoverthink-agency`: direct calls plus 3 GPU-overflow calls from a real mission, each signed into the ledger as `edge.inference` ([Phase 5](phases/PHASE-5.md)). `node bin/agency.js edge proof` lists them. |
| Apache-2.0 license | **Done** | `LICENSE` (Apache 2.0); `"license": "Apache-2.0"` in both `package.json` files; GitHub detects `apache-2.0`. |
| Public repository | **Done** (Nov 18) | https://github.com/eyeoverthink/eyeoverthink-agency is public; a signed-out visit loads it. Default branch `master`. |
| YouTube video, 3 minutes or less | **Done** | https://www.youtube.com/watch?v=dXUTdhnmbvA (2:52, public). Built from the live take of [DEMO_SCRIPT.md](DEMO_SCRIPT.md), which was re-rehearsed through the dashboard on real models after the freeze ([evidence](phases/evidence-demo-rehearsal-2.json)): skill learning live (4 calls → 1 → **0 calls, 0.13 s**) and a number checked live by Gemini via Firebase AI Logic. Record from a fresh copy of `demo-base`, with the Firebase worker serving. |
| Devpost text | **Ready to paste** (Nov 18) | [DEVPOST.md](DEVPOST.md): name, links, 200-character pitch, video, About sections, Built with. **Submit (you).** |

## Before making the repo public
- [x] Secret scan on the full history of all branches (Nov 18): no real keys; only fake `sk-` keys in the redaction tests and a lockfile hash.
- [x] `web/.env.local` is untracked and gitignored; only `web/.env.example` is in git.
- [ ] Rotate the reCAPTCHA **secret** (it was pasted into a chat), then update it in Firebase console → App Check.
- [ ] Rotate the Gemini key and `FRAYMUS_TOKEN` found in `fraynix-dreamer-120b/boot_daemon.vbs`. That's a different repo, but those keys should not stay live.
- [ ] Firebase console: add your public demo domain (if any) to the reCAPTCHA key, turn on App Check **enforcement** for AI Logic, and delete debug tokens you no longer use.

Make the repo public:
```bash
gh repo edit eyeoverthink/eyeoverthink-agency --visibility public --accept-visibility-change-consequences
```

## Recording day
Copy `demo-base` to `demo-home`, start the server, and start serving on Hybrid Edge (the script's checklist), then:
```bash
node bin/agency.js preflight --home F:/Claude-Work/eyeoverthink-agency/demo-home --ollama http://127.0.0.1:11435
```
It must print `READY TO RECORD`. Then follow [DEMO_SCRIPT.md](DEMO_SCRIPT.md).
