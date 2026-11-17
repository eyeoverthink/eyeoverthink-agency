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
import { Membrane } from './guard/membrane.js';
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
          role: 'fast', privacy: 'private', json: true, temperature: 0, maxTokens: 400,
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
    this.mesh = new Mesh({ cfg: this.cfg, store: this.store, keyring: this.keyring, ledger: this.ledger, bus: this.bus, memory: this.memory, runtime: this.runtime, agents: this.agents });
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
