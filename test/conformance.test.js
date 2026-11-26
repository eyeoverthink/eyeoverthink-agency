// Phase 26 tests: Tri-Runtime Golden Conformance Suite (Node.js node:crypto, W3C WebCrypto, Single-File Pure Java).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runConformance } from '../conformance/v1/runners/node-verify.mjs';
import { runConformanceDoc } from '../conformance/v1/runners/webcrypto-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VEC = path.join(ROOT, 'conformance', 'v1', 'vectors.json');
const JAVA_RUNNER = path.join(ROOT, 'conformance', 'v1', 'runners', 'SvaConformance.java');
const WEBCRYPTO_RUNNER = path.join(ROOT, 'conformance', 'v1', 'runners', 'webcrypto-verify.mjs');

test('SVA v1.0 specs and 62-vector golden suite exist and WebCrypto runner has zero node:crypto imports', () => {
  for (const spec of ['AER-1.md', 'VSC-1.md', 'EMA-1.md']) {
    const p = path.join(ROOT, 'docs', 'specs', spec);
    assert.ok(fs.existsSync(p), `missing spec ${spec}`);
    assert.ok(fs.readFileSync(p, 'utf8').length > 1000);
  }
  const doc = JSON.parse(fs.readFileSync(VEC, 'utf8'));
  assert.equal(doc.total, 62);
  assert.equal(doc.vectors.length, 62);
  const wcSrc = fs.readFileSync(WEBCRYPTO_RUNNER, 'utf8');
  assert.ok(!/(?:from|import\s*\(|require\s*\()\s*['"]node:crypto['"]/.test(wcSrc), 'WebCrypto verifier must never import node:crypto');
});

test('Tri-Runtime Conformance #1: Node.js (node:crypto) passes 62/62 golden vectors', () => {
  const res = runConformance(VEC);
  assert.equal(res.failed, 0, JSON.stringify(res.failures));
  assert.equal(res.passed, 62);
});

test('Tri-Runtime Conformance #2: W3C Browser WebCrypto (globalThis.crypto.subtle) passes 62/62 golden vectors', async () => {
  const doc = JSON.parse(fs.readFileSync(VEC, 'utf8'));
  const res = await runConformanceDoc(doc);
  assert.equal(res.failed, 0, JSON.stringify(res.failures));
  assert.equal(res.passed, 62);
});

test('Tri-Runtime Conformance #3: Single-File Pure Java (zero deps) passes 62/62 golden vectors bit-for-bit', (t) => {
  let javaOk = true;
  try { execFileSync('java', ['-version'], { stdio: 'pipe' }); } catch { javaOk = false; }
  if (!javaOk) { t.skip('java not installed in this environment'); return; }
  const out = execFileSync('java', [JAVA_RUNNER, VEC], { encoding: 'utf8' });
  const res = JSON.parse(out.trim());
  assert.equal(res.failed, 0, JSON.stringify(res.failures));
  assert.equal(res.passed, 62);
  assert.equal(res.total, 62);
});
