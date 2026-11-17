// Mission engine: plan -> parallel DAG execution -> critic verification -> self-healing retries ->
// replanning -> synthesis -> security review -> archival. Fully checkpointed and resumable.
import { newId, nowIso, sha256, truncate, errorMessage, extractJson, Semaphore } from '../core/util.js';
import { screenGoal, redactSecrets } from '../guard/sentinel.js';
import { planPrompt, normalizePlan, isAcyclic, criticPrompt } from './plan.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class MissionEngine {
  constructor(deps) {
    Object.assign(this, deps); // cfg, store, router, runtime, agents, memory, ledger, bus, tracer, logicChain, consensus
    this.active = new Map(); // missionId -> AbortController
  }

  // ---------- persistence ----------
  get(id) {
    const m = this.store.get('SELECT * FROM missions WHERE id = ?', id);
    if (!m) return null;
    const tasks = this.store.all('SELECT * FROM tasks WHERE mission_id = ? ORDER BY created ASC', id)
      .map((t) => ({ ...t, deps: JSON.parse(t.deps), critique: t.critique ? JSON.parse(t.critique) : null }));
    return { ...m, plan: m.plan ? JSON.parse(m.plan) : null, options: JSON.parse(m.options), checkpoint: m.checkpoint ? JSON.parse(m.checkpoint) : null, result: m.result ? JSON.parse(m.result) : null, tasks };
  }

  list({ limit = 50, status = null } = {}) {
    return this.store.all(`SELECT id, goal, status, score, replans, created, updated, finished FROM missions WHERE (? IS NULL OR status = ?) ORDER BY created DESC LIMIT ${Math.min(500, limit | 0)}`, status, status);
  }

  #setStatus(id, status, extra = {}) {
    const fields = ['status = ?', 'updated = ?'];
    const vals = [status, nowIso()];
    for (const [k, v] of Object.entries(extra)) { fields.push(`${k} = ?`); vals.push(v); }
    if (TERMINAL.has(status)) { fields.push('finished = ?'); vals.push(nowIso()); }
    this.store.run(`UPDATE missions SET ${fields.join(', ')} WHERE id = ?`, ...vals, id);
    this.bus.publish('mission.status', { missionId: id, status, ...extra });
  }

  #checkpoint(id, data) {
    this.store.run('UPDATE missions SET checkpoint = ?, updated = ? WHERE id = ?', { ...data, at: nowIso() }, nowIso(), id);
  }

  // ---------- public API ----------
  /** Create and start a mission. options: { mode: standard|logic_chain|consensus, privacy, maxTasks, securityReview, agents } */
  create(goal, options = {}) {
    const screen = screenGoal(goal);
    if (!screen.ok) throw new Error(`Goal rejected by Sentinel: ${screen.reason}`);
    const id = newId('ms');
    const opts = {
      mode: ['standard', 'logic_chain', 'consensus'].includes(options.mode) ? options.mode : 'standard',
      privacy: ['private', 'sealed'].includes(options.privacy) ? options.privacy : 'normal',
      maxTasks: Math.min(this.cfg.limits.maxTasksPerMission, Math.max(1, options.maxTasks || this.cfg.limits.maxTasksPerMission)),
      securityReview: options.securityReview !== false,
      agents: Array.isArray(options.agents) ? options.agents : null,
      notes: screen.notes,
    };
    this.store.run('INSERT INTO missions (id, goal, status, options, created, updated) VALUES (?, ?, ?, ?, ?, ?)', id, String(goal).trim(), 'queued', opts, nowIso(), nowIso());
    this.ledger.append('mission.create', { id, goalHash: sha256(goal), mode: opts.mode, privacy: opts.privacy }, 'operator');
    this.bus.publish('mission.created', { missionId: id, goal: truncate(goal, 200), mode: opts.mode });
    this.start(id);
    return this.get(id);
  }

  start(id) {
    if (this.active.has(id)) return;
    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    const timer = setTimeout(() => ctrl.abort(new Error('mission timeout')), this.cfg.limits.missionTimeoutMs);
    this.#run(id, ctrl.signal)
      .catch((e) => {
        const msg = errorMessage(e);
        if (this.shuttingDown) return; // leave status as-is so the mission resumes on next boot
        if (ctrl.signal.aborted && this.get(id)?.status === 'cancelled') return;
        this.#setStatus(id, 'failed', { error: msg.slice(0, 2000) });
        this.ledger.append('mission.fail', { id, error: msg.slice(0, 300) }, 'agency');
      })
      .finally(() => { clearTimeout(timer); this.active.delete(id); });
  }

  cancel(id) {
    const m = this.get(id);
    if (!m) throw new Error('mission not found');
    if (TERMINAL.has(m.status)) return m;
    this.#setStatus(id, 'cancelled');
    this.active.get(id)?.abort(new Error('cancelled by operator'));
    this.ledger.append('mission.cancel', { id }, 'operator');
    return this.get(id);
  }

  /** Resume missions interrupted by a crash or restart (continuity). */
  resumeInterrupted() {
    const rows = this.store.all("SELECT id FROM missions WHERE status IN ('queued','planning','running','synthesizing') LIMIT 50");
    for (const { id } of rows) {
      this.store.run("UPDATE tasks SET status = 'pending' WHERE mission_id = ? AND status = 'running'", id);
      this.ledger.append('mission.resume', { id }, 'agency');
      this.bus.publish('mission.resumed', { missionId: id });
      this.start(id);
    }
    return rows.map((r) => r.id);
  }

  async waitFor(id, timeoutMs = 600000) {
    const t0 = Date.now();
    for (;;) {
      const m = this.get(id);
      if (!m || TERMINAL.has(m.status)) return m;
      if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // ---------- execution ----------
  async #run(id, signal) {
    const mission = this.get(id);
    const span = this.tracer.start(`mission ${id}`, { kind: 'mission', traceId: id, attrs: { goal: truncate(mission.goal, 300), mode: mission.options.mode } });
    try {
      if (mission.options.mode === 'logic_chain') return await this.#runLogicChain(mission, span, signal);
      if (mission.options.mode === 'consensus') return await this.#runConsensus(mission, span, signal);

      let plan = mission.plan;
      if (!plan || !mission.tasks.length) plan = await this.#plan(mission, span, signal);
      await this.#execute(id, span, signal);
      await this.#finish(id, span, signal);
      span.end('ok');
    } catch (e) {
      span.end(signal.aborted ? 'aborted' : 'error', { error: errorMessage(e) });
      throw e;
    }
  }

  #roster(mission) {
    const all = this.agents.list();
    return mission.options.agents?.length ? all.filter((a) => mission.options.agents.includes(a.id) || a.id === 'lumen' || a.id === 'solon') : all;
  }

  async #plan(mission, span, signal, previous = null) {
    this.#setStatus(mission.id, 'planning');
    const roster = this.#roster(mission);
    const ctx = await this.memory.contextPack(mission.goal, { k: 4, maxChars: 1800 });
    const s = span.child('plan', { kind: 'plan', agentId: 'genesis' });
    let plan = null;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      try {
        const res = await this.router.chat({ role: 'plan', messages: planPrompt(mission.goal, roster, { maxTasks: mission.options.maxTasks, context: ctx.text, previous }), json: true, temperature: 0.2, maxTokens: 1800, privacy: mission.options.privacy, missionId: mission.id, span: s, signal });
        plan = normalizePlan(res.text, roster, { maxTasks: mission.options.maxTasks, idPrefix: previous ? `r${mission.replans + 1}_` : '' });
      } catch (e) {
        if (signal.aborted) throw e;
        s.set(`attempt${attempt}`, errorMessage(e));
      }
    }
    if (!plan || !isAcyclic(plan.tasks)) {
      // Honest fallback: research (if web-capable) then write, then the critic still verifies.
      const hasScout = roster.some((a) => a.id === 'spearhead');
      plan = {
        summary: 'Fallback plan (planner output was unusable).', fallback: true,
        tasks: [
          ...(hasScout && !previous ? [{ id: 'gather', title: 'Gather facts', agent: 'spearhead', instructions: `Collect the key facts needed for: ${mission.goal}`, deps: [], privacy: mission.options.privacy }] : []),
          { id: `${previous ? 'r_' : ''}deliver`, title: 'Produce the deliverable', agent: 'lumen', instructions: mission.goal, deps: hasScout && !previous ? ['gather'] : [], privacy: mission.options.privacy },
        ],
      };
    }
    if (mission.options.privacy !== 'normal') for (const t of plan.tasks) t.privacy = mission.options.privacy;
    this.store.tx(() => {
      for (const t of plan.tasks) {
        this.store.run(`INSERT INTO tasks (id, mission_id, agent_id, title, instructions, deps, status, privacy, created) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          `${mission.id}:${t.id}`, mission.id, t.agent, t.title, t.instructions, t.deps.map((d) => `${mission.id}:${d}`), t.privacy, nowIso());
      }
      const merged = previous ? { ...(mission.plan || {}), revisions: [...(mission.plan?.revisions || []), plan] } : plan;
      this.store.run('UPDATE missions SET plan = ?, updated = ? WHERE id = ?', merged, nowIso(), mission.id);
    });
    s.end('ok', { tasks: plan.tasks.length, fallback: Boolean(plan.fallback) });
    this.ledger.append('mission.plan', { id: mission.id, tasks: plan.tasks.map((t) => `${t.id}:${t.agent}`), replan: Boolean(previous) }, 'genesis');
    this.bus.publish('mission.plan', { missionId: mission.id, plan });
    return plan;
  }

  async #execute(id, span, signal) {
    this.#setStatus(id, 'running');
    const gate = new Semaphore(2); // GPU work is serialized in the router; this lets edge/cloud tasks overlap
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const mission = this.get(id);
      const tasks = mission.tasks;
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const blocked = tasks.filter((t) => t.status === 'pending' && t.deps.some((d) => ['failed', 'skipped'].includes(byId.get(d)?.status)));
      for (const t of blocked) this.store.run("UPDATE tasks SET status = 'skipped', output = ? WHERE id = ?", `Skipped: dependency failed (${t.deps.join(', ')})`, t.id);
      const ready = tasks.filter((t) => t.status === 'pending' && t.deps.every((d) => byId.get(d)?.status === 'done' || byId.get(d)?.status === 'unverified'));
      if (ready.length === 0) {
        const failed = tasks.filter((t) => ['failed', 'skipped'].includes(t.status));
        const pending = tasks.filter((t) => t.status === 'pending');
        if ((failed.length || pending.length) && mission.replans < this.cfg.limits.maxReplans) {
          const state = tasks.map((t) => `- ${t.title} [${t.agent_id}] -> ${t.status}${t.critique?.defects?.length ? ` (defects: ${t.critique.defects.slice(0, 3).join('; ')})` : ''}${t.status === 'done' ? `: ${truncate(t.output, 300)}` : ''}`).join('\n');
          this.store.run("UPDATE tasks SET status = 'abandoned' WHERE mission_id = ? AND status IN ('failed','skipped','pending')", id);
          this.store.run('UPDATE missions SET replans = replans + 1 WHERE id = ?', id);
          this.bus.publish('mission.replan', { missionId: id, reason: `${failed.length} failed, ${pending.length} stuck` });
          await this.#plan(this.get(id), span, signal, state);
          continue;
        }
        return;
      }
      await Promise.all(ready.map((t) => gate.run(() => this.#runTask(id, t, span, signal))));
      this.#checkpoint(id, { phase: 'execute', done: this.get(id).tasks.filter((t) => t.status === 'done').map((t) => t.id) });
    }
  }

  #depOutputs(mission, task) {
    const replanned = /:r\d+_/.test(task.id);
    const sources = task.deps.length || !replanned
      ? task.deps.map((d) => mission.tasks.find((t) => t.id === d))
      : mission.tasks.filter((t) => t.status === 'done' || t.status === 'unverified'); // revised plans inherit earlier verified work
    return sources.filter(Boolean)
      .map((t) => `### ${t.title} (by ${t.agent_id}, score ${t.score ?? 'n/a'})\n${truncate(t.output, 3500)}`).join('\n\n');
  }

  async #runTask(missionId, task, span, signal) {
    const mission = this.get(missionId);
    const tspan = span.child(`task ${task.title}`, { kind: 'task', agentId: task.agent_id, attrs: { taskId: task.id } });
    this.store.run("UPDATE tasks SET status = 'running', started = ? WHERE id = ?", nowIso(), task.id);
    this.bus.publish('task.status', { missionId, taskId: task.id, status: 'running', agentId: task.agent_id, title: task.title });
    const inputs = this.#depOutputs(mission, task);
    let critique = null, result = null, attempts = 0; // a resumed task gets a fresh attempt budget
    try {
      while (attempts < this.cfg.limits.maxTaskAttempts) {
        attempts++;
        const prompt = [
          `Mission goal: ${mission.goal}`,
          `Your task: ${task.title}\n${task.instructions}`,
          inputs ? `\nInputs from teammates:\n${inputs}` : '',
          critique ? `\nYour previous attempt was rejected by the critic (score ${critique.score}). Defects:\n${(critique.defects || []).map((d) => `- ${d}`).join('\n')}\nFix: ${critique.fix || 'address the defects'}\nPrevious attempt:\n${truncate(result?.final, 2500)}` : '',
        ].filter(Boolean).join('\n');
        result = await this.runtime.run(task.agent_id, prompt, { missionId, taskId: task.id, span: tspan, privacy: task.privacy, signal });
        critique = await this.#critique(task, result, tspan, signal);
        this.bus.publish('task.critique', { missionId, taskId: task.id, attempt: attempts, score: critique.score, pass: critique.pass });
        if (critique.pass) break;
      }
      const status = critique.pass ? 'done' : 'unverified';
      this.store.run('UPDATE tasks SET status = ?, output = ?, attempts = ?, score = ?, critique = ?, model = ?, finished = ? WHERE id = ?',
        status, result.final, attempts, critique.score, critique, result.model, nowIso(), task.id);
      this.agents.recordRun(task.agent_id, critique.score);
      if (critique.pass && critique.score >= 0.85) {
        await this.memory.write({ kind: 'playbook', agentId: task.agent_id, importance: Math.min(1, critique.score), tags: ['verified'],
          content: `Verified pattern (${task.agent_id}, score ${critique.score}, ${attempts} attempt${attempts > 1 ? 's' : ''}): "${truncate(task.title, 120)}" — approach: ${truncate(result.steps.filter((s) => s.tool).map((s) => s.tool).join(' → ') || 'direct answer', 160)}.`, source: `mission:${missionId}` });
      }
      tspan.end('ok', { score: critique.score, attempts, status });
      this.bus.publish('task.status', { missionId, taskId: task.id, status, score: critique.score, agentId: task.agent_id });
    } catch (e) {
      if (signal.aborted) { tspan.end('aborted'); throw e; }
      const msg = errorMessage(e);
      this.store.run("UPDATE tasks SET status = 'failed', output = ?, attempts = ?, finished = ? WHERE id = ?", `Error: ${msg}`, attempts, nowIso(), task.id);
      tspan.end('error', { error: msg });
      this.bus.publish('task.status', { missionId, taskId: task.id, status: 'failed', error: msg });
    }
  }

  async #critique(task, result, span, signal) {
    const evidence = result.steps.filter((s) => s.tool).map((s) => `- ${s.tool} ${s.ok ? 'OK' : 'FAILED'} (sha ${s.evidence?.sha256?.slice(0, 10) ?? '-'}) ${truncate(s.summary, 260)}`).join('\n');
    const solon = this.agents.get('solon');
    const threshold = Math.max(this.cfg.limits.criticThreshold, (solon?.traits.criticStrictness ?? 0.6) - 0.05);
    try {
      const res = await this.router.chat({ role: 'critic', messages: criticPrompt(task, truncate(result.final, 6000), evidence), json: true, temperature: 0.1, maxTokens: 700, privacy: task.privacy, missionId: task.mission_id, span: span.child('critic', { kind: 'critic', agentId: 'solon' }), signal });
      const c = extractJson(res.text) || {};
      const score = Math.min(1, Math.max(0, Number(c.score) || 0));
      return { score, pass: score >= threshold && c.pass !== false, defects: Array.isArray(c.defects) ? c.defects.map(String).slice(0, 8) : [], fix: String(c.fix || '').slice(0, 800), threshold };
    } catch (e) {
      if (signal.aborted) throw e;
      // Critic unavailable: fall back to the agent's own confidence, capped below a verified pass.
      const score = Math.min(0.59, result.confidence);
      return { score, pass: false, defects: [`critic unavailable: ${errorMessage(e)}`], fix: '', threshold, unverified: true };
    }
  }

  async #finish(id, span, signal) {
    this.#setStatus(id, 'synthesizing');
    const mission = this.get(id);
    const done = mission.tasks.filter((t) => ['done', 'unverified'].includes(t.status));
    if (done.length === 0) throw new Error('no task produced output');
    const last = done.at(-1);
    let deliverable;
    const multi = done.length > 1;
    if (multi) {
      const sum = done.map((t) => `### ${t.title} (${t.agent_id}, ${t.status}, score ${t.score})\n${truncate(t.output, 4000)}`).join('\n\n');
      const res = await this.runtime.run('lumen', `Mission goal: ${mission.goal}\n\nCombine the team's verified work below into ONE complete final deliverable for the goal. Keep all concrete facts, numbers, code and sources. Note clearly anything marked unverified.\n\n${sum}`, { missionId: id, span, privacy: mission.options.privacy, signal });
      deliverable = res.final;
    } else {
      deliverable = last.output;
    }
    deliverable = redactSecrets(deliverable);
    const finalCritique = await this.#critique({ title: 'Final deliverable', instructions: mission.goal, privacy: mission.options.privacy }, { final: deliverable, steps: [], confidence: 0.6 }, span, signal);

    let security = null;
    if (mission.options.securityReview) {
      try {
        const res = await this.router.chat({ role: 'critic', json: true, temperature: 0.1, maxTokens: 500, privacy: mission.options.privacy, missionId: id, signal, span: span.child('sentinel', { kind: 'review', agentId: 'sentinel' }),
          messages: [
            { role: 'system', content: 'You are Sentinel, a security reviewer. Reply with JSON only.' },
            { role: 'user', content: `Review this deliverable before it is shown or shipped. Look for leaked secrets, unsafe instructions, privacy exposure, irreversible actions, and claims that could cause harm.\n\nDeliverable:\n${truncate(deliverable, 6000)}\n\nReturn {"risk": "none|low|medium|high", "findings": ["..."]}` },
          ] });
        security = extractJson(res.text) || { risk: 'unknown', findings: ['unparseable review'] };
      } catch (e) { security = { risk: 'unknown', findings: [`review failed: ${errorMessage(e)}`] }; }
    }

    const score = Math.round(((finalCritique.score * 0.6) + (done.reduce((s, t) => s + (t.score || 0), 0) / done.length) * 0.4) * 1000) / 1000;
    const result = { deliverable, finalCritique, security, tasks: mission.tasks.map((t) => ({ id: t.id, title: t.title, agent: t.agent_id, status: t.status, score: t.score, attempts: t.attempts })) };
    this.store.run('UPDATE missions SET result = ?, score = ? WHERE id = ?', result, score, id);
    await this.memory.write({ kind: 'episodic', importance: 0.4 + score * 0.4, tags: ['mission', mission.options.mode],
      content: `Mission "${truncate(mission.goal, 300)}" completed with score ${score} after ${mission.replans} replan(s). Team: ${[...new Set(done.map((t) => t.agent_id))].join(', ')}. Outcome: ${truncate(deliverable, 600)}`, source: `mission:${id}` });
    this.ledger.append('mission.complete', { id, score, resultHash: sha256(deliverable) }, 'genesis');
    this.#setStatus(id, 'completed', { score });
  }

  // ---------- alternative modes ----------
  async #runLogicChain(mission, span, signal) {
    this.#setStatus(mission.id, 'running');
    const out = await this.logicChain.run(mission.goal, { span, signal, privacy: mission.options.privacy, missionId: mission.id });
    const result = { deliverable: redactSecrets(out.brief), logicChain: { ledger: out.ledger, review: out.review, stages: out.stages }, tasks: [] };
    const score = out.score;
    this.store.run('UPDATE missions SET result = ?, score = ? WHERE id = ?', result, score, mission.id);
    await this.memory.write({ kind: 'episodic', importance: 0.6, tags: ['mission', 'logic_chain'], content: `Logic-chain design for "${truncate(mission.goal, 300)}": ${out.ledger.new_logic.length} logic items, ${out.review.open.length} open contradictions/unsupported claims. Brief: ${truncate(out.brief, 500)}`, source: `mission:${mission.id}` });
    this.ledger.append('mission.complete', { id: mission.id, score, mode: 'logic_chain', resultHash: sha256(out.brief) }, 'genesis');
    this.#setStatus(mission.id, 'completed', { score });
    span.end('ok');
  }

  async #runConsensus(mission, span, signal) {
    this.#setStatus(mission.id, 'running');
    const out = await this.consensus.run(mission.goal, { span, signal, privacy: mission.options.privacy, missionId: mission.id, agents: mission.options.agents });
    const result = { deliverable: redactSecrets(out.answer), consensus: { r: out.r, clusters: out.clusters, answers: out.answers }, tasks: [] };
    this.store.run('UPDATE missions SET result = ?, score = ? WHERE id = ?', result, out.r, mission.id);
    await this.memory.write({ kind: 'episodic', importance: 0.5, tags: ['mission', 'consensus'], content: `Consensus on "${truncate(mission.goal, 300)}": coherence R=${out.r}, majority ${out.majorityAgents.join(', ')}. Answer: ${truncate(out.answer, 500)}`, source: `mission:${mission.id}` });
    this.ledger.append('mission.complete', { id: mission.id, score: out.r, mode: 'consensus', resultHash: sha256(out.answer) }, 'solon');
    this.#setStatus(mission.id, 'completed', { score: out.r });
    span.end('ok');
  }
}
