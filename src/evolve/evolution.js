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
import { SUITES, wilson, agentItems } from '../telemetry/bench.js';

const BASE_RATE = 0.04;
const MAX_RATE = 0.12;

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

/**
 * Exact one-sided sign test on paired cells: the probability of at least `wins` wins out of the discordant
 * cells (wins + losses) if the challenger were no better than the incumbent. Ties carry no information.
 */
export function signTest(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  let p = 0, c = 1; // c = C(n, k), built incrementally from k = 0
  for (let k = 0; k <= n; k++) {
    if (k >= wins) p += c;
    c = (c * (n - k)) / (k + 1);
  }
  return round3(p / 2 ** n);
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

  /** Training items: the only items selection ever sees. */
  itemsFor(agentId) {
    const own = agentItems(agentId, 'train');
    return own.length ? own : SUITES.core.filter((i) => ['reasoning', 'format'].includes(i.category)).map((i) => ({ ...i, agent: agentId }));
  }

  /** Held-out items: used only to re-test a finished run, never to choose a genome. */
  holdoutFor(agentId) { return agentItems(agentId, 'holdout'); }

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
    // Distinct by PHENOTYPE, not just sequence: a mutation in the low bits of a gene can decode to the same trait
    // values (a synonymous mutation). Such a "challenger" behaves exactly like the incumbent, so testing it wastes
    // GPU runs and promoting it would be pure noise.
    const genomes = [agent.genome];
    const phenotypes = new Set([JSON.stringify(genomeToTraits(agent.genome))]);
    for (let attempts = 0; genomes.length < size && attempts < 400; attempts++) {
      const useCross = partner && genomes.length % 2 === 0;
      const g = useCross ? mutate(crossover(agent.genome, partner.genome), mutationRate / 2).genome : mutate(agent.genome, mutationRate).genome;
      const p = JSON.stringify(genomeToTraits(g));
      if (!phenotypes.has(p)) { phenotypes.add(p); genomes.push(g); }
    }
    return genomes;
  }

  // alpha: the paired sign test must reach p <= alpha before a promotion. Phase 4 measured that a behaviorally
  // identical copy of the incumbent can "win" 2-0 on the same seeds (seeded GPU runs are not fully repeatable),
  // so a clean-looking 2-0 (p = 0.25) is not evidence. Default 0.1 needs at least 4 wins and 0 losses.
  async evolve(agentId, { population = 4, mutationRate = BASE_RATE, repeats = 1, confirm = true, minGain = 0.02, alpha = 0.1, signal, onProgress } = {}) {
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
      const p = signTest(wins, losses);
      confirmation.signTestP = p;
      if (cc.fitness < ci.fitness) reason = `screening win did not hold on fresh seeds (${cc.fitness} vs ${ci.fitness})`;
      else if (losses > wins) reason = `challenger lost more paired cells than it won (${wins} wins, ${losses} losses)`;
      // Accuracy claims need evidence beyond run-to-run noise. (All-tie, efficiency-only gains are governed by minGain.)
      else if (wins + losses > 0 && p > alpha) reason = `paired ${wins} wins, ${losses} losses is not significant (sign test p = ${p} > ${alpha}); treated as noise`;
      // A tie on correctness that differs only by a fraction of a step is noise, not progress (genetic drift).
      else if (gain < minGain) reason = `pooled gain ${gain} is below the minimum ${minGain} (${pooledCh.fitness} vs ${pooledInc.fitness}); treated as a tie`;
      else { promoted = true; reason = `confirmed on fresh seeds (${cc.fitness} vs ${ci.fitness}); pooled ${pooledCh.fitness} vs ${pooledInc.fitness} (+${gain}); paired ${wins} wins, ${losses} losses (p = ${p})`; }
    }

    for (const s of scored) {
      const detail = { passRate: s.passRate, passed: s.passed, runs: s.runs, ci95: s.ci95, cost: s.cost, seeds: screenSeeds, items: items.map((i) => i.id), mutationRate: round3(mutationRate),
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
      agentId, generation, promoted, reason, items: items.map((i) => i.id), repeats, seeds: screenSeeds, mutationRate: round3(mutationRate),
      incumbent: incumbent.fitness, best: challenger?.fitness ?? null, fitness: newFitness,
      challengerChanges: changes, confirmation,
      traits: promoted ? genomeToTraits(challenger.genome) : agent.traits,
      candidates: scored.map((s) => ({ incumbent: s.incumbent, fitness: s.fitness, passRate: s.passRate, ci95: s.ci95, distance: s.distance })),
    };
    this.ledger.append('evolution', { agentId, generation, promoted, reason, incumbent: incumbent.fitness, best: summary.best, confirmation: confirmation?.pooled || null, changes }, 'agency');
    this.bus?.publish('evolution.generation', { agentId, generation, promoted, reason, incumbent: incumbent.fitness, best: summary.best });
    return summary;
  }

  /**
   * Several generations in a row.
   *  - patience: stop after this many consecutive generations without a promotion (0 = never stop early).
   *  - adaptive: while no challenger wins, widen the search (mutation rate x1.5 per stalled generation,
   *    capped); reset to the base rate after a promotion.
   *  - holdout: if the genome changed, re-test the starting and final genomes on held-out items with fresh
   *    seeds. This is reported, never used to choose: using it to choose would turn it into training data.
   */
  async run(agentId, { generations = 1, patience = 2, adaptive = true, holdout = true, holdoutRepeats = 3, mutationRate = BASE_RATE, ...opts } = {}) {
    const startAgent = this.agents.get(agentId);
    if (!startAgent) throw new Error(`agent ${agentId} not found`);
    const max = Math.max(1, Math.min(20, generations | 0));
    const out = [];
    let rate = mutationRate, stalled = 0, stoppedEarly = false;
    for (let g = 0; g < max; g++) {
      const r = await this.evolve(agentId, { ...opts, mutationRate: rate });
      out.push(r);
      if (r.promoted) { stalled = 0; rate = mutationRate; }
      else { stalled++; if (adaptive) rate = Math.min(MAX_RATE, rate * 1.5); }
      if (patience > 0 && stalled >= patience && g < max - 1) { stoppedEarly = true; break; }
    }
    const finalAgent = this.agents.get(agentId);
    const result = {
      agentId, generations: out, promotions: out.filter((r) => r.promoted).length, finalFitness: out.at(-1).fitness,
      stoppedEarly, startGenome: startAgent.genome, finalGenome: finalAgent.genome, changes: traitDiff(startAgent.genome, finalAgent.genome),
    };
    if (holdout) result.holdout = await this.validateHoldout(agentId, startAgent, finalAgent, { repeats: holdoutRepeats, signal: opts.signal, onProgress: opts.onProgress });
    return result;
  }

  /** Out-of-sample check of a finished run: starting vs final genome on held-out items, paired, fresh seeds. */
  async validateHoldout(agentId, startAgent, finalAgent, { repeats = 3, signal, onProgress } = {}) {
    const items = this.holdoutFor(agentId);
    if (!items.length) return { skipped: 'no held-out items for this agent' };
    if (startAgent.genome === finalAgent.genome) return { skipped: 'genome unchanged, nothing to validate' };
    repeats = Math.max(1, Math.min(5, repeats | 0));
    const generation = finalAgent.generation || 0;
    // 900+ offsets never collide with screening (1..5) or confirmation (501..505) seeds of any generation.
    const seeds = Array.from({ length: repeats }, (_, r) => generation * 1000 + 900 + r + 1);
    const total = items.length * repeats * 2;
    let done = 0;
    const onRun = () => { done++; onProgress?.({ agentId, generation, phase: 'holdout', done, total }); };
    const before = await this.evaluate(finalAgent, startAgent.genome, items, seeds, { signal, onRun });
    const after = await this.evaluate(finalAgent, finalAgent.genome, items, seeds, { signal, onRun });
    const pr = paired(before.results, after.results);
    const delta = round3(after.fitness - before.fitness);
    const verdict = after.passRate > before.passRate && pr.wins > pr.losses ? 'improved out of sample'
      : after.passRate < before.passRate || pr.losses > pr.wins ? 'worse out of sample (overfit to training items)'
        : 'no accuracy change out of sample';
    const res = {
      items: items.map((i) => i.id), seeds, verdict, delta, paired: pr,
      before: { fitness: before.fitness, passRate: before.passRate, ci95: before.ci95, perRun: before.results },
      after: { fitness: after.fitness, passRate: after.passRate, ci95: after.ci95, perRun: after.results },
    };
    this.ledger.append('evolution.holdout', { agentId, generation, verdict, delta, paired: pr, before: before.passRate, after: after.passRate }, 'agency');
    this.bus?.publish('evolution.holdout', { agentId, generation, verdict, delta, before: before.passRate, after: after.passRate });
    return res;
  }

  /** Background job (evolution takes minutes on a local GPU). One at a time: the GPU is the bottleneck.
   *  target: one agent id, or an array of ids evolved one after another (a fleet run). */
  start(target, opts = {}) {
    const ids = Array.isArray(target) ? [...new Set(target)] : [target];
    if (!ids.length) throw new Error('no agents to evolve');
    for (const id of ids) if (!this.agents.get(id)) throw new Error(`agent ${id} not found`);
    if (this.active) throw new Error(`evolution job ${this.active} is already running`);
    const fleet = Array.isArray(target);
    const ctrl = new AbortController();
    const job = { id: newId('evo'), agentId: fleet ? ids.join(',') : ids[0], agents: ids, status: 'running', started: nowIso(), progress: null, result: null, error: null, ctrl };
    this.jobs.set(job.id, job);
    this.active = job.id;
    const onProgress = (p) => {
      job.progress = { ...p, agentIndex: ids.indexOf(p.agentId), agentCount: ids.length };
      this.bus?.publish('evolution.progress', { jobId: job.id, ...job.progress }, { ephemeral: true });
    };
    const work = fleet
      ? (async () => {
        const agents = [];
        for (const id of ids) agents.push(await this.run(id, { ...opts, signal: ctrl.signal, onProgress }));
        return { fleet: true, agents, promotions: agents.reduce((s, a) => s + a.promotions, 0), finalFitness: Object.fromEntries(agents.map((a) => [a.agentId, a.finalFitness])) };
      })()
      : this.run(ids[0], { ...opts, signal: ctrl.signal, onProgress });
    const agentId = job.agentId;
    work
      // Free the slot BEFORE announcing completion, so a listener can start the next job from evolution.done.
      .then((r) => { job.status = 'done'; job.result = r; }, (e) => { job.status = ctrl.signal.aborted ? 'cancelled' : 'failed'; job.error = errorMessage(e); })
      .finally(() => {
        job.finished = nowIso();
        this.active = null;
        this.bus?.publish('evolution.done', job.error ? { jobId: job.id, agentId, error: job.error } : { jobId: job.id, agentId, promotions: job.result.promotions, finalFitness: job.result.finalFitness });
      });
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

  /** Fitness by generation, oldest first: incumbent, best challenger, promotion, and the search width used. */
  lineage(agentId) {
    const rows = this.store.all('SELECT generation, fitness, promoted, parent_a, detail FROM evolution WHERE agent_id = ? ORDER BY generation, created', agentId);
    const gens = new Map();
    for (const r of rows) {
      const d = JSON.parse(r.detail || '{}');
      const g = gens.get(r.generation) || { generation: r.generation, incumbent: null, best: null, promoted: false, candidates: 0, mutationRate: d.mutationRate ?? null, confirmation: null };
      g.candidates++;
      if (r.parent_a == null) g.incumbent = r.fitness;
      else if (g.best == null || r.fitness > g.best) g.best = r.fitness;
      if (r.promoted) g.promoted = true;
      if (d.confirmation) g.confirmation = d.confirmation.pooled;
      gens.set(r.generation, g);
    }
    // Fitness the agent carried out of each generation: pooled score if a confirmation ran, else the screening score of the kept genome.
    return [...gens.values()].map((g) => ({ ...g, carried: g.confirmation ? (g.promoted ? g.confirmation.challenger : g.confirmation.incumbent) : (g.promoted ? g.best : g.incumbent) }));
  }

  history(agentId, limit = 50) {
    return this.store.all(`SELECT generation, fitness, promoted, genome, detail, created FROM evolution WHERE agent_id = ? ORDER BY created DESC LIMIT ${Math.min(500, limit | 0)}`, agentId)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
  }
}
