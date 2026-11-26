#!/usr/bin/env node
// Phase 23 reproducible measurement script: Cross-Agency Immune System.
// Boots 4 real local Agency HTTP servers (A, B, C, D) on 127.0.0.1 ephemeral ports with real SQLite,
// real Ed25519 keys, real /mesh/inbox HTTP envelopes, and real local Ollama programVoice (cloudJudge: false).
// Writes structured evidence to docs/phases/evidence-phase23-immune.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agency } from '../src/agency.js';
import { createServer } from '../src/server/server.js';
import { buildPlasmid, openPlasmid } from '../src/core/dna.js';
import { verifyWith } from '../src/core/identity.js';
import { newId, nowIso, sha256 } from '../src/core/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'docs', 'phases', 'evidence-phase23-immune.json');

const CRASH_SKILL = {
  name: 'safe_split_buggy',
  description: 'Split a total bill equally among a number of people.',
  params: {
    type: 'object',
    properties: { total: { type: 'number' }, people: { type: 'number' } },
    required: ['total', 'people'],
  },
  code: 'function main(input) { if (input.people <= 0) throw new RangeError("people must be positive"); return input.total / input.people; }',
  rows: [
    { input: { total: 100, people: 4 }, out: 25 },
    { input: { total: 90, people: 3 }, out: 30 },
  ],
};

const SEMANTIC_BUG_SKILL = {
  name: 'compound_discount_buggy',
  description: 'Final price after applying percentage discounts one after another.',
  params: {
    type: 'object',
    properties: {
      price: { type: 'number' },
      discounts: { type: 'array', items: { type: 'number' } },
    },
    required: ['price', 'discounts'],
  },
  // Classic Phase 15 surcharge bug: adds the second percentage instead of subtracting it.
  code: 'function main(input) { return input.price * (1 - input.discounts[0] / 100) * (1 + (input.discounts[1] || 0) / 100); }',
  rows: [
    { input: { price: 100, discounts: [20, 10] }, out: 88 },
    { input: { price: 50, discounts: [10, 10] }, out: 49.5 },
  ],
};

const HEALTHY_SKILL = {
  name: 'compound_discount',
  description: 'Final price after applying percentage discounts one after another.',
  params: {
    type: 'object',
    properties: {
      price: { type: 'number' },
      discounts: { type: 'array', items: { type: 'number' } },
    },
    required: ['price', 'discounts'],
  },
  code: 'function main(input) { return input.discounts.reduce((p, d) => p * (1 - d / 100), input.price); }',
  rows: [
    { input: { price: 120, discounts: [12, 8] }, out: 97.152 },
    { input: { price: 100, discounts: [10, 10] }, out: 81 },
  ],
};

const DISCOUNT_TASK = 'A jacket costs $150. The store takes 20% off, then a further 5% off the reduced price. What does the jacket cost now?';

async function bootNode(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `phase23-${name.toLowerCase()}-`));
  const agency = new Agency({
    name: `Agency-${name}`,
    home,
    apiToken: `token-${name}`,
    edge: { enabled: false },
    gemini: { apiKey: '' },
    openaiCompat: { url: '', apiKey: '', models: [] },
    dream: { enabled: false },
    crystallize: { auto: false },
    skills: { first: true, learnBinders: false, cloudJudge: false, programVoice: true },
  });
  await agency.boot({ schedulers: false, resume: false });
  const server = createServer(agency);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { name, home, agency, server, url };
}

function seedActiveSkill(agency, spec) {
  const id = newId('sk');
  const codeSha = sha256(spec.code);
  const verification = { method: 'seeded benchmark skill', inputs: spec.rows.length, rows: spec.rows };
  agency.store.run(
    'INSERT INTO skills (id, name, description, params, code, code_sha256, status, source, verification, uses, failures, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
    id, spec.name, spec.description, JSON.stringify(spec.params), spec.code, codeSha, 'active', 'bench:seed', JSON.stringify(verification), nowIso(), nowIso(),
  );
  agency.ledger.append('skill.admit', { id, name: spec.name, codeSha256: codeSha, source: 'bench:seed', inputs: spec.rows.length }, 'crystallizer');
  agency.crystallizer.load();
  return agency.crystallizer.list('active').find((s) => s.name === spec.name);
}

function countUsage(nodes) {
  let totalCalls = 0, localCalls = 0;
  for (const n of nodes) {
    const u = n.agency.router.usage;
    totalCalls += u.calls || 0;
    for (const [k, v] of Object.entries(u.byModel || {})) {
      if (k.startsWith('ollama:') && !k.endsWith('-cloud')) localCalls += v.calls || 0;
    }
  }
  return { totalCalls, localCalls, remoteCalls: totalCalls - localCalls };
}

async function main() {
  const tStart = Date.now();
  const nodes = await Promise.all(['A', 'B', 'C', 'D'].map(bootNode));
  const [A, B, C, D] = nodes;

  try {
    // Pair A <-> B (trusted) and B <-> C (trusted) first so Scenario 1 proves 1-hop gossip (A -> B -> C).
    const bOnA = await A.agency.mesh.addPeer(B.url, 'B');
    const aOnB = await B.agency.mesh.addPeer(A.url, 'A');
    const cOnB = await B.agency.mesh.addPeer(C.url, 'C');
    const bOnC = await C.agency.mesh.addPeer(B.url, 'B');
    A.agency.mesh.setTrust(bOnA.id, 'trusted');
    B.agency.mesh.setTrust(aOnB.id, 'trusted');
    B.agency.mesh.setTrust(cOnB.id, 'trusted');
    C.agency.mesh.setTrust(bOnC.id, 'trusted');

    // ---------------- Scenario 1: Crash containment (A -> B -> C via gossip ttl: 1, 0 GPU calls) ----------------
    const crashA = seedActiveSkill(A.agency, CRASH_SKILL);
    seedActiveSkill(B.agency, CRASH_SKILL);
    seedActiveSkill(C.agency, CRASH_SKILL);

    const beforeS1 = countUsage(nodes);
    const tS1 = Date.now();
    const s1Out = await A.agency.immune.emitAdvisory({
      skill: crashA,
      kind: 'crash',
      input: { total: 100, people: 0 },
      error: 'RangeError: people must be positive',
      ttl: 1,
    });
    const s1Ms = Date.now() - tS1;
    const afterS1 = countUsage(nodes);

    const s1 = {
      ok:
        B.agency.crystallizer.list().find((s) => s.name === CRASH_SKILL.name)?.status === 'quarantined' &&
        C.agency.crystallizer.list().find((s) => s.name === CRASH_SKILL.name)?.status === 'quarantined' &&
        (afterS1.totalCalls - beforeS1.totalCalls) === 0,
      ms: s1Ms,
      gpuCalls: afterS1.totalCalls - beforeS1.totalCalls,
      bStatus: B.agency.crystallizer.list().find((s) => s.name === CRASH_SKILL.name)?.status,
      cStatus: C.agency.crystallizer.list().find((s) => s.name === CRASH_SKILL.name)?.status,
      bRepConfirmedForA: B.agency.store.get('SELECT rep_confirmed FROM peers WHERE id = ?', aOnB.id).rep_confirmed,
      cRepConfirmedForB: C.agency.store.get('SELECT rep_confirmed FROM peers WHERE id = ?', bOnC.id).rep_confirmed,
      emitResult: s1Out,
    };

    // ---------------- Scenario 2: Semantic bug containment (A -> B & C, real Ollama programVoice) ----------------
    // Pair A <-> C so A broadcasts directly to both B and C (ttl: 0).
    const cOnA = await A.agency.mesh.addPeer(C.url, 'C');
    const aOnC = await C.agency.mesh.addPeer(A.url, 'A');
    A.agency.mesh.setTrust(cOnA.id, 'trusted');
    C.agency.mesh.setTrust(aOnC.id, 'trusted');

    const buggyA = seedActiveSkill(A.agency, SEMANTIC_BUG_SKILL);
    seedActiveSkill(B.agency, SEMANTIC_BUG_SKILL);
    seedActiveSkill(C.agency, SEMANTIC_BUG_SKILL);

    const beforeS2 = countUsage(nodes);
    const tS2 = Date.now();
    const s2Out = await A.agency.immune.emitAdvisory({
      skill: buggyA,
      kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] },
      task: DISCOUNT_TASK,
      expectedAnswer: 114,
      ttl: 0,
    });
    const s2Ms = Date.now() - tS2;
    const afterS2 = countUsage(nodes);

    // Verify re-import of the same code_sha256 is rejected on both B and C.
    const { plasmid: buggyPlasmid } = A.agency.crystallizer.exportSkill(SEMANTIC_BUG_SKILL.name, A.agency.keyring.get('agency'));
    const reimpB = await B.agency.crystallizer.importSkill(buggyPlasmid, { trustSigner: A.agency.keyring.get('agency').publicHex });
    const reimpC = await C.agency.crystallizer.importSkill(buggyPlasmid, { trustSigner: A.agency.keyring.get('agency').publicHex });

    const s2 = {
      ok:
        B.agency.crystallizer.list().find((s) => s.name === SEMANTIC_BUG_SKILL.name)?.status === 'quarantined' &&
        C.agency.crystallizer.list().find((s) => s.name === SEMANTIC_BUG_SKILL.name)?.status === 'quarantined' &&
        reimpB.imported === false && /quarantined/i.test(reimpB.reason) &&
        reimpC.imported === false && /quarantined/i.test(reimpC.reason),
      ms: s2Ms,
      localGpuCalls: afterS2.localCalls - beforeS2.localCalls,
      bStatus: B.agency.crystallizer.list().find((s) => s.name === SEMANTIC_BUG_SKILL.name)?.status,
      cStatus: C.agency.crystallizer.list().find((s) => s.name === SEMANTIC_BUG_SKILL.name)?.status,
      reimportBlockedB: reimpB,
      reimportBlockedC: reimpC,
      emitResult: s2Out,
    };

    // ---------------- Scenario 3: Byzantine false-flag attack (D -> B, C against healthy skill) ----------------
    const bOnD = await D.agency.mesh.addPeer(B.url, 'B');
    const cOnD = await D.agency.mesh.addPeer(C.url, 'C');
    const dOnB = await B.agency.mesh.addPeer(D.url, 'D');
    const dOnC = await C.agency.mesh.addPeer(D.url, 'D');
    B.agency.mesh.setTrust(dOnB.id, 'trusted');
    C.agency.mesh.setTrust(dOnC.id, 'trusted');

    const healthyB = seedActiveSkill(B.agency, HEALTHY_SKILL);
    seedActiveSkill(C.agency, HEALTHY_SKILL);

    const tS3 = Date.now();
    // False advisory #1 (fake crash) + #2 (fake wrong_output) against B and C.
    const dB1 = await D.agency.mesh.send(bOnD.id, 'skill.advisory', {
      codeSha256: healthyB.code_sha256, skillName: healthyB.name, kind: 'crash',
      input: { price: 150, discounts: [20, 5] }, ttl: 0,
    });
    const dB2 = await D.agency.mesh.send(bOnD.id, 'skill.advisory', {
      codeSha256: healthyB.code_sha256, skillName: healthyB.name, kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] }, task: DISCOUNT_TASK, expectedAnswer: 999, ttl: 0,
    });
    const dC1 = await D.agency.mesh.send(cOnD.id, 'skill.advisory', {
      codeSha256: healthyB.code_sha256, skillName: healthyB.name, kind: 'crash',
      input: { price: 150, discounts: [20, 5] }, ttl: 0,
    });
    const dC2 = await D.agency.mesh.send(cOnD.id, 'skill.advisory', {
      codeSha256: healthyB.code_sha256, skillName: healthyB.name, kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] }, task: DISCOUNT_TASK, expectedAnswer: 999, ttl: 0,
    });
    const s3Ms = Date.now() - tS3;

    const dPeerOnB = B.agency.store.get('SELECT trust, rep_false_flags FROM peers WHERE id = ?', dOnB.id);
    const dPeerOnC = C.agency.store.get('SELECT trust, rep_false_flags FROM peers WHERE id = ?', dOnC.id);
    const healthyStatusB = B.agency.crystallizer.list().find((s) => s.name === HEALTHY_SKILL.name)?.status;
    const healthyStatusC = C.agency.crystallizer.list().find((s) => s.name === HEALTHY_SKILL.name)?.status;

    const s3 = {
      ok:
        healthyStatusB === 'active' &&
        healthyStatusC === 'active' &&
        dPeerOnB.trust === 'known' && dPeerOnB.rep_false_flags === 2 &&
        dPeerOnC.trust === 'known' && dPeerOnC.rep_false_flags === 2,
      ms: s3Ms,
      falseQuarantines: (healthyStatusB === 'active' ? 0 : 1) + (healthyStatusC === 'active' ? 0 : 1),
      healthyStatusB,
      healthyStatusC,
      dPeerOnB,
      dPeerOnC,
      replies: { dB1, dB2, dC1, dC2 },
    };

    // ---------------- Scenario 4: Security negative controls ----------------
    let unsignedRejected = false;
    try {
      const unsigned = buildPlasmid('unsigned-test', { 'note.txt': 'hello' }, null);
      openPlasmid(unsigned, verifyWith);
    } catch (e) {
      unsignedRejected = /signature/i.test(e.message);
    }

    const piiRes = await A.agency.immune.emitAdvisory({
      skill: buggyA,
      kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] },
      task: 'Customer alice@example.com (SSN 123-45-6789) bought a $150 jacket with 20% off then 5% off.',
    });
    const aLedgerDump = JSON.stringify(A.agency.ledger.list({ limit: 500 }));
    const piiBlockedClean = piiRes.blocked === true && piiRes.sent === 0 && !aLedgerDump.includes('alice@example.com') && !aLedgerDump.includes('123-45-6789');

    const usage = countUsage(nodes);
    const ledgersOk = Object.fromEntries(nodes.map((n) => [n.name, n.agency.ledger.verify().ok]));

    const s4 = {
      ok: unsignedRejected && piiBlockedClean && usage.remoteCalls === 0 && Object.values(ledgersOk).every(Boolean),
      unsignedPlasmidRejected: unsignedRejected,
      piiAdvisoryBlocked: piiBlockedClean,
      remoteCalls: usage.remoteCalls,
      localCalls: usage.localCalls,
      ledgersOk,
    };

    const evidence = {
      phase: 23,
      name: 'Cross-Agency Immune System (Verified Skill Revocation & Peer Reputation)',
      measuredAt: nowIso(),
      totalMs: Date.now() - tStart,
      allPassed: s1.ok && s2.ok && s3.ok && s4.ok,
      scenarios: {
        crashContainment: s1,
        semanticBugContainment: s2,
        byzantineFalseFlag: s3,
        securityNegativeControls: s4,
      },
    };

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + '\n');

    console.log('=== Phase 23 Cross-Agency Immune System Measurement ===');
    console.log(`Scenario 1 (Crash A->B->C gossip, 0 GPU): ${s1.ok ? 'PASS' : 'FAIL'} (${s1.ms}ms, gpuCalls=${s1.gpuCalls}, B=${s1.bStatus}, C=${s1.cStatus})`);
    console.log(`Scenario 2 (Semantic bug via Ollama programVoice): ${s2.ok ? 'PASS' : 'FAIL'} (${s2.ms}ms, localGpuCalls=${s2.localGpuCalls}, B=${s2.bStatus}, C=${s2.cStatus})`);
    console.log(`Scenario 3 (Byzantine false-flag demotion): ${s3.ok ? 'PASS' : 'FAIL'} (${s3.ms}ms, falseQuarantines=${s3.falseQuarantines}, D@B=${s3.dPeerOnB.trust}, D@C=${s3.dPeerOnC.trust})`);
    console.log(`Scenario 4 (Security negative controls): ${s4.ok ? 'PASS' : 'FAIL'} (unsignedRejected=${s4.unsignedPlasmidRejected}, piiBlocked=${s4.piiAdvisoryBlocked}, remoteCalls=${s4.remoteCalls})`);
    console.log(`Evidence saved to: ${OUT_FILE}`);
    if (!evidence.allPassed) process.exitCode = 1;
  } finally {
    for (const n of nodes) {
      n.server.close();
      await n.agency.shutdown();
      try { fs.rmSync(n.home, { recursive: true, force: true }); } catch { /* windows file locks */ }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
