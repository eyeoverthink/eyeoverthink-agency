# Phase 7: Contest submission prep

Previous: [Phase 6](PHASE-6.md) · Next: [Phase 8](PHASE-8.md) · [Index](README.md)

## Summary
Phase 7 gets the #BuildHybridAI submission ready (deadline Nov 30, 2026, 2:00 PM PT). The rule applied throughout: **the video and Devpost text may only claim what has actually run on this machine.**

## What was built
1. **`agency preflight`**: one GO/NO-GO command for recording day.
   - **Blocking checks:** the self-test, the edge doctor (Firebase config ready and the build current), ledger verification, Ollama serving models, and the `plan`, `reason`, `code` and `critic` roles resolving.
   - **Notes:** how many Firebase calls are already ledgered (by path and origin), and whether ON_DEVICE is proven. If it isn't, the note says to claim it on camera only if the recording browser shows Nano `available`.
   - Exits with code 5 when not ready.
   - Verified against an empty home with no models: 6 blocking checks failed, as expected.
2. **[DEMO_SCRIPT.md](../DEMO_SCRIPT.md), rewritten.** The Phase 2 script promised on-device Nano and described evolution in a way Phases 4 to 6 disproved. The new script:
   - starts the edge worker before launching a mission, so **GPU overflow happens live** on camera, then shows the setup check, the overflow counter and the signed proof table;
   - has **two branches**: show ONLY_ON_DEVICE with a private note if Nano is `available`, otherwise show the honest IN_CLOUD fallback and say private work stays on the local GPU;
   - presents evolution as **the agency refusing its own lucky result**: the noise floor, then the fresh-seed sign test, then the held-out check;
   - includes on-camera recovery steps, plus recording (OBS, 1080p) and YouTube upload steps.
3. **[DEVPOST.md](../DEVPOST.md)**: targeted edits.
   - The tagline now leads with Firebase as overflow capacity and signed audit.
   - New sections cover GPU overflow, the ledgered proof (3 of 160 mission calls through Firebase), and the setup doctor.
   - The challenges now include the real-call bugs and the evolution noise problem.
   - The test count is updated to 58.
4. **[SUBMISSION_CHECKLIST.md](../SUBMISSION_CHECKLIST.md)**: each contest requirement with its evidence. Firebase at runtime and Apache-2.0 are done; the public repo and the video are still the user's. It also covers the pre-publication steps (secret rotation, App Check enforcement, deleting debug tokens) and the exact command to make the repo public.
5. **History scan.** The full git history contains no real Firebase or reCAPTCHA keys. The only token-like match is a fake key inside a redaction test.

## Files changed
- **Source:** `src/cli/cli.js` (`preflight`).
- **Docs:** `docs/DEMO_SCRIPT.md`, `docs/DEVPOST.md`, `docs/SUBMISSION_CHECKLIST.md` (new), `docs/phases/PHASE-7.md`, `README.md` (links).

## Patterns used
- Claims are tied to evidence: every sentence of the script maps to a run or a ledger entry.
- Branching scripts for capabilities that depend on the environment (Nano availability).
- One command decides whether you're ready.

## Remaining (user)
- Record and upload the video.
- Make the repo public, with the command in the checklist.
- Rotate the reCAPTCHA secret and the old leaked keys.
