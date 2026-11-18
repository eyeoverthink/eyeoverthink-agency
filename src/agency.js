// Composition root: builds one Agency from configuration and wires every subsystem together.
import { loadConfig } from './core/config.js';
import { Store } from './storage/db.js';
import { Keyring } from './core/identity.js';
import { Ledger } from './core/ledger.js';
import { Bus } from './core/bus.js';
import { Tracer } from './telemetry/tracer.js';
import { EdgeHub } from './llm/edge.js';
import { ModelRouter } from './llm/router.js';
import { Memory } from './memory/memory.js';
import { Approvals } from './guard/approvals.js';
import { ToolRegistry } from './tools/registry.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { Membrane, detect } from './guard/membrane.js';
import { AgentRegistry } from './agents/registry.js';
import { AgentRuntime } from './agents/runtime.js';
import { Forge } from './agents/forge.js';
import { MissionEngine } from './orchestrator/missions.js';
import { LogicChain } from './orchestrator/logic-chain.js';
import { Consensus } from './orchestrator/consensus.js';
import { WorkflowEngine, SEED_WORKFLOWS } from './workflows/engine.js';
import { Dreamer } from './dream/dreamer.js';
import { Bench } from './telemetry/bench.js';
import { Evolution } from './evolve/evolution.js';
import { Examiner } from './evolve/examiner.js';
import { Crystallizer, relevance } from './evolve/crystallizer.js';
import { Mesh } from './protocols/mesh.js';
import { McpClient } from './protocols/mcp.js';
import { Continuity } from './continuity/continuity.js';
import { newId, nowIso, errorMessage, truncate } from './core/util.js';

export class Agency {
  constructor(overrides = {}) {
    this.cfg = loadConfig(overrides);
    this.store = new Store(this.cfg.dbPath);
    this.bus = new Bus();
    this.keyring = new Keyring(this.cfg.keysDir);
    this.ledger = new Ledger(this.store, this.keyring, 'agency', this.bus);
    this.tracer = new Tracer(this.store, this.bus);
    this.edge = new EdgeHub(this.cfg.edge, this.bus, this.ledger);
    this.router = new ModelRouter(this.cfg, { edgeHub: this.edge, tracer: this.tracer, bus: this.bus });
    // Privacy Membrane. Its name finder (NER) is itself a model call pinned to privacy 'private', so the text being
    // protected is only ever read by a local model (or on-device Nano), never by the cloud it is protecting against.
    this.membrane = new Membrane({
      store: this.store, ledger: this.ledger, bus: this.bus,
      ner: this.cfg.membrane?.ner === false ? null : async (text) => {
        const res = await this.router.chat({
          // 'reason' by default: measured on this machine, the 3B 'fast' model returned no entities for a text with a
          // name, an address and an account number, while the 'reason' model found all five sensitive spans.
          role: this.cfg.membrane?.nerRole || 'reason', privacy: 'private', json: true, temperature: 0, maxTokens: 400,
          messages: [
            { role: 'system', content: 'You find personal and confidential details in text. Reply with JSON only: {"entities":[{"text":"<exact substring>","type":"PERSON|ORG|ADDRESS|ACCOUNT|HEALTH|DATE_OF_BIRTH"}]}. Copy each text exactly as it appears. Include people\'s names, private organizations, street addresses, account or customer numbers, and medical details. Return {"entities":[]} if there are none.' },
            { role: 'user', content: String(text).slice(0, 4000) },
          ],
        });
        try { return JSON.parse(String(res.text).match(/\{[\s\S]*\}/)?.[0] || '{}').entities || []; } catch { return []; }
      },
    });
    this.router.membrane = this.membrane;
    this.memory = new Memory({ store: this.store, router: this.router, keyring: this.keyring, ledger: this.ledger, bus: this.bus });
    this.approvals = new Approvals({ store: this.store, keyring: this.keyring, ledger: this.ledger, bus: this.bus });
    this.tools = new ToolRegistry({ cfg: this.cfg, approvals: this.approvals, ledger: this.ledger, tracer: this.tracer, bus: this.bus });
    this.agents = new AgentRegistry({ store: this.store, keyring: this.keyring, ledger: this.ledger, bus: this.bus });
    this.runtime = new AgentRuntime({ cfg: this.cfg, router: this.router, tools: this.tools, memory: this.memory, approvals: this.approvals, ledger: this.ledger, bus: this.bus, agents: this.agents });
    this.forge = new Forge({ router: this.router, agents: this.agents, tools: this.tools });
    this.logicChain = new LogicChain({ router: this.router, ledger: this.ledger, bus: this.bus });
    this.consensus = new Consensus({ runtime: this.runtime, router: this.router, agents: this.agents, bus: this.bus });
    this.missions = new MissionEngine({ cfg: this.cfg, store: this.store, router: this.router, runtime: this.runtime, agents: this.agents, memory: this.memory, ledger: this.ledger, bus: this.bus, tracer: this.tracer, logicChain: this.logicChain, consensus: this.consensus });
    this.workflows = new WorkflowEngine({ store: this.store, router: this.router, runtime: this.runtime, tools: this.tools, memory: this.memory, missions: this.missions, approvals: this.approvals, ledger: this.ledger, bus: this.bus, tracer: this.tracer });
    this.dreamer = new Dreamer({ cfg: this.cfg, store: this.store, router: this.router, memory: this.memory, keyring: this.keyring, ledger: this.ledger, bus: this.bus });
    this.bench = new Bench({ store: this.store, runtime: this.runtime, agents: this.agents, router: this.router, bus: this.bus });
    this.evolution = new Evolution({ store: this.store, agents: this.agents, bench: this.bench, ledger: this.ledger, bus: this.bus });
    // Red Queen: examiner-proposed, program-verified exam items that evolution picks up once admitted.
    this.examiner = new Examiner({ store: this.store, router: this.router, agents: this.agents, bench: this.bench, ledger: this.ledger, bus: this.bus });
    this.evolution.examiner = this.examiner;
    // Crystallization: solved tasks become verified, owned skills (tools that need no model). Automatic after a
    // well-scored mission, one at a time, so what the models work out is kept and compounds.
    this.crystallizer = new Crystallizer({ store: this.store, router: this.router, tools: this.tools, missions: this.missions, ledger: this.ledger, bus: this.bus, cfg: this.cfg });
    this.runtime.crystallizer = this.crystallizer; // skill-first: agents use what the agency owns before renting a model
    // The wording audit re-checks old positives against the agent loop's own answer (skill-first off).
    // Phase 16: a task no owned skill could take looks for one among trusted peers (the task text never leaves).
    this.crystallizer.seeker = (task, final, opts) => this.seekSkills(task, final, opts);
    this.crystallizer.agentAnswer = async (task, agentId = this.cfg.skills?.auditAgent || 'tycho') => (agentId === 'gemini' ? this.geminiAnswer(task) : (await this.runtime.run(agentId, task, { skillFirst: false })).final);
    // Phase 17: Gemini through Firebase AI Logic as an independent judge voice, only while a dashboard tab serves as an edge worker.
    this.crystallizer.cloudVoice = { available: () => this.cfg.skills?.cloudJudge !== false && this.edge.available };
    this.crystalQueue = Promise.resolve();
    this.bus.on('mission.status', (e) => {
      const c = this.cfg.crystallize || {};
      if (e.status !== 'completed' || c.auto === false) return;
      const m = this.missions.get(e.missionId);
      if (!m || (m.score ?? 0) < (c.minScore ?? 0.85) || m.options?.privacy === 'private') return;
      this.crystalQueue = this.crystalQueue.then(async () => {
        try { await this.crystallizer.crystallize(this.crystallizer.missionSource(e.missionId)); } catch (err) { this.bus.publish('skill.reject', { name: null, reason: errorMessage(err) }); }
      });
    });
    this.mesh = new Mesh({ cfg: this.cfg, store: this.store, keyring: this.keyring, ledger: this.ledger, bus: this.bus, memory: this.memory, runtime: this.runtime, agents: this.agents, crystallizer: this.crystallizer });
    this.continuity = new Continuity(this);
    this.mcpClients = [];
    this.timers = [];

    registerBuiltinTools(this.tools, { cfg: this.cfg, memory: this.memory, ledger: this.ledger });
    this.tools.membrane = this.membrane;
    this.#registerAgencyTools();
  }

  #registerAgencyTools() {
    this.tools.register({
      name: 'delegate', description: 'Ask another specialist agent to do a sub-task and return its answer.',
      params: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string', maxLength: 40 }, task: { type: 'string', maxLength: 6000 } } },
      timeoutMs: 600000,
      run: async ({ agent, task }, ctx) => {
        if ((ctx.depth || 0) >= 2) throw new Error('delegation depth limit (2) reached');
        if (agent === ctx.agentId) throw new Error('an agent cannot delegate to itself');
        const r = await this.runtime.run(agent, task, { missionId: ctx.missionId, span: ctx.span, depth: (ctx.depth || 0) + 1, privacy: ctx.privacy });
        return { agent, confidence: r.confidence, answer: r.final };
      },
    });
    this.tools.register({
      name: 'workflow_run', description: 'Run a saved workflow by id with a JSON input object.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 60 }, input: { type: 'object' } } },
      timeoutMs: 1800000,
      run: async ({ id, input = {} }) => this.workflows.run(id, input),
    });
    this.tools.register({
      name: 'mesh_send', description: 'Send a signed message to a peer agency (human approval required).', risk: 'approval',
      params: { type: 'object', required: ['peer', 'type', 'body'], properties: { peer: { type: 'string', maxLength: 60 }, type: { type: 'string', enum: ['message', 'memory.share', 'task.request'] }, body: { type: 'object' } } },
      run: ({ peer, type, body }) => this.mesh.send(peer, type, body),
    });
  }

  /** Seed agents/workflows, import manifests, connect MCP servers, resume interrupted missions, start schedulers. */
  async boot({ schedulers = true, resume = true } = {}) {
    this.crystallizer.load(); // learned skills are tools from the first second
    const known = new Set(this.tools.catalog().map((t) => t.name));
    this.agents.seed(known);
    for (const w of SEED_WORKFLOWS) if (!this.workflows.get(w.id)) this.workflows.save(w);
    if (this.cfg.manifestDirs?.length) this.manifestImport = this.agents.importManifests(this.cfg.manifestDirs, known);
    for (const spec of this.cfg.mcpServers || []) {
      try {
        const c = await new McpClient(spec).connect();
        const names = await c.registerInto(this.tools);
        this.mcpClients.push(c);
        this.bus.publish('mcp.connected', { name: spec.name, tools: names.length });
      } catch (e) {
        this.bus.publish('mcp.error', { name: spec.name, error: errorMessage(e) });
      }
    }
    await this.router.refresh();
    this.ledger.append('agency.boot', { pid: process.pid, node: process.version, agents: this.agents.list().length }, 'agency');
    if (resume) this.resumed = this.missions.resumeInterrupted();
    if (schedulers) this.#startSchedulers();
    return this;
  }

  #startSchedulers() {
    if (this.cfg.dream.enabled) {
      this.timers.push(setInterval(() => {
        if (this.missions.active.size === 0) this.dreamer.cycle().catch((e) => this.bus.publish('dream.error', { error: errorMessage(e) }));
      }, this.cfg.dream.intervalMinutes * 60000));
    }
    this.timers.push(setInterval(() => this.autonomyTick().catch((e) => this.bus.publish('autonomy.error', { error: errorMessage(e) })), this.cfg.autonomy.intervalMinutes * 60000));
    for (const t of this.timers) t.unref?.();
  }

  // ----- standing goals (autonomy): opt-in, one mission at a time, never while others run -----
  goals() { return this.store.kvGet('autonomy:goals', []); }
  addGoal(goal, everyHours = 24) {
    const list = this.goals();
    const g = { id: newId('goal'), goal: String(goal).slice(0, 2000), everyHours: Math.max(1, +everyHours || 24), lastRun: null, created: nowIso() };
    list.push(g);
    this.store.kvSet('autonomy:goals', list);
    this.ledger.append('autonomy.goal', { id: g.id, everyHours: g.everyHours }, 'operator');
    return g;
  }
  removeGoal(id) { this.store.kvSet('autonomy:goals', this.goals().filter((g) => g.id !== id)); }

  async autonomyTick() {
    if (!this.store.kvGet('autonomy:enabled', this.cfg.autonomy.enabled) || this.missions.active.size > 0) return null;
    const list = this.goals();
    const due = list.find((g) => !g.lastRun || Date.now() - Date.parse(g.lastRun) > g.everyHours * 3600000);
    if (!due) return null;
    due.lastRun = nowIso();
    this.store.kvSet('autonomy:goals', list);
    const m = this.missions.create(due.goal, { mode: 'standard' });
    this.bus.publish('autonomy.mission', { goalId: due.id, missionId: m.id, goal: truncate(due.goal, 120) });
    return m;
  }

  /**
   * Measured first agent (Phase 18). The voice study scores local agents on tasks with known answers; for tasks of the
   * kind it measured (stated numbers), the most accurate LOCAL agent answers first, but only if that choice also held on
   * a held-out study (skills.answererConfirm) and by a clear margin. Gemini never answers first: it stays a judge, so
   * cloud use remains the exception. Returns { agentId, reason }.
   */
  pickAnswerer(task, fallback = 'tycho') {
    const cfg = this.cfg.skills || {};
    if (cfg.measuredAnswerer === false) return { agentId: fallback, reason: 'measured choice off' };
    const nums = (String(task).match(/\d+(?:\.\d+)?/g) || []).length;
    const study = this.store.kvGet('judge:study', null), held = this.store.kvGet('judge:heldout', null);
    if (nums < 2) return { agentId: fallback, reason: 'outside the measured domain (fewer than 2 stated numbers)' };
    if (!study || study.items < 10) return { agentId: fallback, reason: 'no voice study yet' };
    const local = study.voices.filter((v) => v !== 'gemini' && this.agents.get(v));
    const best = local.sort((a, b) => study.accuracy[b] - study.accuracy[a])[0];
    if (!best || best === fallback) return { agentId: fallback, reason: 'the default agent is already the most accurate' };
    const margin = study.accuracy[best] - (study.accuracy[fallback] ?? 0);
    if (margin < (cfg.answererMargin ?? 0.15)) return { agentId: fallback, reason: `margin ${margin.toFixed(2)} below ${cfg.answererMargin ?? 0.15}` };
    // Selected on one set, confirmed on another: the pick must also win on a held-out study (Phase 3's lesson).
    if (!held || !(held.accuracy?.[best] > (held.accuracy?.[fallback] ?? 1))) return { agentId: fallback, reason: `${best} not yet confirmed on a held-out study` };
    return { agentId: best, reason: `measured: ${best} ${Math.round(study.accuracy[best] * 100)}% (held-out ${Math.round(held.accuracy[best] * 100)}%) vs ${fallback} ${Math.round((study.accuracy[fallback] ?? 0) * 100)}% (held-out ${Math.round((held.accuracy[fallback] ?? 0) * 100)}%)` };
  }

  /**
   * Ask one agent, and report what the answer cost: model calls (counted per async context), time, and how the skill
   * library handled it (answered by a skill, declined with a reason, or judged afterwards by the shadow verdict).
   */
  async ask(agentId, task, opts = {}) {
    let pick = null;
    if (agentId === 'auto') { pick = this.pickAnswerer(task, this.cfg.skills?.defaultAgent || 'tycho'); agentId = pick.agentId; this.ledger.append('agent.pick', { agentId, reason: pick.reason }, 'agency'); }
    const last = (kind) => this.ledger.list({ limit: 1, kind })[0]?.seq ?? 0;
    const before = { miss: last('skill.route_miss'), shadow: last('skill.shadow'), gap: last('skill.gap') };
    const { result, meter } = await this.router.metered(() => this.runtime.run(agentId, task, opts));
    const after = (kind, seq) => this.ledger.list({ limit: 5, kind }).filter((e) => e.seq > seq).map((e) => e.data)[0] || null;
    const miss = result.skill ? null : after('skill.route_miss', before.miss);
    const shadow = after('skill.shadow', before.shadow);
    return { ...result, pick, meter, route: { skill: result.skill || null, zeroCall: Boolean(result.binder), declined: miss?.reason || null, shadow, gap: after('skill.gap', before.gap) } };
  }

  /**
   * Skills over the mesh (Phase 16). After the agents answered a task no owned skill could take, look through trusted
   * peers' catalogs (contracts only, matched HERE with the routing prefilter: the task never leaves this agency), pull
   * the best match not already known, import it on probation, and judge it on this very task: the agents' answer is
   * already here. A skill once rejected (or on probation) is never pulled again.
   */
  async seekSkills(task, final, { agentId = null, missionId = null } = {}) {
    if (this.cfg.skills?.seek === false || !final) return null;
    const peers = this.mesh.peers().filter((p) => p.trust === 'trusted');
    if (!peers.length) return null;
    const local = this.crystallizer.list();
    const known = new Set([...local.map((s) => s.name), ...local.map((s) => s.code_sha256)]);
    const cands = [];
    for (const peer of peers) {
      let cat = [];
      try { cat = await this.mesh.catalog(peer.id); } catch { continue; }
      for (const e of cat) {
        if (!e?.name || known.has(e.name) || known.has(e.code_sha256)) continue;
        const r = relevance(e, task, this.cfg.skills?.minOverlap ?? 1);
        if (r.ok) cands.push({ peer, entry: e, score: r.score });
      }
    }
    cands.sort((x, y) => y.score - x.score || (y.entry.uses || 0) - (x.entry.uses || 0));
    for (const c of cands.slice(0, this.cfg.skills?.seekMax ?? 2)) {
      const imp = await this.mesh.requestSkill(c.peer.id, c.entry.name).catch((e) => ({ imported: false, reason: errorMessage(e) }));
      const verdict = imp.imported ? await this.crystallizer.trialNow(task, final, { agentId, missionId }) : null;
      this.ledger.append('skill.seek', { peer: c.peer.id, name: c.entry.name, score: c.score, imported: imp.imported, reason: truncate(imp.reason || '', 200), trial: verdict ? { agree: verdict.agree, status: verdict.status } : null }, 'agency');
      this.bus.publish('skill.seek', { peer: c.peer.name, name: c.entry.name, imported: imp.imported });
      if (imp.imported) return { peer: c.peer.name, name: c.entry.name, imported: imp, trial: verdict };
    }
    return null;
  }

  /**
   * One independent answer from Gemini through Firebase AI Logic (the browser edge worker), for the judge. Only judged
   * work reaches it, and judging never happens for private or sealed tasks. The reply counts only if it really came
   * from the edge: the router's local fallback would silently be a different (local) voice, so it is discarded.
   */
  async geminiAnswer(task) {
    // Guard before the cloud (Phase 17, from the Chandra analysis): judged work is never private, but its text may still
    // hold a value the membrane would withhold (a key, an email, an owner term). Then Gemini is not asked at all.
    const found = detect(task, { terms: this.membrane.terms() });
    if (found.length) {
      this.ledger.append('judge.cloud_refused', { reason: 'sensitive values in the task', types: [...new Set(found.map((x) => x.type))] }, 'agency');
      return null;
    }
    const day = new Date().toISOString().slice(0, 10), key = `judge:cloud:${day}`, used = this.store.kvGet(key, 0);
    if (used >= (this.cfg.skills?.cloudJudgeDailyMax ?? 200)) return null;
    this.store.kvSet(key, used + 1);
    const res = await this.router.chat({
      model: 'edge:prefer_in_cloud', role: 'reason', privacy: 'normal', origin: 'judge', temperature: 0.1, maxTokens: 600,
      messages: [
        { role: 'system', content: 'You are an independent checker. Solve the task yourself, step by step and briefly. Do not round intermediate values. End with one line: FINAL: <number>' },
        { role: 'user', content: String(task).slice(0, 3000) },
      ],
    });
    if (!String(res.provider || '').startsWith('edge/')) return null;
    const fin = String(res.text).match(/FINAL:\s*\$?\s*(-?[\d,]*\.?\d+)/i);
    this.bus.publish('skill.judge_voice', { voice: 'gemini', inferenceSource: res.inferenceSource || null });
    return fin ? `FINAL ${fin[1]}` : res.text;
  }

  async status() {
    const counts = Object.fromEntries(['agents', 'missions', 'memories', 'ledger', 'workflows', 'dreams', 'peers'].map((t) => [t, this.store.get(`SELECT COUNT(*) AS n FROM ${t}`).n]));
    return {
      name: this.cfg.name, version: '1.0.0', identity: this.keyring.get('agency').toPublic(), counts,
      activeMissions: [...this.missions.active.keys()], pendingApprovals: this.approvals.list('pending', 50).length,
      autonomy: { enabled: this.store.kvGet('autonomy:enabled', this.cfg.autonomy.enabled), goals: this.goals().length },
      edge: this.edge.snapshot(), memory: this.memory.stats(), uptimeSec: Math.round(process.uptime()),
    };
  }

  async shutdown() {
    for (const t of this.timers) clearInterval(t);
    this.missions.shuttingDown = true;
    for (const [, ctrl] of this.missions.active) ctrl.abort(new Error('shutdown'));
    await new Promise((r) => setTimeout(r, 50));
    for (const c of this.mcpClients) c.close();
    this.ledger.append('agency.shutdown', { pid: process.pid }, 'agency');
    this.store.close();
  }
}
