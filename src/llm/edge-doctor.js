// Edge doctor: offline checks of the Firebase AI Logic setup before the first real call.
// Reads web/.env.local (Vite build-time config), never prints a full secret, and checks the things that
// silently break the edge tier: placeholders, malformed IDs, a committed env file, and a dashboard build
// that predates (or does not contain) the config. The real proof is a call; this makes the first one likely to work.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REQUIRED = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID', 'VITE_RECAPTCHA_SITE_KEY'];
const PLACEHOLDER = /^YOUR_/;

/** Parse a dotenv file: KEY=VALUE lines, # comments, optional quotes. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** Show enough of a value to recognize it, never enough to reuse it. */
export const mask = (v) => (!v ? '(empty)' : v.length <= 8 ? `${v[0]}…` : `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`);

function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

function distContains(distDir, needle) {
  const assets = path.join(distDir, 'assets');
  if (!fs.existsSync(assets)) return false;
  return fs.readdirSync(assets).filter((f) => f.endsWith('.js')).some((f) => fs.readFileSync(path.join(assets, f), 'utf8').includes(needle));
}

/**
 * Run every check. Returns { ok, configured, checks: [{ id, level: 'ok'|'warn'|'error'|'info', message, fix? }] }.
 * ok = no errors. configured = the build can attempt a real Firebase call.
 */
export function edgeDoctor({ root, webDir = path.join(root, 'web'), git = true } = {}) {
  const checks = [];
  const add = (id, level, message, fix) => checks.push({ id, level, message, ...(fix ? { fix } : {}) });
  const envPath = path.join(webDir, '.env.local');

  if (!fs.existsSync(envPath)) {
    add('env-file', 'error', 'web/.env.local does not exist, so the dashboard is built without Firebase config.', 'Copy web/.env.example to web/.env.local and fill it from Firebase console > Project settings > Your apps.');
    return { ok: false, configured: false, checks };
  }
  add('env-file', 'ok', 'web/.env.local exists.');
  const env = parseEnv(fs.readFileSync(envPath, 'utf8'));

  const missing = REQUIRED.filter((k) => !env[k] || PLACEHOLDER.test(env[k]));
  if (missing.length) add('required', 'error', `Missing or still placeholder: ${missing.join(', ')}.`, 'Fill these from the Firebase console web-app config and your reCAPTCHA key.');
  else add('required', 'ok', `All required keys are set (${REQUIRED.length}).`);

  const fmt = (key, re, what, level = 'error') => {
    const v = env[key];
    if (!v || PLACEHOLDER.test(v)) return;
    if (re.test(v)) add(`format-${key}`, 'ok', `${key} looks like ${what}: ${mask(v)}.`);
    else add(`format-${key}`, level, `${key} does not look like ${what}: ${mask(v)}.`, `Copy ${key} again from the Firebase console; check for stray quotes or spaces.`);
  };
  fmt('VITE_FIREBASE_API_KEY', /^AIza[0-9A-Za-z_-]{35}$/, 'a Firebase web API key (AIza…, 39 chars)');
  fmt('VITE_FIREBASE_PROJECT_ID', /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'a Firebase project ID');
  fmt('VITE_FIREBASE_APP_ID', /^1:\d+:web:[0-9a-f]+$/, 'a Firebase web app ID (1:<number>:web:<hex>)');
  fmt('VITE_RECAPTCHA_SITE_KEY', /^6L[0-9A-Za-z_-]{38}$/, 'a reCAPTCHA site key (6L…, 40 chars)', 'warn');

  const pid = env.VITE_FIREBASE_PROJECT_ID;
  if (pid && !PLACEHOLDER.test(pid) && env.VITE_FIREBASE_AUTH_DOMAIN && !env.VITE_FIREBASE_AUTH_DOMAIN.startsWith(`${pid}.`)) {
    add('auth-domain', 'warn', `VITE_FIREBASE_AUTH_DOMAIN (${env.VITE_FIREBASE_AUTH_DOMAIN}) does not start with the project ID ${pid}.`, 'Use the authDomain from the same web-app config block.');
  }
  const provider = (env.VITE_APPCHECK_PROVIDER || 'recaptcha-enterprise').toLowerCase();
  if (!['recaptcha-enterprise', 'recaptcha-v3'].includes(provider)) add('appcheck-provider', 'error', `VITE_APPCHECK_PROVIDER must be recaptcha-enterprise or recaptcha-v3, not "${provider}".`);
  else add('appcheck-provider', 'ok', `App Check provider: ${provider}.`);
  if (env.VITE_APPCHECK_DEBUG === 'true') {
    add('appcheck-debug', 'info', 'App Check debug mode is on for localhost. On the first call the browser console prints a debug token.', 'Firebase console > App Check > Apps > your web app > Manage debug tokens: add that token. Never commit it.');
  } else {
    add('appcheck-debug', 'info', 'App Check debug mode is off, so localhost calls need localhost listed as an allowed domain on your reCAPTCHA key.');
  }
  const cloudModel = env.VITE_CLOUD_MODEL || 'gemini-3.5-flash-lite';
  add('cloud-model', /^gemini-[\w.-]+$/.test(cloudModel) ? 'ok' : 'warn', `Cloud fallback model: ${cloudModel}.`);

  // Secrets must never reach the public repo.
  if (git) {
    try {
      const tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'web/.env.local'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (tracked) add('git-tracked', 'error', 'web/.env.local is TRACKED by git and would be published with the repo.', 'git rm --cached web/.env.local, then rotate the API key restrictions in the Google Cloud console.');
    } catch {
      let ignored = false;
      try { execFileSync('git', ['check-ignore', '-q', 'web/.env.local'], { cwd: root, stdio: 'ignore' }); ignored = true; } catch { /* not ignored or no git */ }
      add('git-tracked', ignored ? 'ok' : 'warn', ignored ? 'web/.env.local is git-ignored and untracked.' : 'web/.env.local is untracked but NOT git-ignored.', ignored ? undefined : 'Add web/.env.local to .gitignore.');
    }
  }

  // Vite bakes env into the bundle at build time: a build older than the config serves the old (or no) config.
  const distDir = path.join(webDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    add('build', 'warn', 'web/dist is not built, so the agency server cannot serve the dashboard.', 'cd web && npm run build (or npm run dev for the Vite dev server).');
  } else {
    const envTime = fs.statSync(envPath).mtimeMs;
    const distTime = newestMtime(distDir);
    if (distTime < envTime) add('build', 'error', 'web/dist was built BEFORE web/.env.local last changed, so the served dashboard has stale config.', 'cd web && npm run build, then reload the dashboard.');
    else if (pid && !PLACEHOLDER.test(pid) && !distContains(distDir, pid)) add('build', 'error', `The built dashboard does not contain project ${pid}; it was built without this config.`, 'cd web && npm run build.');
    else add('build', 'ok', 'The built dashboard is newer than the config and contains it.');
  }

  const errors = checks.filter((c) => c.level === 'error').length;
  return { ok: errors === 0, configured: missing.length === 0, checks };
}
