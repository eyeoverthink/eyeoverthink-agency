// Ouroboros evolution: a genetic algorithm over agent genomes with measured fitness.
//
// One generation:
//   1. Population = incumbent genome + point mutants + crossovers with the fittest other agent.
//   2. Screening: every candidate runs the agent's benchmark items `repeats` times with the SAME seeds
//      (common random numbers), so differences between candidates come from the genome, not sampling luck.
//   3. Confirmation (promotion needs a pooled gain >= minGain and no net paired losses): the best challenger is the max of N noisy scores, so its screening score is biased
//      upward (winner's curse). If it beat the incumbent, both are re-run on FRESH seeds. The challenger is
//      promoted only if it is at least as good on the fresh round AND strictly better pooled over both rounds.
// fitness = pass rate − step-cost penalty (≤ 0.1). Every candidate, seed and verdict is stored and ledgered.
import { newId, nowIso, errorMessage } from '../core/util.js';
import { mutate, crossover, genomeToTraits, geneticDistance, DEFAULT_TRAITS, GENE_SPEC } from '../core/dna.js';
import { SUITES, wilson } from '../telemetry/bench.js';

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Aggregate item results into fitness. Exported for tests. */
export function summarize(results) {
  const n = results.length;
  const pass = results.filter((r) => r.pass).length;
  const steps = results.reduce((s, r) => s + (r.steps || 0), 0);
  const passRate = n ? pass / n : 0;
  const cost = n ? Math.min(0.1, (steps / n) * 0.01) : 0;
  return { fitness: round3(passRate - cost), passRate: round3(passRate), passed: pass, runs: n, cost: round3(cost), ci95: wilson(pass, n), results };
}

/** Paired comparison on identical (item, seed) cells: where does the challenger win or lose? */
export function paired(incumbent, challenger) {
  const key = (r) => `${r.id}|${r.seed}`;
  const base = new Map(incumbent.map((r) => [key(r), r.pass]));
  let wins = 0, losses = 0, ties = 0;
  for (const r of challenger) {
    if (!base.has(key(r))) continue;
    const b = base.get(key(r));
    if (r.pass && !b) wins++; else if (!r.pass && b) losses++; else ties++;
  }
  return { wins, losses, ties };
}

/** Trait-level difference between two genomes (only genes that changed). */
export function traitDiff(fromGenome, toGenome) {
  const a = genomeToTraits(fromGenome), b = genomeToTraits(toGenome);
  return GENE_SPEC.map((s) => s.key).filter((k) => a[k] !== b[k]).map((k) => ({ trait: k, from: a[k], to: b[k] }));
}

export class Evolution {
  constructor({ store, agents, bench, ledger, bus }) {
    Object.assign(this, { store, agents, bench, ledger, bus });
    this.jobs = new Map();
    this.active = null;
  }

  itemsFor(agentId) {
    const all = Object.values(SUITES).flat();
    const own = all.filter((i) => i.agent === agentId);
    return own.length ? own : all.filter((i) => ['reasoning', 'format'].includes(i.category)).map((i) => ({ ...i, agent: agentId }));
  }

  /** Run every item once per seed for one genome. */
  async evaluate(agent, genome, items, seeds, { signal, onRun } = {}) {
    const candidate = { ...agent, genome, traits: { ...DEFAULT_TRAITS, ...genomeToTraits(genome) } };
    const results = [];
    for (const seed of seeds) {
      for (const item of items) {
        if (signal?.aborted) throw new Error('aborted');
        const r = await this.bench.runItem(item, { agentOverride: candidate, signal, seed });
        results.push({ id: r.id, pass: r.pass, steps: r.steps || 0, ms: r.ms, seed, ...(r.error ? { error: r.error } : {}) });
        onRun?.();
      }
    }
    const errors = results.filter((r) => r.error);
    // A crashed run (no model, timeout, abort) says nothing about the genome. Refuse to score instead of recording 0.
    if (errors.length > results.length / 2) {
      throw new Error(`evolution aborted: ${errors.length}/${results.length} runs errored, so fitness would measure infrastructure, not the genome. First error: ${errors[0].error}`);
    }
    return { ...summarize(results.filter((r) => !r.error)), errors: errors.length };
  }

  #population(agent, partner, size, mutationRate) {
    const genomes = [agent.genome];
    for (let attempts = 0; genomes.length < size && attempts < 200; attempts++) {
      const useCross = partner && genomes.length % 2 === 0;
      const g = useCross ? mutate(crossover(agent.genome, partner.genome), mutationRate / 2).genome : mutate(agent.genome, mutationRate).genome;
      if (!genomes.includes(g)) genomes.push(g);
    }
    return genomes;
  }

  async evolve(agentId, { population = 4, mutationRate = 0.04, repeats = 1, confirm = true, minGain = 0.02, signal, onProgress } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    population = Math.max(2, Math.min(8, population | 0));
    repeats = Math.max(1, Math.min(5, repeats | 0));
    const items = this.itemsFor(agentId);
    const partner = this.agents.list().filter((a) => a.id !== agentId && a.fitness != null).sort((a, b) => b.fitness - a.fitness)[0];
    const genomes = this.#population(agent, partner, population, mutationRate);
    const generation = (agent.generation || 0) + 1;
    // Same seeds for every candidate in this generation; fresh seeds for confirmation.
    const screenSeeds = Array.from({ length: repeats }, (_, r) => generation * 1000 + r + 1);
    const confirmSeeds = Array.from({ length: repeats }, (_, r) => generation * 1000 + 500 + r + 1);
    const totalRuns = items.length * repeats * (genomes.length + (confirm ? 2 : 0));
    let done = 0, stage = 'screening';
    const progress = (phase, extra = {}) => onProgress?.({ agentId, generation, phase, done, total: totalRuns, ...extra });
    const onRun = () => { done++; progress(stage); };

    const scored = [];
    for (const [i, g] of genomes.entries()) {
      const f = await this.evaluate(agent, g, items, screenSeeds, { signal, onRun });
      const row = { id: newId('ev'), genome: g, incumbent: g === agent.genome, distance: round3(geneticDistance(agent.genome, g)), ...f };
      scored.push(row);
      this.bus?.publish('evolution.candidate', { agentId, generation, index: i, incumbent: row.incumbent, fitness: f.fitness, passRate: f.passRate, distance: row.distance });
    }
    const incumbent = scored.find((s) => s.incumbent);
    const challenger = scored.filter((s) => !s.incumbent).sort((a, b) => b.fitness - a.fitness || a.distance - b.distance)[0];

    let confirmation = null, promoted = false, reason;
    if (!challenger) reason = 'no distinct challenger could be bred';
    else if (challenger.fitness <= incumbent.fitness) reason = `best challenger ${challenger.fitness} did not beat incumbent ${incumbent.fitness} on screening`;
    else if (!confirm) {
      promoted = challenger.fitness - incumbent.fitness >= minGain;
      reason = promoted ? 'beat incumbent on screening (confirmation disabled)' : `screening gain below the minimum ${minGain}; treated as a tie`;
    }
    else {
      stage = 'confirm';
      progress(stage);
      const ci = await this.evaluate(agent, incumbent.genome, items, confirmSeeds, { signal, onRun });
      const cc = await this.evaluate(agent, challenger.genome, items, confirmSeeds, { signal, onRun });
      const pooledInc = summarize([...incumbent.results, ...ci.results]);
      const pooledCh = summarize([...challenger.results, ...cc.results]);
      confirmation = {
        seeds: confirmSeeds,
        incumbent: { fitness: ci.fitness, passRate: ci.passRate }, challenger: { fitness: cc.fitness, passRate: cc.passRate },
        pooled: { incumbent: pooledInc.fitness, challenger: pooledCh.fitness, incumbentCi95: pooledInc.ci95, challengerCi95: pooledCh.ci95 },
        paired: paired([...incumbent.results, ...ci.results], [...challenger.results, ...cc.results]),
      };
      const gain = round3(pooledCh.fitness - pooledInc.fitness);
      const { wins, losses } = confirmation.paired;
      if (cc.fitness < ci.fitness) reason = `screening win did not hold on fresh seeds (${cc.fitness} vs ${ci.fitness})`;
      else if (losses > wins) reason = `challenger lost more paired cells than it won (${wins} wins, ${losses} losses)`;
      // A tie on correctness that differs only by a fraction of a step is noise, not progress (genetic drift).
      else if (gain < minGain) reason = `pooled gain ${gain} is below the minimum ${minGain} (${pooledCh.fitness} vs ${pooledInc.fitness}); treated as a tie`;
      else { promoted = true; reason = `confirmed on fresh seeds (${cc.fitness} vs ${ci.fitness}); pooled ${pooledCh.fitness} vs ${pooledInc.fitness} (+${gain}); paired ${wins} wins, ${losses} losses`; }
    }

    for (const s of scored) {
      const detail = { passRate: s.passRate, passed: s.passed, runs: s.runs, ci95: s.ci95, cost: s.cost, seeds: screenSeeds, items: items.map((i) => i.id),
        perRun: s.results, ...(s === challenger && confirmation ? { confirmation } : {}) };
      this.store.run('INSERT INTO evolution (id, agent_id, generation, genome, fitness, parent_a, parent_b, promoted, created, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        s.id, agentId, generation, s.genome, s.fitness, s.incumbent ? null : agentId, partner && !s.incumbent ? partner.id : null,
        promoted && s === challenger ? 1 : 0, nowIso(), JSON.stringify(detail));
    }
    const newFitness = promoted ? (confirmation ? confirmation.pooled.challenger : challenger.fitness)
      : (confirmation ? confirmation.pooled.incumbent : incumbent.fitness);
    if (promoted) this.agents.setGenome(agentId, challenger.genome, { generation, fitness: newFitness });
    else this.store.run('UPDATE agents SET generation = ?, fitness = ? WHERE id = ?', generation, newFitness, agentId);

    const changes = challenger ? traitDiff(agent.genome, challenger.genome) : [];
    const summary = {
      agentId, generation, promoted, reason, items: items.map((i) => i.id), repeats, seeds: screenSeeds,
      incumbent: incumbent.fitness, best: challenger?.fitness ?? null, fitness: newFitness,
      challengerChanges: changes, confirmation,
      traits: promoted ? genomeToTraits(challenger.genome) : agent.traits,
      candidates: scored.map((s) => ({ incumbent: s.incumbent, fitness: s.fitness, passRate: s.passRate, ci95: s.ci95, distance: s.distance })),
    };
    this.ledger.append('evolution', { agentId, generation, promoted, reason, incumbent: incumbent.fitness, best: summary.best, confirmation: confirmation?.pooled || null, changes }, 'agency');
    this.bus?.publish('evolution.generation', { agentId, generation, promoted, reason, incumbent: incumbent.fitness, best: summary.best });
    return summary;
  }

  /** Several generations in a row. */
  async run(agentId, { generations = 1, ...opts } = {}) {
    const out = [];
    for (let g = 0; g < Math.max(1, Math.min(10, generations | 0)); g++) out.push(await this.evolve(agentId, opts));
    return { agentId, generations: out, promotions: out.filter((r) => r.promoted).length, finalFitness: out.at(-1).fitness };
  }

  /** Background job (evolution takes minutes on a local GPU). One at a time: the GPU is the bottleneck. */
  start(agentId, opts = {}) {
    if (this.active) throw new Error(`evolution job ${this.active} is already running`);
    if (!this.agents.get(agentId)) throw new Error(`agent ${agentId} not found`);
    const ctrl = new AbortController();
    const job = { id: newId('evo'), agentId, status: 'running', started: nowIso(), progress: null, result: null, error: null, ctrl };
    this.jobs.set(job.id, job);
    this.active = job.id;
    this.run(agentId, { ...opts, signal: ctrl.signal, onProgress: (p) => { job.progress = p; this.bus?.publish('evolution.progress', { jobId: job.id, ...p }, { ephemeral: true }); } })
      .then((r) => { job.status = 'done'; job.result = r; this.bus?.publish('evolution.done', { jobId: job.id, agentId, promotions: r.promotions, finalFitness: r.finalFitness }); })
      .catch((e) => { job.status = ctrl.signal.aborted ? 'cancelled' : 'failed'; job.error = errorMessage(e); this.bus?.publish('evolution.done', { jobId: job.id, agentId, error: job.error }); })
      .finally(() => { job.finished = nowIso(); this.active = null; });
    return this.job(job.id);
  }

  job(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    const { ctrl, ...rest } = j;
    return rest;
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return false;
    j.ctrl.abort(new Error('cancelled'));
    return true;
  }

  history(agentId, limit = 50) {
    return this.store.all(`SELECT generation, fitness, promoted, genome, detail, created FROM evolution WHERE agent_id = ? ORDER BY created DESC LIMIT ${Math.min(500, limit | 0)}`, agentId)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
  }
}
