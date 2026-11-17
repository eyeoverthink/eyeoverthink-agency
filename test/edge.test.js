// Phase 5: the Firebase AI Logic edge tier. Setup doctor, GPU-overflow routing, and ledgered proof of every call.
// No Firebase account is needed: a test plays the browser worker (register, claim, complete) over the hub API.
import { makeAgency } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { edgeDoctor, parseEnv, mask } from '../src/llm/edge-doctor.js';
import { sha256 } from '../src/core/util.js';

const okFinal = { thought: 'done', final: 'ok', confidence: 0.9 };
const GOOD = {
  VITE_FIREBASE_API_KEY: `AIza${'a'.repeat(35)}`,
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-agency.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-agency',
  VITE_FIREBASE_APP_ID: '1:123456789012:web:abcdef0123456789',
  VITE_RECAPTCHA_SITE_KEY: `6L${'b'.repeat(38)}`,
  VITE_APPCHECK_PROVIDER: 'recaptcha-enterprise',
  VITE_APPCHECK_DEBUG: 'true',
  VITE_CLOUD_MODEL: 'gemini-3.5-flash-lite',
};
const envText = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');

function tmpWeb() {
  const dir = fs.mkdtempSync(path.join(process.env.AGENCY_TEST_DIR || os.tmpdir(), 'edge-doctor-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function build(dir, content, mtime) {
  fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html>');
  const f = path.join(dir, 'dist', 'assets', 'index.js');
  fs.writeFileSync(f, content);
  if (mtime) { fs.utimesSync(f, mtime, mtime); fs.utimesSync(path.join(dir, 'dist', 'index.html'), mtime, mtime); }
}
const level = (r, id) => r.checks.find((c) => c.id === id)?.level;

test('edge doctor: dotenv parsing and secret masking', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\nC=x # trailing\n bad line\nD=\'q\''), { A: '1', B: 'two words', C: 'x', D: 'q' });
  assert.equal(mask(''), '(empty)');
  const m = mask(GOOD.VITE_FIREBASE_API_KEY);
  assert.ok(m.startsWith('AIza') && m.includes('39 chars') && !m.includes('a'.repeat(10)), 'never shows enough to reuse');
});

test('edge doctor: missing file, placeholders, malformed IDs, stale build, then ready', () => {
  const t = tmpWeb();
  try {
    let r = edgeDoctor({ root: t.dir, webDir: t.dir, git: false });
    assert.equal(r.ok, false);
    assert.equal(level(r, 'env-file'), 'error');

    fs.copyFileSync(path.resolve('web/.env.example'), path.join(t.dir, '.env.local'));
    r = edgeDoctor({ root: t.dir, webDir: t.dir, git: false });
    assert.equal(r.configured, false);
    assert.match(r.checks.find((c) => c.id === 'required').message, /VITE_FIREBASE_API_KEY/);

    fs.writeFileSync(path.join(t.dir, '.env.local'), envText({ ...GOOD, VITE_FIREBASE_API_KEY: 'AIzaTOO-SHORT', VITE_APPCHECK_PROVIDER: 'captcha' }));
    r = edgeDoctor({ root: t.dir, webDir: t.dir, git: false });
    assert.equal(level(r, 'format-VITE_FIREBASE_API_KEY'), 'error');
    assert.equal(level(r, 'appcheck-provider'), 'error');
    assert.ok(!JSON.stringify(r).includes('AIzaTOO-SHORT'), 'the malformed key is masked in the report');

    fs.writeFileSync(path.join(t.dir, '.env.local'), envText(GOOD));
    const past = new Date(Date.now() - 3600_000);
    build(t.dir, 'const p="demo-agency";', past);
    r = edgeDoctor({ root: t.dir, webDir: t.dir, git: false });
    assert.equal(level(r, 'build'), 'error');
    assert.match(r.checks.find((c) => c.id === 'build').message, /BEFORE/);

    build(t.dir, 'const p="someone-else";');
    r = edgeDoctor({ root: t.dir, webDir: t.dir, git: false });
    assert.match(r.checks.find((c) => c.id === 'build').message, /does not contain project demo-agency/);

    build(t.dir, 'const p="demo-agency";');
    r = edgeDoctor({ root: t.dir, webDir: t.dir, git: false });
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.level === 'error')));
    assert.equal(r.configured, true);
    assert.equal(level(r, 'build'), 'ok');
    assert.equal(level(r, 'appcheck-debug'), 'info');
  } finally { t.cleanup(); }
});

test('edge doctor on this repo: web/.env.local can never be committed', () => {
  const r = edgeDoctor({ root: path.resolve('.') });
  const g = r.checks.find((c) => c.id === 'git-tracked');
  if (g) assert.notEqual(g.level, 'error', g.message);
  assert.ok(fs.readFileSync('.gitignore', 'utf8').includes('web/.env.local'));
});

/** Play the browser: claim the next edge job and answer it. */
async function serveOne(hub, workerId, answer) {
  const { job } = await hub.claim(workerId, 2000);
  assert.ok(job, 'a job was routed to the edge worker');
  hub.complete(workerId, job.id, answer(job));
  return job;
}

test('GPU overflow: a busy GPU sends eligible calls to the Firebase edge worker, seeded and private-without-Nano calls stay local', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const { router, edge: hub } = A.agency;
    const firstKey = async (req) => (await router.candidates(req))[0]?.key;
    const w = hub.register({ label: 'Chrome/141', onDevice: 'unavailable', project: 'demo-agency', cloudModel: 'gemini-3.5-flash-lite' });

    assert.equal(await firstKey({ role: 'fast' }), 'scripted:scripted', 'GPU idle: no overflow');
    router.gpu.active = router.gpu.max; // simulate a generation holding the GPU
    try {
      assert.equal(await firstKey({ role: 'fast' }), 'edge:edge:prefer_on_device');
      assert.equal(await firstKey({ role: 'reason' }), 'edge:edge:prefer_on_device');
      assert.equal(await firstKey({ role: 'code' }), 'scripted:scripted', 'roles outside the overflow list wait for the GPU');
      assert.equal(await firstKey({ role: 'fast', seed: 7 }), 'scripted:scripted', 'seeded (benchmark/evolution) calls stay on one model');
      assert.equal(await firstKey({ role: 'fast', model: 'scripted' }), 'scripted:scripted', 'explicit model requests are honored');
      assert.equal(await firstKey({ role: 'fast', privacy: 'private' }), 'scripted:scripted', 'private work never overflows to a worker without Gemini Nano');
      hub.heartbeat(w.id, { onDevice: 'downloadable' });
      assert.equal(await firstKey({ role: 'fast', privacy: 'private' }), 'scripted:scripted', 'a model that still has to download does not count');
      hub.heartbeat(w.id, { onDevice: 'available' });
      assert.equal(await firstKey({ role: 'fast', privacy: 'private' }), 'edge:edge:only_on_device', 'private overflow is pinned to ON_DEVICE');

      // End to end: router.chat -> edge job -> the "browser" answers -> result, usage counter, signed ledger entry.
      const pending = router.chat({ role: 'fast', messages: [{ role: 'user', content: 'say hi' }] });
      const job = await serveOne(hub, w.id, () => ({ text: 'hi from Firebase', inferenceSource: 'IN_CLOUD' }));
      const res = await pending;
      assert.equal(job.mode, 'prefer_on_device');
      assert.equal(res.text, 'hi from Firebase');
      assert.equal(res.provider, 'edge/IN_CLOUD');
      assert.equal(router.usage.edgeOverflow, 1);
    } finally { router.gpu.active = 0; }

    const [entry] = A.agency.ledger.list({ limit: 1, kind: 'edge.inference' });
    assert.equal(entry.data.origin, 'agency-job');
    assert.equal(entry.data.inferenceSource, 'IN_CLOUD');
    assert.equal(entry.data.project, 'demo-agency');
    assert.equal(entry.data.sha256, sha256('hi from Firebase'));
    assert.ok(!JSON.stringify(entry.data).includes('hi from Firebase') && !JSON.stringify(entry.data).includes('say hi'), 'neither prompt nor output text is ledgered');
    assert.ok(A.agency.ledger.verify().ok);
  } finally { await A.cleanup(); }
});

test('edge attestations from the dashboard are sanitized and signed', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const good = A.agency.edge.attest({ origin: 'playground', mode: 'only_on_device', inferenceSource: 'ON_DEVICE', latencyMs: 812.6, chars: 120, sha256: sha256('x'), project: 'demo-agency', cloudModel: 'gemini-3.5-flash-lite' });
    assert.equal(good.kind, 'edge.inference');
    assert.equal(good.data.latencyMs, 813);
    assert.equal(A.agency.edge.stats.ON_DEVICE, 1);
    const lower = A.agency.edge.attest({ origin: 'playground', mode: 'only_in_cloud', inferenceSource: 'in_cloud', latencyMs: 1, chars: 1, sha256: sha256('y') });
    assert.equal(lower.data.inferenceSource, 'IN_CLOUD', 'lower-case InferenceSource values from the SDK are accepted');
    const junk = A.agency.edge.attest({ origin: 'evil', mode: 'x'.repeat(500), inferenceSource: 'MOON', latencyMs: -5, chars: 'lots', sha256: 'not-a-hash', project: 'p'.repeat(500) });
    assert.equal(junk.data.origin, 'agency-job');
    assert.equal(junk.data.inferenceSource, 'UNKNOWN');
    assert.equal(junk.data.latencyMs, 0);
    assert.equal(junk.data.sha256, null);
    assert.ok(junk.data.mode.length <= 24 && junk.data.project.length <= 40);
    assert.ok(A.agency.ledger.verify().ok);
  } finally { await A.cleanup(); }
});
