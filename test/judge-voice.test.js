// Phase 17: Gemini through Firebase AI Logic as a judge voice (measured: the most accurate voice on the voice study), so
// when an edge worker is online the judge asks Gemini first; a reply that did not really come from the edge never counts.
import { makeAgency } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Play the browser: claim the next edge job and answer it. */
async function serveOne(hub, workerId, answer) {
  const { job } = await hub.claim(workerId, 3000);
  assert.ok(job, 'a job was routed to the edge worker');
  hub.complete(workerId, job.id, answer(job));
  return job;
}
const local = () => ({ thought: 'local', final: 'FINAL 7', confidence: 0.5 });

test('Gemini answers through a real edge job, signed into the ledger with origin "judge"; a local fallback reply is discarded', async () => {
  const A = await makeAgency(local, { edge: { enabled: true, claimTimeoutMs: 400, overflow: { enabled: false } } });
  try {
    // No worker online: the router would fall back to a local model; that is not the voice that was asked for, so it does not count.
    assert.equal(A.agency.crystallizer.cloudVoice.available(), false);
    assert.equal(await A.agency.geminiAnswer('What is 6 * 7?'), null);
    // A browser worker serves the job: the answer counts, and the call is attested.
    const w = A.agency.edge.register({ label: 'Chrome', onDevice: 'unavailable', project: 'demo', cloudModel: 'gemini-3.5-flash-lite' });
    assert.equal(A.agency.crystallizer.cloudVoice.available(), true);
    const pending = A.agency.geminiAnswer('What is 6 * 7?');
    const job = await serveOne(A.agency.edge, w.id, () => ({ text: '6 * 7 = 42.\nFINAL: 42', inferenceSource: 'in_cloud' }));
    assert.equal(job.mode, 'prefer_in_cloud');
    assert.equal(await pending, 'FINAL 42');
    const proof = A.agency.ledger.list({ limit: 1, kind: 'edge.inference' })[0].data;
    assert.equal(proof.origin, 'judge');
    assert.equal(proof.inferenceSource, 'IN_CLOUD');
  } finally { await A.cleanup(); }
});

test('the judge asks Gemini first when it can, skips a voice that gives no answer, and names the voice in corrections', async () => {
  const A = await makeAgency(local);
  try {
    const cz = A.agency.crystallizer;
    const asked = [];
    let gemini = 'FINAL 51.84';
    cz.cloudVoice = { available: () => true };
    cz.agentAnswer = async (t, id) => { asked.push(id); return id === 'gemini' ? gemini : 'It is 49.28'; };
    // A correction names the voice that outvoted the first agent.
    const row = { agree: true, agentAnswer: 49.28, skillOut: 51.84, second: 51.84, secondBy: 'gemini', skill: 'tax_split' };
    assert.match(cz.correctAnswer(row, 'agents said 49.28'), /skill_tax_split computed 51\.84, and Gemini via Firebase AI Logic \(51\.84\) agreed/);
    // Voice order and skipping, through the real judge.
    gemini = null; // Gemini gives no answer this time: the next voice is asked, never a silent stand-in
    asked.length = 0;
    const r = await cz.judge('A $180 dinner is 20% off, then 8% sales tax is added, split among 3 friends.', 51.84, 'FINAL 49.28');
    assert.deepEqual(asked.slice(0, 2), ['gemini', 'lumen']);
    assert.equal(r.secondBy, 'lumen');
    gemini = 'FINAL 51.84'; asked.length = 0;
    const r2 = await cz.judge('A $180 dinner is 20% off, then 8% sales tax is added, split among 3 friends.', 51.84, 'FINAL 49.28');
    assert.deepEqual(asked, ['gemini']);
    assert.equal(r2.agree, true);
    assert.equal(r2.secondBy, 'gemini');
    // No edge worker: exactly the old local judge.
    cz.cloudVoice = { available: () => false }; asked.length = 0;
    await cz.judge('A $180 dinner is 20% off, then 8% sales tax is added, split among 3 friends.', 51.84, 'FINAL 49.28');
    assert.deepEqual(asked, ['lumen'], 'lumen corroborates the first agent: decided without a third voice');
  } finally { await A.cleanup(); }
});

test('the cloud guard: a task holding a sensitive value or an owner term never reaches Gemini, and the daily cap holds', async () => {
  const A = await makeAgency(local, { edge: { enabled: true, claimTimeoutMs: 400, overflow: { enabled: false } }, skills: { cloudJudgeDailyMax: 1 } });
  try {
    A.agency.edge.register({ label: 'Chrome', onDevice: 'unavailable' });
    assert.equal(await A.agency.geminiAnswer('Ann (ann@example.com) pays 20% of $180. How much?'), null);
    A.agency.membrane.setTerms(['Project Bluefin']);
    assert.equal(await A.agency.geminiAnswer('Project Bluefin costs $180 after 20% off. What was the price?'), null);
    const refused = A.agency.ledger.list({ limit: 5, kind: 'judge.cloud_refused' }).map((e) => e.data.types.join(','));
    assert.deepEqual(refused.sort(), ['EMAIL', 'TERM']);
    assert.equal(A.agency.edge.snapshot().queued, 0, 'no edge job was ever created');
    // Daily cap: the first clean call is allowed (and times out here, with no browser answering); the second is refused.
    await A.agency.geminiAnswer('What is 6 * 7?').catch(() => null);
    const before = A.agency.edge.snapshot().queued;
    assert.equal(await A.agency.geminiAnswer('What is 7 * 8?'), null);
    assert.equal(A.agency.edge.snapshot().queued, before, 'over the cap: no job');
  } finally { await A.cleanup(); }
});

test('evaluation mode: every voice answers each split, so voices can be scored against the truth; the decision is unchanged', async () => {
  const A = await makeAgency(local, { skills: { judgeAllVoices: true } });
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => true };
    cz.agentAnswer = async (t, id) => ({ gemini: 'FINAL 51.84', lumen: 'FINAL 49.28', forge_keeper: 'FINAL 49.28' })[id];
    const r = await cz.judge('A $180 dinner is 20% off, then 8% sales tax is added, split among 3 friends.', 51.84, 'FINAL 49.28');
    assert.deepEqual(r.voices, { gemini: 51.84, lumen: 49.28, forge_keeper: 49.28 });
    assert.equal(r.agree, true, 'gemini (asked first) sided with the skill: same decision as without evaluation mode');
    assert.equal(r.secondBy, 'gemini');
  } finally { await A.cleanup(); }
});

test('voice study: every voice answers tasks with known truth; accuracy, wrong-together and kappa per pair', async () => {
  const A = await makeAgency(local);
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => true };
    const book = { // two local voices share the same mistake on round trips (averaging the speeds)
      tycho: { a: '16', b: '12' }, lumen: { a: '16', b: '12' }, forge_keeper: { a: '12', b: '7' }, gemini: { a: '12', b: '12' } };
    cz.agentAnswer = async (t, id) => `FINAL ${book[id][t.includes('8 mph') ? 'a' : 'b']}`;
    const s = await cz.voiceStudy([{ task: 'Out at 8 mph, back at 24 mph. Average speed for the round trip?', truth: 12 }, { task: 'Price 30 then 40% off. What is it now?', truth: 12 }]);
    assert.deepEqual(s.voices, ['tycho', 'gemini', 'lumen', 'forge_keeper']);
    assert.deepEqual(s.accuracy, { tycho: 0.5, gemini: 1, lumen: 0.5, forge_keeper: 0.5 });
    const tl = s.pairs.find((p) => p.a === 'tycho' && p.b === 'lumen');
    assert.equal(tl.wrongTogether, 1); assert.equal(tl.sameWrongAnswer, 1, 'the same wrong number: a vote between them cannot fix it');
    assert.equal(s.rescuedFirstAgent.gemini, 1);
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'judge.study' }).length, 1);
  } finally { await A.cleanup(); }
});

test('answers with thousands separators are read whole (regression: "1,250.5" was read as 250.5 in two places)', async () => {
  const A = await makeAgency(local);
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => false };
    cz.agentAnswer = async () => 'The total is 1,250.5';
    const s = await cz.voiceStudy([{ task: 'A $1000 order gets 25% added. Total?', truth: 1250 }, { task: 'Five boxes of 250.1 each. Total?', truth: 1250.5 }], { voices: ['lumen'] });
    assert.deepEqual(s.rows.map((r) => r.answers.lumen), [1250.5, 1250.5]);
    // The ambiguous-chain picker reads the agent's answer the same way.
    const pick = await cz.shadowVerdict({ candidates: [{ out: 1250.5, signature: 'a', chain: [] }, { out: 250.5, signature: 'b', chain: [] }] }, 'task 1000 25%', 'Each pays 1,250.50');
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'skill.chain_pick' })[0].data.picked, 'a');
    assert.equal(pick, null);
  } finally { await A.cleanup(); }
});

test('measured voice order: after a study, the more accurate local voice is asked first (configurable back to fixed)', async () => {
  const A = await makeAgency(local);
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => false };
    const asked = [];
    cz.agentAnswer = async (t, id) => { asked.push(id); return 'FINAL 51.84'; };
    A.agency.store.kvSet('judge:study', { items: 20, accuracy: { tycho: 0.5, gemini: 1, lumen: 0.65, forge_keeper: 0.95 } });
    await cz.judge('A $180 dinner is 20% off, then 8% sales tax is added, split among 3 friends.', 51.84, 'FINAL 49.28');
    assert.deepEqual(asked, ['forge_keeper'], 'forge_keeper (95%) before lumen (65%)');
    A.agency.crystallizer.cfg.skills = { ...(A.agency.crystallizer.cfg.skills || {}), voiceOrder: 'fixed' };
    asked.length = 0;
    await cz.judge('A $180 dinner is 20% off, then 8% sales tax is added, split among 3 friends.', 51.84, 'FINAL 49.28');
    assert.deepEqual(asked, ['lumen']);
  } finally { await A.cleanup(); }
});

test('measured first agent: chosen only inside the measured domain, by a margin, and after a held-out study confirms it', async () => {
  const A = await makeAgency(local);
  try {
    const ag = A.agency;
    const T = 'A cyclist rides out at 8 mph and back at 24 mph. What is the average speed?';
    assert.match(ag.pickAnswerer(T).reason, /no voice study/);
    ag.store.kvSet('judge:study', { items: 20, voices: ['tycho', 'gemini', 'lumen', 'forge_keeper'], accuracy: { tycho: 0.5, gemini: 1, lumen: 0.65, forge_keeper: 0.95 } });
    assert.match(ag.pickAnswerer(T).reason, /not yet confirmed on a held-out study/, 'selected on one set is not enough');
    ag.store.kvSet('judge:heldout', { items: 20, accuracy: { tycho: 0.55, forge_keeper: 0.9 } });
    const p = ag.pickAnswerer(T);
    assert.equal(p.agentId, 'forge_keeper', 'gemini is never the first answerer');
    assert.match(p.reason, /held-out 90%/);
    assert.equal(ag.pickAnswerer('Write a haiku about rain.').agentId, 'tycho', 'outside the measured domain');
    ag.store.kvSet('judge:heldout', { items: 20, accuracy: { tycho: 0.9, forge_keeper: 0.85 } });
    assert.equal(ag.pickAnswerer(T).agentId, 'tycho', 'the held-out study did not confirm it');
  } finally { await A.cleanup(); }
});

test('a voice never seconds itself: the agent that answered first is not asked again by the judge', async () => {
  const A = await makeAgency(local);
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => false };
    const asked = [];
    cz.agentAnswer = async (t, id) => { asked.push(id); return 'FINAL 51.84'; };
    A.agency.store.kvSet('judge:study', { accuracy: { lumen: 0.65, forge_keeper: 0.95 } });
    await cz.judge('A $180 dinner is 20% off, then 8% sales tax is added, split among 3 friends.', 51.84, 'FINAL 49.28', 'forge_keeper');
    assert.deepEqual(asked, ['lumen'], 'forge_keeper answered first, so lumen is the second opinion');
  } finally { await A.cleanup(); }
});

test('second-voice check: confirmed, corrected 2 of 3, or reported unverified; voices never re-check; only in the measured domain', async () => {
  const PRINT = 'Printer A prints a batch in 6 hours and printer B in 12 hours. Together, how many hours do they need?';
  const A = await makeAgency(() => ({ thought: 'quick', final: 'They need 24 hours.', confidence: 0.6 }));
  try {
    const cz = A.agency.crystallizer;
    cz.cloudVoice = { available: () => true };
    let book = { gemini: 'FINAL 4', tycho: 'FINAL 4', lumen: 'FINAL 3', forge_keeper: 'FINAL 24' };
    const asked = [];
    cz.agentAnswer = async (t, id) => { asked.push(id); return book[id]; };
    A.agency.store.kvSet('judge:study', { items: 20, voices: ['tycho', 'gemini', 'lumen', 'forge_keeper'], accuracy: { tycho: 0.5, gemini: 1, lumen: 0.65, forge_keeper: 0.95 } });
    A.agency.store.kvSet('judge:heldout', { items: 20, voices: ['tycho', 'gemini', 'forge_keeper', 'lumen'], accuracy: { tycho: 0.7, gemini: 1, forge_keeper: 0.95, lumen: 0.45 } });
    // Over both studies (the real numbers): tycho 60%, lumen 55%, so tycho is the local check voice.
    // forge_keeper answered 24 (the real Phase 18 miss): Gemini says 4, the next local voice says 4 -> corrected.
    const r = await A.agency.runtime.run('forge_keeper', PRINT);
    assert.match(r.final, /^\*\*Answer: 4\*\*\n\nChecked 2 of 3: Gemini via Firebase AI Logic \(4\) and agent tycho \(4\) agreed; the first answer \(24\) was outvoted\./);
    assert.deepEqual(asked, ['gemini', 'tycho'], 'never forge_keeper itself; tycho (measured above lumen) is the local voice');
    assert.equal(A.agency.ledger.list({ limit: 1, kind: 'answer.check' })[0].data.outcome, 'corrected');
    // Everyone agrees with the first answer: one extra voice, and the reply says it was checked.
    book = { gemini: 'FINAL 24', tycho: 'FINAL 24', lumen: 'FINAL 24' }; asked.length = 0;
    const r2 = await A.agency.runtime.run('forge_keeper', PRINT);
    assert.match(r2.final, /They need 24 hours\.\n\n\*Checked: Gemini via Firebase AI Logic independently got 24\.\*/);
    assert.deepEqual(asked, ['gemini']);
    // Three different answers: not sent as if certain.
    book = { gemini: 'FINAL 4', tycho: 'FINAL 9' }; asked.length = 0;
    const r3 = await A.agency.runtime.run('forge_keeper', PRINT);
    assert.match(r3.final, /\*\*Unverified:\*\* independent checks disagree \(Gemini via Firebase AI Logic: 4, agent tycho: 9\)/);
    assert.ok(r3.confidence <= 0.4);
    // Outside the measured domain, and for judge voices themselves (check: false): no check.
    asked.length = 0;
    await A.agency.runtime.run('forge_keeper', 'Write one sentence about rain.');
    await A.agency.runtime.run('forge_keeper', PRINT, { check: false });
    await A.agency.runtime.run('forge_keeper', PRINT, { privacy: 'private' });
    assert.deepEqual(asked, []);
  } finally { await A.cleanup(); }
});
