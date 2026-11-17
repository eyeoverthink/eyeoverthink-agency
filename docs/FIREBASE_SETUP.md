# Firebase AI Logic setup (the hybrid edge tier)

The agency runs fully on local Ollama without this. The edge tier adds Firebase AI Logic hybrid inference: Gemini Nano on-device in Chrome when available, cloud Gemini otherwise. It costs $0 on the Spark plan with the Gemini Developer API.

When it is set up, Firebase AI Logic is called at runtime in two ways:

1. **GPU overflow.** The local GPU runs one model call at a time. While it is busy, waiting `fast`, `plan`, `critic` and `reason` calls go to any dashboard tab that is serving as an edge worker, instead of queueing. Private work goes only to Gemini Nano on-device (`ONLY_ON_DEVICE`). Seeded benchmark and evolution calls stay on the local model so comparisons stay paired.
2. **Direct calls** from the Hybrid Edge page.

Every completed call is signed into the ledger as an `edge.inference` entry. The entry records the inference path (`ON_DEVICE` or `IN_CLOUD`), the latency, the Firebase project and a SHA-256 of the output. It never records the prompt or the output text. That is the runtime proof.

## 1. Create the Firebase project (about 5 minutes)
1. Open the [Firebase console](https://console.firebase.google.com/) and create a project. The Spark (free) plan is enough.
2. **AI Logic:** in the left menu choose *AI Logic* (under Build), click *Get started*, and pick the **Gemini Developer API**. It needs no billing account.
3. **Web app:** go to *Project settings → General → Your apps → Add app → Web*. Register it, then keep the `firebaseConfig` block it shows.

## 2. App Check (required by Firebase AI Logic)
1. Go to *App Check → Apps* and register your web app with **reCAPTCHA Enterprise** (the console can create the key) or **reCAPTCHA v3** (create the key at the reCAPTCHA admin site).
2. Copy the public **site key**. It starts with `6L`.
3. To develop on localhost, keep `VITE_APPCHECK_DEBUG=true` (see step 5). Otherwise, add `localhost` to the key's allowed domains.

## 3. Fill `web/.env.local`
```bash
cp web/.env.example web/.env.local
```
Fill these values from the config block in step 1.3 and the site key in step 2.2:

| Variable | From |
|---|---|
| `VITE_FIREBASE_API_KEY` | `apiKey` (starts with `AIza`) |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `VITE_FIREBASE_APP_ID` | `appId` (`1:…:web:…`) |
| `VITE_RECAPTCHA_SITE_KEY` | the App Check site key |
| `VITE_APPCHECK_PROVIDER` | `recaptcha-enterprise` or `recaptcha-v3` |

`web/.env.local` is git-ignored. The doctor fails if it is ever tracked.

## 4. Check, build, serve
```bash
node bin/agency.js edge doctor
```
```bash
cd web && npm run build
```
```bash
node bin/agency.js serve
```
The doctor checks every value's format (and masks secrets in its output), that the file is git-ignored and untracked, and that `web/dist` was built **after** your config changed and actually contains it. Vite bakes the config into the bundle at build time, so after any edit to `.env.local` you must rebuild. The same checklist appears on the dashboard's **Hybrid Edge** page.

## 5. First call
1. Open the dashboard → **Hybrid Edge**.
2. With debug mode on, open the browser console. On the first call the Firebase SDK prints an **App Check debug token**. Add it under *App Check → Apps → ⋮ → Manage debug tokens*, or run `firebase appcheck:debugtokens:create <token> --project <project> --app <appId>`. Never commit it. Tokens are stored **per browser and per origin**: `localhost:8790` and `localhost:5173` (Vite dev) each get their own, so register each one you use. An unregistered token shows as `401 Firebase App Check token is invalid`.
3. In step 3 of the page, type a prompt, choose a mode and click **Generate**. The chip shows `ON_DEVICE` or `IN_CLOUD`, and the call appears in **4 · Proof** with its ledger entry number.
4. Click **Start serving** in step 2, then run a mission. While the GPU is busy, the overflow calls show up in the proof table as `agency-job` entries, and the "GPU overflow calls" counter goes up.

On-device (Gemini Nano) needs desktop Chrome with the Prompt API available. The page shows "Prompt API (Nano): present/absent". If it is absent, `PREFER_ON_DEVICE` calls fall back to `IN_CLOUD`, and private overflow stays local. See the [hybrid inference guide](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) for current Chrome requirements.

## Proof from the CLI
```bash
node bin/agency.js edge proof
```
This lists each ledgered call: entry number, path, origin, mode, latency, project and output hash. `node bin/agency.js ledger verify` re-verifies the whole signed chain.

## Common first-call errors
The dashboard translates these into the fix:

| Error mentions | Fix |
|---|---|
| App Check / 403 | Safelist the debug token, or add localhost to the reCAPTCHA key's domains |
| API key not valid | Recopy `VITE_FIREBASE_API_KEY`, rebuild |
| service disabled / not been used / `AI/api-not-enabled` | Turn on AI Logic with the Gemini Developer API (step 1.2) |
| 403 "Caller does not have required permission to use project … serviceUsageConsumer", right after turning on AI Logic | Usually Google's permission change still spreading after you enable AI Logic; wait a few minutes and retry. To tell it apart from a real key problem: a plain request without App Check (`x-goog-api-key` only) succeeds, while the browser's App Check-verified request returns 403. If it persists past about 15 minutes, open the project's IAM page in the Cloud console, tick "Include Google-provided role grants", and check that the Firebase service agents still have their roles |
| on-device not available | Use `prefer_on_device` or a cloud mode; Nano is unavailable in this browser |
