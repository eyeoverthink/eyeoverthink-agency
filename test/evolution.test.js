// Evolution: paired seeds, winner's-curse confirmation, promotion bookkeeping, background jobs.
// A stub bench stands in for the model so each test controls exactly which genomes pass on which seeds.
import { makeAgency, systemOf } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Evolution, summarize, paired, traitDiff } from '../src/evolve/evolution.js';
import { traitsToGenome, DEFAULT_TRAITS } from '../src/core/dna.js';

const okFinal = { thought: 'done', final: 'ok', confidence: 0.9 };

function stubEvolution(agency, passFn) {
  const calls = [];
  const bench = {
    runItem: async (item, { agentOverride, seed }) => {
      calls.push({ item: item.id, genome: agentOverride.genome, seed });
      return { id: item.id, pass: passFn({ item, genome: agentOverride.genome, traits: agentOverride.traits, seed }), steps: 1, ms: 1 };
    },
  };
  const evo = new Evolution({ store: agency.store, agents: agency.agents, bench, ledger: agency.ledger, bus: agency.bus });
  return { evo, calls };
}

test('evolution helpers: summarize, paired comparison, trait diff', () => {
  const s = summarize([{ pass: true, steps: 2 }, { pass: false, steps: 2 }, { pass: true, steps: 2 }, { pass: true, steps: 2 }]);
  assert.equal(s.passRate, 0.75);
  assert.equal(s.cost, 0.02);
  assert.equal(s.fitness, 0.73);
  assert.ok(s.ci95[0] < 0.75 && s.ci95[1] > 0.75);
  const p = paired([{ id: 'a', seed: 1, pass: true }, { id: 'b', seed: 1, pass: false }, { id: 'c', seed: 1, pass: true }],
    [{ id: 'a', seed: 1, pass: true }, { id: 'b', seed: 1, pass: true }, { id: 'c', seed: 1, pass: false }]);
  assert.deepEqual(p, { wins: 1, losses: 1, ties: 1 });
  const d = traitDiff(traitsToGenome(DEFAULT_TRAITS), traitsToGenome({ ...DEFAULT_TRAITS, temperature: 0.9 }));
  assert.equal(d.length, 1);
  assert.equal(d[0].trait, 'temperature');
  assert.equal(d[0].to, 0.9);
});

test('evolution: all candidates are screened on identical seeds (paired comparison)', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const { evo, calls } = stubEvolution(A.agency, () => true);
    const r = await evo.evolve('tycho', { population: 4, repeats: 2 });
    const byGenome = new Map();
    for (const c of calls) byGenome.set(c.genome, [...(byGenome.get(c.genome) || []), `${c.item}@${c.seed}`]);
    const sets = [...byGenome.values()].map((v) => v.sort().join(','));
    assert.equal(byGenome.size, 4);
    assert.ok(sets.every((s) => s === sets[0]), 'every genome saw the same (item, seed) cells');
    assert.equal(r.promoted, false, 'a tie is never promoted');
    assert.match(r.reason, /did not beat/);
  } finally { await A.cleanup(); }
});

test('evolution: a screening win that does not hold on fresh seeds is NOT promoted (winner\'s curse guard)', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const before = A.agency.agents.get('tycho').genome;
    // Incumbent passes half the items everywhere; challengers pass everything on screening seeds and nothing on fresh ones.
    const { evo } = stubEvolution(A.agency, ({ item, genome, seed }) => {
      if (genome === before) return item.id !== 'math-exact';
      return seed % 1000 < 500;
    });
    const r = await evo.evolve('tycho', { population: 3, repeats: 1 });
    assert.equal(r.promoted, false);
    assert.match(r.reason, /fresh seeds/);
    assert.ok(r.confirmation, 'a confirmation round ran');
    assert.ok(r.confirmation.challenger.fitness < r.confirmation.incumbent.fitness);
    assert.equal(A.agency.agents.get('tycho').genome, before, 'genome unchanged');
    const rows = A.agency.store.all('SELECT detail FROM evolution WHERE agent_id = ?', 'tycho');
    assert.equal(rows.length, 3);
    assert.ok(rows.some((x) => JSON.parse(x.detail).confirmation), 'confirmation evidence stored with the challenger');
  } finally { await A.cleanup(); }
});

test('evolution: a confirmed improvement is promoted, ledgered, and survives in the agent record', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const before = A.agency.agents.get('tycho');
    const { evo } = stubEvolution(A.agency, ({ genome }) => genome !== before.genome);
    const r = await evo.evolve('tycho', { population: 3, repeats: 2 });
    assert.equal(r.promoted, true, r.reason);
    assert.ok(r.confirmation.paired.wins > 0 && r.confirmation.paired.losses === 0);
    assert.ok(r.challengerChanges.length > 0, 'reports which genes changed');
    const after = A.agency.agents.get('tycho');
    assert.notEqual(after.genome, before.genome);
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.fitness, r.fitness);
    assert.ok(A.agency.ledger.verify().ok);
    const hist = evo.history('tycho');
    assert.equal(hist.filter((h) => h.promoted).length, 1);
  } finally { await A.cleanup(); }
});

test('evolution: an all-correct tie that differs only in step cost is NOT promoted (no drift on noise)', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const before = A.agency.agents.get('tycho').genome;
    // Everyone passes; challengers use 1 step instead of 2. Pooled gain 0.01 < minGain 0.02.
    const bench = { runItem: async (item, { agentOverride }) => ({ id: item.id, pass: true, steps: agentOverride.genome === before ? 2 : 1, ms: 1 }) };
    const evo = new Evolution({ store: A.agency.store, agents: A.agency.agents, bench, ledger: A.agency.ledger, bus: A.agency.bus });
    const r = await evo.evolve('tycho', { population: 3, repeats: 1 });
    assert.equal(r.promoted, false);
    assert.match(r.reason, /below the minimum 0\.02.*tie/);
    assert.equal(A.agency.agents.get('tycho').genome, before);
    const r2 = await evo.evolve('tycho', { population: 3, repeats: 1, minGain: 0.005 });
    assert.equal(r2.promoted, true, 'an explicit lower margin allows efficiency-only promotion');
  } finally { await A.cleanup(); }
});

test('evolution refuses to score a generation whose runs crashed (infrastructure is not fitness)', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const before = A.agency.agents.get('tycho');
    const bench = { runItem: async (item) => ({ id: item.id, pass: false, error: 'No model available for role "reason"', ms: 1 }) };
    const evo = new Evolution({ store: A.agency.store, agents: A.agency.agents, bench, ledger: A.agency.ledger, bus: A.agency.bus });
    await assert.rejects(evo.evolve('tycho', { population: 2 }), /runs errored.*No model available/);
    const after = A.agency.agents.get('tycho');
    assert.equal(after.generation, before.generation, 'no generation consumed');
    assert.equal(after.fitness, before.fitness, 'no fake fitness recorded');
    assert.equal(A.agency.store.all('SELECT id FROM evolution').length, 0);
  } finally { await A.cleanup(); }
});

test('evolution jobs run in the background, one at a time, and report through the bus', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const { evo } = stubEvolution(A.agency, () => true);
    const done = new Promise((res) => A.agency.bus.once('evolution.done', res));
    const job = evo.start('tycho', { population: 2, repeats: 1, generations: 2 });
    assert.equal(job.status, 'running');
    assert.throws(() => evo.start('lumen'), /already running/);
    const ev = await done;
    assert.equal(ev.jobId, job.id);
    const final = evo.job(job.id);
    assert.equal(final.status, 'done');
    assert.equal(final.result.generations.length, 2);
    assert.equal(final.ctrl, undefined, 'abort controller is not exposed');
  } finally { await A.cleanup(); }
});

test('runtime forwards a per-turn seed to the model and the exploration gene reaches the prompt', async () => {
  const A = await makeAgency(() => okFinal);
  try {
    const base = A.agency.agents.get('tycho');
    const n0 = A.calls.length;
    await A.agency.runtime.run(base, 'say ok', { seed: 7 });
    const seeds = A.calls.slice(n0).map((c) => c.seed);
    assert.equal(seeds[0], 701, 'first turn');
    assert.equal(new Set(seeds).size, seeds.length, 'each turn (incl. reflection) gets its own seed');
    const explorer = { ...base, traits: { ...base.traits, exploration: 0.9 } };
    const n1 = A.calls.length;
    await A.agency.runtime.run(explorer, 'say ok');
    assert.match(systemOf(A.calls[n1]), /Gather evidence with your tools/);
    assert.ok(A.calls.slice(n1).every((c) => c.seed === undefined), 'no seed unless asked');
  } finally { await A.cleanup(); }
});
