# Phase 25 — Zero-Backend Interactive Browser Playgrounds

[Previous: Phase 24](PHASE-24.md) | [Phase Index](README.md) | [Next: Phase 26](PHASE-26.md)

## Problem

Proving an AI agency's cryptographic receipts, privacy membrane, and zero-call skill induction previously required cloning the repository, installing Ollama, pulling multi-gigabyte weights, and running a local server. Skeptical engineers reviewing a link had no 10-second interactive proof they could attack directly in a browser tab.

## Design

Added a self-contained static site under `playgrounds/` with **zero backend servers, zero external CDN requests, zero npm build steps, and zero Node imports** in `playgrounds/lib/`:
1. **`playgrounds/index.html`** — Landing hub linking all 3 interactive browser labs.
2. **`playgrounds/receipt-lab.html`** — **AI Execution Receipt & Tamper Lab**: uses native browser `crypto.subtle` (`Ed25519` + `SHA-256`) to mint a live v2 RFC 6962 mission receipt client-side, plus **6 one-click "Try to Cheat" attacks** (add 1 trailing space to deliverable, inflate critic score, strip `IN_CLOUD` entry, strip + duplicate `seq`, forge Merkle sibling hash, swap public key) and a paste-your-own `receipt.json` verifier.
3. **`playgrounds/membrane-lab.html`** — **Privacy Membrane & Sentinel Lab**: runs `detect()`, `SealSession`, lenient `unseal()`, digit-squeezed `audit()`, and `scanInjection()` directly in the browser with 3 realistic presets (Clinic Patient Note, DevOps Incident, Hostile Zero-Width Injection) and a 1-click **"Simulate Egress Leak"** button that triggers `MembraneLeak`.
4. **`playgrounds/skill-lab.html`** — **Zero-Call Skill Binder Induction Lab**: runs `induce()`, `leaveOneOut()`, `novelWording()`, `applySpec()`, and `compileSpec()` client-side from 3 verified positives + 1 tax refusal, with 4 one-click test & near-miss trap buttons (valid fresh coat task at 0 calls, sales-tax trap, tip trap, extra-quantity shape trap) plus free-form input.

`playgrounds/lib/` carries the exact zero-dependency ES modules (`receipt-verify.js`, `membrane-core.js`, `sentinel.js`, `binder-induction.js`) so the folder can be deployed directly to GitHub Pages or Firebase Hosting for \$0.

## Measured Results

See [evidence-phase25-playgrounds.json](evidence-phase25-playgrounds.json):
- **0** external `<script>`/`<link>` CDN requests across all 4 HTML pages; **0** `node:` imports across all 4 library modules.
- **6/6** Receipt Tamper Lab attacks caught offline via W3C WebCrypto (~22 ms total for keygen + mint + 7 verifications).
- **100%** parity between `playgrounds/lib/membrane-core.js` and `src/guard/membrane.js`, and byte-for-byte parity between `playgrounds/lib/binder-induction.js` and `src/evolve/binder-induction.js`.
- **3/3** near-miss traps refused in the Skill Binder Lab; valid fresh task routed in <1 ms with 0 model calls.
- Full test suite: **162/162** passing (`npm test`, including 4 new tests in `test/playgrounds.test.js`).

## Known Limits

- Browser Ed25519 WebCrypto requires Chromium 113+, Firefox 129+, or Safari 17+ (or a secure `https://` / `localhost` origin — opening raw `file://` URLs blocks ES module `import` in browsers due to CORS; serve locally with any static server or deploy directly to GitHub Pages).
- The browser Privacy Membrane lab runs the deterministic detectors + owner terms (local LLM NER requires a local Ollama runtime).
