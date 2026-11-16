// Consensus mode: several agents answer independently; answers are embedded and clustered with
// signed-coupling Kuramoto dynamics; Solon merges the majority cluster and reports dissent.
import { kuramotoConsensus } from '../protocols/kuramoto.js';
import { extractJson, truncate, errorMessage } from '../core/util.js';

export class Consensus {
  constructor({ runtime, router, agents, bus }) { Object.assign(this, { runtime, router, agents, bus }); }

  async run(question, { agents = null, span = null, signal, privacy = 'normal', missionId = null } = {}) {
    const pool = (agents?.length ? agents : ['tycho', 'spearhead', 'ariadne', 'forge_keeper'])
      .map((id) => this.agents.get(id)).filter((a) => a && a.enabled);
    if (pool.length < 2) throw new Error('consensus needs at least two enabled agents');
    const answers = [];
    for (const a of pool) {
      if (signal?.aborted) throw new Error('aborted');
      try {
        const r = await this.runtime.run(a, `Answer independently and completely:\n${question}`, { span, signal, privacy, missionId });
        answers.push({ agent: a.id, answer: r.final, confidence: r.confidence, model: r.model });
        this.bus?.publish('consensus.answer', { missionId, agent: a.id, preview: truncate(r.final, 160) });
      } catch (e) {
        if (signal?.aborted) throw e;
        answers.push({ agent: a.id, error: errorMessage(e) });
      }
    }
    const valid = answers.filter((a) => a.answer);
    if (valid.length === 0) throw new Error('no agent produced an answer');
    const { vectors } = await this.router.embed(valid.map((a) => a.answer));
    const k = kuramotoConsensus(vectors);
    const clusters = k.clusters.map((c) => c.map((i) => valid[i].agent));
    const majority = k.majority.map((i) => valid[i]);
    const dissent = valid.filter((a) => !majority.includes(a));
    let answer;
    try {
      const res = await this.router.chat({ role: 'critic', temperature: 0.2, maxTokens: 1800, privacy, signal, span: span?.child('merge', { kind: 'synthesis', agentId: 'solon' }),
        messages: [
          { role: 'system', content: 'You are Solon, consensus mediator. Merge agreeing answers into one; record dissent fairly. Reply in Markdown.' },
          { role: 'user', content: `Question: ${question}\n\nMajority answers:\n${majority.map((a) => `### ${a.agent}\n${truncate(a.answer, 2500)}`).join('\n\n')}\n\n${dissent.length ? `Dissenting answers:\n${dissent.map((a) => `### ${a.agent}\n${truncate(a.answer, 1500)}`).join('\n\n')}` : 'No dissent.'}\n\nWrite: the consensus answer, then "Dissent" (if any) with what differs and whether it matters.` },
        ] });
      answer = res.text.trim();
    } catch (e) {
      if (signal?.aborted) throw e;
      answer = majority[0].answer;
    }
    const parsedConf = extractJson(answer);
    return { answer: typeof parsedConf?.final === 'string' ? parsedConf.final : answer, r: k.r, clusters, similarity: k.similarity, answers, majorityAgents: majority.map((a) => a.agent) };
  }
}
