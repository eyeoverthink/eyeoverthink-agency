// Ouroboros evolution: a genetic algorithm over agent genomes with measured fitness.
// Population = current genome + mutants + crossovers with the fittest other agent. Each candidate runs the
// agent's benchmark items (deterministic checks); fitness = pass rate − small step-cost penalty.
// The winner is promoted only if it beats the incumbent's measured fitness (no regression by construction).
import { newId, nowIso } from '../core/util.js';
import { mutate, crossover, genomeToTraits, geneticDistance, DEFAULT_TRAITS } from '../core/dna.js';
import { SUITES } from '../telemetry/bench.js';

export class Evolution {
  constructor({ store, agents, bench, ledger, bus }) { Object.assign(this, { store, agents, bench, ledger, bus }); }

  itemsFor(agentId) {
    const all = Object.values(SUITES).flat();
    const own = all.filter((i) => i.agent === agentId);
    return own.length ? own : all.filter((i) => ['reasoning', 'format'].includes(i.category)).map((i) => ({ ...i, agent: agentId }));
  }

  async fitness(agent, genome, items, signal) {
    const candidate = { ...agent, genome, traits: { ...DEFAULT_TRAITS, ...genomeToTraits(genome) } };
    let pass = 0, steps = 0;
    const results = [];
    for (const item of items) {
      const r = await this.bench.runItem(item, { agentOverride: candidate, signal });
      results.push(r);
      if (r.pass) pass++;
      steps += r.steps || 0;
    }
    const passRate = items.length ? pass / items.length : 0;
    const cost = items.length ? Math.min(0.1, (steps / items.length) * 0.01) : 0;
    return { fitness: Math.round((passRate - cost) * 1000) / 1000, passRate, results };
  }

  async evolve(agentId, { population = 4, mutationRate = 0.04, signal } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const items = this.itemsFor(agentId);
    const partner = this.agents.list().filter((a) => a.id !== agentId && a.fitness != null).sort((a, b) => b.fitness - a.fitness)[0];
    const genomes = [agent.genome];
    while (genomes.length < population) {
      const useCross = partner && genomes.length % 2 === 0;
      const g = useCross ? mutate(crossover(agent.genome, partner.genome), mutationRate / 2).genome : mutate(agent.genome, mutationRate).genome;
      if (!genomes.includes(g)) genomes.push(g);
    }
    const generation = (agent.generation || 0) + 1;
    const scored = [];
    for (const g of genomes) {
      if (signal?.aborted) throw new Error('aborted');
      const f = await this.fitness(agent, g, items, signal);
      const row = { id: newId('ev'), genome: g, ...f, distance: geneticDistance(agent.genome, g) };
      scored.push(row);
      this.store.run('INSERT INTO evolution (id, agent_id, generation, genome, fitness, parent_a, parent_b, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        row.id, agentId, generation, g, f.fitness, agent.genome === g ? null : agentId, partner && g !== agent.genome ? partner.id : null, nowIso());
      this.bus?.publish('evolution.candidate', { agentId, generation, fitness: f.fitness, distance: row.distance });
    }
    scored.sort((a, b) => b.fitness - a.fitness || a.distance - b.distance);
    const incumbent = scored.find((s) => s.genome === agent.genome);
    const best = scored[0];
    const promoted = best.genome !== agent.genome && best.fitness > incumbent.fitness;
    if (promoted) {
      this.agents.setGenome(agentId, best.genome, { generation, fitness: best.fitness });
      this.store.run('UPDATE evolution SET promoted = 1 WHERE id = ?', best.id);
    } else {
      this.store.run('UPDATE agents SET generation = ? WHERE id = ?', generation, agentId);
    }
    this.ledger.append('evolution', { agentId, generation, promoted, best: best.fitness, incumbent: incumbent.fitness }, 'agency');
    return {
      agentId, generation, promoted, incumbent: incumbent.fitness, best: best.fitness,
      traits: promoted ? genomeToTraits(best.genome) : agent.traits,
      candidates: scored.map((s) => ({ fitness: s.fitness, passRate: s.passRate, distance: Math.round(s.distance * 1000) / 1000 })),
    };
  }

  history(agentId, limit = 50) {
    return this.store.all(`SELECT generation, fitness, promoted, created FROM evolution WHERE agent_id = ? ORDER BY created DESC LIMIT ${Math.min(500, limit | 0)}`, agentId);
  }
}
