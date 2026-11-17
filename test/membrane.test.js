// Privacy Membrane: private work may use remote models only through sealed text, and network tools may not leak it.
import { makeAgency } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, SealSession, Membrane, MembraneLeak } from '../src/guard/membrane.js';

const okFinal = { thought: 'done', final: 'ok', confidence: 0.9 };
const PRIVATE = 'Email maria.lopez@clinic.org or call +1 (415) 555-0132 about card 4111 1111 1111 1111 and SSN 123-45-6789. My password is Tr0ub4dor&3.';

test('detectors: find PII and secrets, and leave ordinary numbers alone', () => {
  const types = detect(PRIVATE).map((s) => `${s.type}:${s.value}`);
  assert.deepEqual(types, ['EMAIL:maria.lopez@clinic.org', 'PHONE:+1 (415) 555-0132', 'CARD:4111 1111 1111 1111', 'SSN:123-45-6789', 'SECRET:Tr0ub4dor&3']);
  const benign = 'In 2026 revenue grew 8% to 1,250,000 at 14:35 on 2026-11-17; order 12 units at $19.99; version 3.1.0; call me at 5.';
  assert.deepEqual(detect(benign), [], 'years, prices, times, dates and versions are not PII');
  assert.deepEqual(detect('card 4111 1111 1111 1112').filter((s) => s.type === 'CARD'), [], 'Luhn rejects an invalid card number');
  assert.equal(detect('key sk-abcdefghijklmnopqrstuv123 at 10.0.0.12').map((s) => s.type).join(','), 'SECRET,IP');
  assert.equal(detect('Ship to Project Bluefin now', { terms: ['project bluefin'] })[0].value, 'Project Bluefin', 'owner terms are case-insensitive');
});

test('seal/unseal: consistent placeholders, tolerant restore, JSON-safe restore', () => {
  const s = new SealSession();
  const a = s.apply('mail a.b@x.io', detect('mail a.b@x.io'));
  const b = s.apply('again a.b@x.io and c@y.io', detect('again a.b@x.io and c@y.io'));
  assert.equal(a, 'mail ⟦EMAIL_1⟧');
  assert.equal(b, 'again ⟦EMAIL_1⟧ and ⟦EMAIL_2⟧', 'the same value always gets the same placeholder');
  assert.equal(s.unseal('to ⟦EMAIL_1⟧, [EMAIL_2], EMAIL_1 and «EMAIL_2».'), 'to a.b@x.io, c@y.io, a.b@x.io and c@y.io.');
  const q = new SealSession();
  q.apply('pw "x', [{ start: 3, end: 5, type: 'SECRET', value: '"x' }]);
  assert.equal(JSON.parse(q.unseal('{"v":"⟦SECRET_1⟧"}', { json: true })).v, '"x', 'restored values cannot break JSON');
});

test('audit: catches leaks with different separators or without the country code', () => {
  const s = new SealSession();
  s.apply(PRIVATE, detect(PRIVATE));
  assert.deepEqual(s.audit('call 415 555 0132').leaks, ['PHONE']);
  assert.deepEqual(s.audit('number 4111-1111-1111-1111').leaks, ['CARD']);
  assert.deepEqual(s.audit('MARIA.LOPEZ@CLINIC.ORG').leaks, ['EMAIL']);
  assert.equal(s.audit('ends in 1111, total 555').clean, true, 'fragments are not leaks');
  assert.ok(new MembraneLeak(['EMAIL']).message.includes('blocked egress'));
});

test('local NER: only names that literally occur are withheld, so the model cannot invent what to hide', async () => {
  const m = new Membrane({ ner: async () => [{ text: 'Dr. Amara Okafor', type: 'person' }, { text: 'Imaginary Person', type: 'PERSON' }] });
  const r = await m.sealMessages([{ role: 'user', content: 'Ask Dr. Amara Okafor to call maria.lopez@clinic.org; Dr. Amara Okafor agreed.' }]);
  const sealed = r.messages.at(-1).content;
  assert.equal(sealed, 'Ask ⟦PERSON_1⟧ to call ⟦EMAIL_1⟧; ⟦PERSON_1⟧ agreed.');
  assert.ok(!r.payload.includes('Okafor') && !r.payload.includes('clinic.org'));
  assert.match(r.messages[0].content, /placeholders/, 'the model is told how to treat placeholders');
});

test('router: sealed work reaches a remote model only as placeholders; the reply comes back restored and ledgered', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    A.agency.membrane.ner = null; // deterministic detectors only for this test
    const seen = [];
    A.agency.router.addProvider({
      name: 'cloudy', remote: true, has: (m) => m === 'cloud-m', available: async () => true, listModels: async () => ['cloud-m'],
      chat: async (req) => { seen.push(JSON.stringify(req.messages)); return { text: 'Will email ⟦EMAIL_1⟧ and call PHONE_1.', model: 'cloud-m', provider: 'cloudy', latencyMs: 1, usage: { prompt: 1, completion: 1 } }; },
    });
    const res = await A.agency.router.chat({ role: 'fast', model: 'cloud-m', privacy: 'sealed', messages: [{ role: 'user', content: PRIVATE }] });
    assert.equal(res.text, 'Will email maria.lopez@clinic.org and call +1 (415) 555-0132.');
    assert.deepEqual(res.sealed.withheld, { EMAIL: 1, PHONE: 1, CARD: 1, SSN: 1, SECRET: 1 });
    for (const secret of ['maria.lopez', '555-0132', '4111', '123-45-6789', 'Tr0ub4dor']) assert.ok(!seen[0].includes(secret), `remote never saw ${secret}`);
    const [entry] = A.agency.ledger.list({ limit: 1, kind: 'membrane.crossing' });
    assert.equal(entry.data.provider, 'cloudy');
    assert.equal(entry.data.total, 5);
    assert.ok(entry.data.tags.every((t) => /^[0-9a-f]{16}$/.test(t.tag)));
    assert.ok(!JSON.stringify(entry.data).includes('maria'), 'the ledger holds keyed tags, never values');
    assert.equal(entry.data.tags.find((t) => t.type === 'EMAIL').tag, A.agency.membrane.tag('maria.lopez@clinic.org'), 'tags are stable per value');

    await A.agency.router.chat({ role: 'fast', model: 'cloud-m', privacy: 'normal', messages: [{ role: 'user', content: PRIVATE }] });
    assert.ok(seen[1].includes('maria.lopez'), 'control: normal work is not sealed');
    const local = await A.agency.router.chat({ role: 'fast', model: 'cloud-m', privacy: 'private', messages: [{ role: 'user', content: PRIVATE }] });
    assert.equal(local.provider, 'scripted', 'private work never uses a remote provider, even when named explicitly');
    assert.equal(seen.length, 2);
  } finally { await A.cleanup(); }
});

test('sealed work overflows to the Firebase edge worker; the browser only ever receives sealed text', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    A.agency.membrane.ner = null;
    const { router, edge: hub } = A.agency;
    const w = hub.register({ label: 'Chrome/141', onDevice: 'unavailable', project: 'demo-agency' });
    router.gpu.active = router.gpu.max;
    try {
      const pending = router.chat({ role: 'fast', privacy: 'sealed', messages: [{ role: 'user', content: PRIVATE }] });
      const { job } = await hub.claim(w.id, 2000);
      assert.ok(job, 'sealed work is eligible for GPU overflow (private work is not, without Nano)');
      const sent = JSON.stringify(job.messages);
      assert.ok(!sent.includes('maria.lopez') && !sent.includes('4111') && sent.includes('⟦EMAIL_1⟧'));
      hub.complete(w.id, job.id, { text: 'Reply sent to ⟦EMAIL_1⟧.', inferenceSource: 'in_cloud' });
      const res = await pending;
      assert.equal(res.text, 'Reply sent to maria.lopez@clinic.org.');
      assert.equal(res.provider, 'edge/IN_CLOUD');
    } finally { router.gpu.active = 0; }
    const kinds = A.agency.ledger.list({ limit: 5 }).map((e) => e.kind);
    assert.ok(kinds.includes('membrane.crossing') && kinds.includes('edge.inference'), 'both the crossing and the Firebase call are signed');
    assert.ok(A.agency.ledger.verify().ok);
  } finally { await A.cleanup(); }
});

test('egress guard: network tools cannot carry private or sealed values off the machine', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const sent = [];
    A.agency.tools.register({ name: 'net_echo', description: 'test egress tool', egress: true, params: { type: 'object', properties: { q: { type: 'string' } } }, run: ({ q }) => { sent.push(q); return { echoed: q }; } });
    const priv = await A.agency.tools.call('net_echo', { q: 'weather tomorrow' }, { privacy: 'private' });
    assert.equal(priv.ok, false);
    assert.match(priv.output, /disabled for private work/);
    const leaky = await A.agency.tools.call('net_echo', { q: 'find maria.lopez@clinic.org' }, { privacy: 'sealed' });
    assert.equal(leaky.ok, false);
    assert.match(leaky.output, /1 sensitive value\(s\) \(EMAIL\)/);
    const clean = await A.agency.tools.call('net_echo', { q: 'weather tomorrow' }, { privacy: 'sealed' });
    assert.equal(clean.ok, true, 'sealed work may still use the network for non-sensitive queries');
    assert.deepEqual(sent, ['weather tomorrow']);
    const blocked = A.agency.ledger.list({ limit: 5, kind: 'membrane.egress_blocked' });
    assert.equal(blocked.length, 2);
    assert.ok(!JSON.stringify(blocked).includes('maria'));
  } finally { await A.cleanup(); }
});

test('the agency NER runs on a local model only (privacy private), never on the cloud it protects against', async () => {
  const A = await makeAgency((req) => (req.json && /personal and confidential/.test(req.messages[0].content) ? { entities: [{ text: 'Amara Okafor', type: 'PERSON' }] } : okFinal));
  try {
    const n0 = A.calls.length;
    const r = await A.agency.membrane.sealMessages([{ role: 'user', content: 'Tell Amara Okafor the results.' }]);
    const nerCall = A.calls.slice(n0).find((c) => c.json);
    assert.equal(nerCall.privacy, 'private');
    assert.equal(r.messages.at(-1).content, 'Tell ⟦PERSON_1⟧ the results.');
  } finally { await A.cleanup(); }
});

test('fail closed: if the local name finder cannot run, nothing crosses (names would be unprotected)', async () => {
  const m = new Membrane({ ner: async () => { throw new Error('No model available for role "fast"'); } });
  await assert.rejects(m.sealMessages([{ role: 'user', content: 'Tell Amara Okafor at a@b.io' }]), (e) => e instanceof MembraneLeak && /name finder is unavailable/.test(e.message));
  const preview = await m.sealMessages([{ role: 'user', content: 'Tell Amara Okafor at a@b.io' }], { strict: false });
  assert.equal(preview.ner, 'unavailable', 'previews report the gap instead of hiding it');
  assert.equal(new Membrane({}).sealMessages ? (await new Membrane({}).sealMessages([{ role: 'user', content: 'x' }])).ner : null, 'off', 'no name finder configured is reported as off');

  const A = await makeAgency(() => okFinal);
  try {
    A.agency.membrane.ner = async () => { throw new Error('local model down'); };
    const seen = [];
    A.agency.router.addProvider({ name: 'cloudy', remote: true, has: (x) => x === 'cloud-m', available: async () => true, listModels: async () => ['cloud-m'], chat: async (req) => { seen.push(req); return { text: 'x', model: 'cloud-m', provider: 'cloudy', latencyMs: 1, usage: { prompt: 1, completion: 1 } }; } });
    const res = await A.agency.router.chat({ role: 'fast', model: 'cloud-m', privacy: 'sealed', messages: [{ role: 'user', content: 'Tell Amara Okafor at a@b.io' }] });
    assert.equal(seen.length, 0, 'the remote model was never called');
    assert.equal(res.provider, 'scripted', 'the work fell back to the local model');
  } finally { await A.cleanup(); }
});
