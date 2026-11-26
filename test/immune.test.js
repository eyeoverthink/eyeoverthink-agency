// Phase 23: Cross-Agency Immune System (Verified Skill Revocation & Peer Reputation).
import { makeAgency } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlasmid, openPlasmid } from '../src/core/dna.js';
import { verifyWith } from '../src/core/identity.js';
import { Store } from '../src/storage/db.js';
import { newId, nowIso, sha256 } from '../src/core/util.js';

const HEALTHY_DISCOUNT = {
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

const BUGGY_DISCOUNT = {
  ...HEALTHY_DISCOUNT,
  name: 'buggy_discount',
  code: 'function main(input) { return input.price * (1 - input.discounts[0] / 100) * (1 + (input.discounts[1] || 0) / 100); }',
  rows: [
    { input: { price: 100, discounts: [20, 10] }, out: 88 },
    { input: { price: 50, discounts: [10, 10] }, out: 49.5 },
  ],
};

const CRASHY_SKILL = {
  name: 'crashy_split',
  description: 'Split a bill equally among people.',
  params: {
    type: 'object',
    properties: {
      total: { type: 'number' },
      people: { type: 'number' },
    },
    required: ['total', 'people'],
  },
  code: 'function main(input) { if (input.people <= 0) throw new RangeError("people must be > 0"); return input.total / input.people; }',
  rows: [
    { input: { total: 100, people: 4 }, out: 25 },
    { input: { total: 90, people: 3 }, out: 30 },
  ],
};

const GROUNDED_TASK = 'A jacket costs $150. The store takes 20% off, then a further 5% off the reduced price. What does the jacket cost now?';

async function listen(agency) {
  const { createServer } = await import('../src/server/server.js');
  const server = createServer(agency);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Seed an active skill directly with a signed ledger admission entry so it can be exported/invoked/quarantined. */
function seedSkill(agency, spec) {
  const id = newId('sk');
  const codeSha = sha256(spec.code);
  const verification = { method: 'seeded test', inputs: spec.rows.length, rows: spec.rows };
  agency.store.run(
    'INSERT INTO skills (id, name, description, params, code, code_sha256, status, source, verification, uses, failures, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
    id, spec.name, spec.description, JSON.stringify(spec.params), spec.code, codeSha, 'active', 'test:seed', JSON.stringify(verification), nowIso(), nowIso(),
  );
  agency.ledger.append('skill.admit', { id, name: spec.name, codeSha256: codeSha, source: 'test:seed', inputs: spec.rows.length }, 'crystallizer');
  agency.crystallizer.load();
  return agency.crystallizer.list('active').find((s) => s.name === spec.name);
}

/** Seed an active learned binder for a skill to verify quarantine retires it. */
function seedBinder(agency, skillName) {
  const code = 'function bind(task) { return null; }';
  agency.store.run(
    'INSERT INTO skill_binders (id, skill, code, code_sha256, status, verification, examples, uses, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    newId('sb'), skillName, code, sha256(code), 'active', '{}', 3, nowIso(), nowIso(),
  );
}

test('Audit C2: openPlasmid rejects unsigned plasmids when verify is provided', async () => {
  const { agency, cleanup } = await makeAgency(() => 'ok');
  try {
    const id = agency.keyring.get('agency');
    const signed = buildPlasmid('signed', { 'a.txt': 'hello' }, id);
    const unsigned = buildPlasmid('unsigned', { 'a.txt': 'hello' }, null);

    // Without verify callback, unsigned plasmid still decodes (non-authenticated inspection).
    assert.equal(openPlasmid(unsigned).parts['a.txt'].toString(), 'hello');
    // With verify callback, signed plasmid succeeds.
    assert.equal(openPlasmid(signed, verifyWith).parts['a.txt'].toString(), 'hello');
    // With verify callback, unsigned / missing sig / missing signer MUST fail closed.
    assert.throws(() => openPlasmid(unsigned, verifyWith), /signature/i);
    assert.throws(() => openPlasmid({ ...signed, sig: null }, verifyWith), /signature/i);
    assert.throws(() => openPlasmid({ ...signed, signer: null }, verifyWith), /signature/i);
  } finally {
    await cleanup();
  }
});

test('Migration v9: creates skill_advisories table and peer reputation columns', () => {
  const store = new Store(':memory:');
  try {
    const ver = store.get('SELECT version FROM schema_version').version;
    assert.equal(ver, 9);

    const advCols = store.all('PRAGMA table_info(skill_advisories)').map((c) => c.name);
    for (const col of ['id', 'code_sha256', 'skill_name', 'sender_key', 'kind', 'counterexample', 'verdict', 'detail', 'created']) {
      assert.ok(advCols.includes(col), `missing column ${col} on skill_advisories`);
    }

    const peerCols = store.all('PRAGMA table_info(peers)').map((c) => c.name);
    assert.ok(peerCols.includes('rep_confirmed'), 'missing rep_confirmed on peers');
    assert.ok(peerCols.includes('rep_false_flags'), 'missing rep_false_flags on peers');
  } finally {
    store.close();
  }
});

test('Crash advisory over real Mesh: reproduces in sandbox (0 router calls), quarantines skill & binder, increments rep_confirmed, blocks re-import', async () => {
  const A = await makeAgency(() => ({ thought: 'a', final: 'ok', confidence: 0.9 }));
  const B = await makeAgency(() => ({ thought: 'b', final: 'ok', confidence: 0.9 }));
  const sa = await listen(A.agency);
  const sb = await listen(B.agency);
  try {
    const skillA = seedSkill(A.agency, CRASHY_SKILL);
    const skillB = seedSkill(B.agency, CRASHY_SKILL);
    seedBinder(B.agency, CRASHY_SKILL.name);
    assert.ok(B.agency.tools.tools.has(`skill_${CRASHY_SKILL.name}`), 'tool registered before advisory');
    assert.equal(B.agency.crystallizer.binder(CRASHY_SKILL.name)?.status, 'active');

    const peerB = await A.agency.mesh.addPeer(sb.url, 'B');
    const peerA = await B.agency.mesh.addPeer(sa.url, 'A');
    A.agency.mesh.setTrust(peerB.id, 'trusted');
    B.agency.mesh.setTrust(peerA.id, 'trusted');

    const routerCallsBefore = B.calls.length;
    const out = await A.agency.immune.emitAdvisory({
      skill: skillA,
      kind: 'crash',
      input: { total: 100, people: 0 },
      error: 'RangeError: people must be > 0',
      ttl: 0,
    });
    assert.equal(out.sent, 1);
    assert.equal(out.results[0].reply.verdict, 'confirmed');

    // Zero GPU / router calls on receiver B.
    assert.equal(B.calls.length, routerCallsBefore, 'crash reproduction must use 0 router calls');

    // Skill is quarantined, tool unregistered, active binder retired.
    const afterB = B.agency.crystallizer.list().find((s) => s.name === CRASHY_SKILL.name);
    assert.equal(afterB.status, 'quarantined');
    assert.ok(!B.agency.tools.tools.has(`skill_${CRASHY_SKILL.name}`), 'tool unregistered after quarantine');
    assert.equal(B.agency.crystallizer.binder(CRASHY_SKILL.name), null, 'active binder retired');

    // Peer A reputation incremented.
    const peerAUpdated = B.agency.store.get('SELECT * FROM peers WHERE id = ?', peerA.id);
    assert.equal(peerAUpdated.rep_confirmed, 1);
    assert.equal(peerAUpdated.rep_false_flags, 0);
    assert.equal(B.agency.immune.isQuarantinedHash(skillB.code_sha256), true);

    // Re-importing a plasmid containing the same code_sha256 is rejected.
    const { plasmid } = A.agency.crystallizer.exportSkill(CRASHY_SKILL.name, A.agency.keyring.get('agency'));
    const reimp = await B.agency.crystallizer.importSkill(plasmid, { trustSigner: A.agency.keyring.get('agency').publicHex });
    assert.equal(reimp.imported, false);
    assert.match(reimp.reason, /quarantined/i);
    assert.ok(B.agency.ledger.list({ limit: 5, kind: 'skill.import_reject' }).length >= 1);

    // HTTP status endpoint exposes immune state.
    const res = await fetch(`${sb.url}/api/mesh/immune`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(res.status, 200);
    const st = await res.json();
    assert.equal(st.quarantinedSkills.length, 1);
    assert.equal(st.quarantinedSkills[0].name, CRASHY_SKILL.name);

    assert.ok(A.agency.ledger.verify().ok && B.agency.ledger.verify().ok);
  } finally {
    sa.server.close(); sb.server.close();
    await A.cleanup(); await B.cleanup();
  }
});

test('Wrong-output advisory: grounded task verified independently, quarantines skill, and gossips 1 hop (ttl: 1) without loops', async () => {
  const A = await makeAgency(() => 'ok');
  const B = await makeAgency(() => 'ok');
  const C = await makeAgency(() => 'ok');
  const sa = await listen(A.agency);
  const sb = await listen(B.agency);
  const sc = await listen(C.agency);
  try {
    const skillA = seedSkill(A.agency, BUGGY_DISCOUNT);
    seedSkill(B.agency, BUGGY_DISCOUNT);
    seedSkill(C.agency, BUGGY_DISCOUNT);

    let bVerifyCalls = 0, cVerifyCalls = 0;
    B.agency.immune.verifyOutput = async () => { bVerifyCalls++; return { answer: 114, verdict: 'two programs agree', votes: [] }; };
    C.agency.immune.verifyOutput = async () => { cVerifyCalls++; return { answer: 114, verdict: 'two programs agree', votes: [] }; };

    // Topology: A <-> B <-> C (B and C mutually trusted; A only knows B, so C only learns via B's gossip!).
    const bOnA = await A.agency.mesh.addPeer(sb.url, 'B');
    const aOnB = await B.agency.mesh.addPeer(sa.url, 'A');
    const cOnB = await B.agency.mesh.addPeer(sc.url, 'C');
    const bOnC = await C.agency.mesh.addPeer(sb.url, 'B');
    A.agency.mesh.setTrust(bOnA.id, 'trusted');
    B.agency.mesh.setTrust(aOnB.id, 'trusted');
    B.agency.mesh.setTrust(cOnB.id, 'trusted');
    C.agency.mesh.setTrust(bOnC.id, 'trusted');

    const emitted = await A.agency.immune.emitAdvisory({
      skill: skillA,
      kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] },
      task: GROUNDED_TASK,
      expectedAnswer: 114,
      ttl: 1,
    });
    assert.equal(emitted.sent, 1);
    assert.equal(emitted.results[0].reply.verdict, 'confirmed');
    assert.equal(bVerifyCalls, 1);
    assert.equal(cVerifyCalls, 1);

    // Both B (direct) and C (1-hop gossip) quarantined the buggy skill!
    assert.equal(B.agency.crystallizer.list().find((s) => s.name === BUGGY_DISCOUNT.name).status, 'quarantined');
    assert.equal(C.agency.crystallizer.list().find((s) => s.name === BUGGY_DISCOUNT.name).status, 'quarantined');

    // Duplicate advisory from A to B is deduplicated (no extra verifyOutput, no double rep_confirmed).
    const dup = await A.agency.mesh.send(bOnA.id, 'skill.advisory', {
      codeSha256: skillA.code_sha256,
      skillName: skillA.name,
      kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] },
      task: GROUNDED_TASK,
      expectedAnswer: 114,
      ttl: 1,
    });
    assert.equal(dup.duplicate, true);
    assert.equal(bVerifyCalls, 1);
    assert.equal(B.agency.store.get('SELECT rep_confirmed FROM peers WHERE id = ?', aOnB.id).rep_confirmed, 1);

    assert.ok(A.agency.ledger.verify().ok && B.agency.ledger.verify().ok && C.agency.ledger.verify().ok);
  } finally {
    sa.server.close(); sb.server.close(); sc.server.close();
    await A.cleanup(); await B.cleanup(); await C.cleanup();
  }
});

test('Byzantine false-flag attack: 2 false advisories leave healthy skill active and auto-demote peer trusted -> known', async () => {
  const B = await makeAgency(() => 'ok');
  const D = await makeAgency(() => 'ok');
  const sb = await listen(B.agency);
  const sd = await listen(D.agency);
  try {
    const skillB = seedSkill(B.agency, HEALTHY_DISCOUNT);
    B.agency.immune.verifyOutput = async () => ({ answer: 114, verdict: 'two programs agree', votes: [] });

    const bOnD = await D.agency.mesh.addPeer(sb.url, 'B');
    const dOnB = await B.agency.mesh.addPeer(sd.url, 'D');
    D.agency.mesh.setTrust(bOnD.id, 'trusted');
    B.agency.mesh.setTrust(dOnB.id, 'trusted');

    const demotedEvents = [];
    B.agency.bus.on('immune.peer_demoted', (e) => demotedEvents.push(e));

    // False advisory #1: fake crash against healthy skill.
    const r1 = await D.agency.mesh.send(bOnD.id, 'skill.advisory', {
      codeSha256: skillB.code_sha256,
      skillName: skillB.name,
      kind: 'crash',
      input: { price: 150, discounts: [20, 5] },
      ttl: 0,
    });
    assert.equal(r1.verdict, 'false_flag');
    assert.equal(r1.demoted, false);
    assert.equal(B.agency.store.get('SELECT trust, rep_false_flags FROM peers WHERE id = ?', dOnB.id).trust, 'trusted');

    // False advisory #2: fake wrong_output against healthy skill.
    const r2 = await D.agency.mesh.send(bOnD.id, 'skill.advisory', {
      codeSha256: skillB.code_sha256,
      skillName: skillB.name,
      kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] },
      task: GROUNDED_TASK,
      expectedAnswer: 999,
      ttl: 0,
    });
    assert.equal(r2.verdict, 'false_flag');
    assert.equal(r2.demoted, true);

    // Healthy skill remains active and callable.
    const skillAfter = B.agency.crystallizer.list().find((s) => s.name === HEALTHY_DISCOUNT.name);
    assert.equal(skillAfter.status, 'active');
    assert.ok(B.agency.tools.tools.has(`skill_${HEALTHY_DISCOUNT.name}`));

    // Peer D is auto-demoted trusted -> known and ledgered.
    const dPeer = B.agency.store.get('SELECT trust, rep_false_flags FROM peers WHERE id = ?', dOnB.id);
    assert.equal(dPeer.rep_false_flags, 2);
    assert.equal(dPeer.trust, 'known');
    assert.equal(B.agency.ledger.list({ limit: 5, kind: 'immune.peer_demoted' }).length, 1);
    assert.equal(demotedEvents.length, 1);
    assert.ok(B.agency.ledger.verify().ok);
  } finally {
    sb.server.close(); sd.server.close();
    await B.cleanup(); await D.cleanup();
  }
});

test('Ungrounded trap input is rejected as false_flag at 0 GPU calls', async () => {
  const B = await makeAgency(() => 'ok');
  const D = await makeAgency(() => 'ok');
  const sb = await listen(B.agency);
  const sd = await listen(D.agency);
  try {
    const skillB = seedSkill(B.agency, HEALTHY_DISCOUNT);
    let verifyCalls = 0;
    B.agency.immune.verifyOutput = async () => { verifyCalls++; return { answer: 114, verdict: 'two programs agree', votes: [] }; };

    const bOnD = await D.agency.mesh.addPeer(sb.url, 'B');
    const dOnB = await B.agency.mesh.addPeer(sd.url, 'D');
    B.agency.mesh.setTrust(dOnB.id, 'trusted');

    const routerBefore = B.calls.length;
    const reply = await D.agency.mesh.send(bOnD.id, 'skill.advisory', {
      codeSha256: skillB.code_sha256,
      skillName: skillB.name,
      kind: 'wrong_output',
      input: { price: 999, discounts: [20, 5] }, // 999 does NOT appear in GROUNDED_TASK!
      task: GROUNDED_TASK,
      expectedAnswer: 114,
      ttl: 0,
    });
    assert.equal(reply.verdict, 'false_flag');
    assert.equal(verifyCalls, 0, 'ungrounded trap must not invoke verifyOutput');
    assert.equal(B.calls.length, routerBefore, 'ungrounded trap must use 0 router calls');
    assert.equal(B.agency.crystallizer.list().find((s) => s.name === HEALTHY_DISCOUNT.name).status, 'active');
  } finally {
    sb.server.close(); sd.server.close();
    await B.cleanup(); await D.cleanup();
  }
});

test('Privacy Membrane egress guard: emitAdvisory blocks PII-bearing task and ledgers zero PII', async () => {
  const A = await makeAgency(() => 'ok');
  const B = await makeAgency(() => 'ok');
  const sb = await listen(B.agency);
  try {
    const skillA = seedSkill(A.agency, BUGGY_DISCOUNT);
    const peerB = await A.agency.mesh.addPeer(sb.url, 'B');
    A.agency.mesh.setTrust(peerB.id, 'trusted');

    const piiTask = 'Customer alice@example.com (SSN 123-45-6789) bought a $150 jacket with 20% off then 5% off.';
    const res = await A.agency.immune.emitAdvisory({
      skill: skillA,
      kind: 'wrong_output',
      input: { price: 150, discounts: [20, 5] },
      task: piiTask,
      expectedAnswer: 114,
    });
    assert.equal(res.sent, 0);
    assert.equal(res.blocked, true);
    assert.equal(res.reason, 'privacy');

    // Nothing reached Peer B.
    assert.equal(B.agency.mesh.inbox(50).filter((m) => m.type === 'skill.advisory').length, 0);

    // Ledger recorded immune.advisory_blocked with zero PII leakage.
    const blocked = A.agency.ledger.list({ limit: 5, kind: 'immune.advisory_blocked' });
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].data.codeSha256, skillA.code_sha256);
    assert.equal(blocked[0].data.reason, 'privacy');
    const allLedger = JSON.stringify(A.agency.ledger.list({ limit: 200 }));
    assert.ok(!allLedger.includes('alice@example.com'), 'email leaked into ledger');
    assert.ok(!allLedger.includes('123-45-6789'), 'SSN leaked into ledger');
    assert.ok(A.agency.ledger.verify().ok);
  } finally {
    sb.server.close();
    await A.cleanup(); await B.cleanup();
  }
});

test('crystallizer.onSkillRefuted fires cleanly when invoke() crashes', async () => {
  const A = await makeAgency(() => 'ok');
  try {
    seedSkill(A.agency, CRASHY_SKILL);
    const events = [];
    A.agency.crystallizer.onSkillRefuted = (ev) => events.push(ev);

    await assert.rejects(A.agency.crystallizer.invoke(CRASHY_SKILL.name, { total: 100, people: 0 }), /failed/);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'crash');
    assert.equal(events[0].skill.name, CRASHY_SKILL.name);
    assert.deepEqual(events[0].input, { total: 100, people: 0 });
  } finally {
    await A.cleanup();
  }
});
