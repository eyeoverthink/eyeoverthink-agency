// Model Context Protocol, both directions.
//   McpServer: exposes the agency to MCP clients (Claude Code, IDEs) over stdio JSON-RPC 2.0.
//   McpClient: connects to external stdio MCP servers and registers their tools (approval-gated unless listed safe).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { truncate, errorMessage } from '../core/util.js';

const PROTOCOL = '2025-06-18';

export class McpServer {
  constructor(agency, { input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`[mcp] ${m}\n`) } = {}) {
    this.agency = agency;
    this.input = input;
    this.output = output;
    this.log = log;
    this.tools = [
      { name: 'agency_mission', description: 'Run a full multi-agent mission (plan, execute, verify, synthesize) and return the deliverable.', inputSchema: { type: 'object', required: ['goal'], properties: { goal: { type: 'string' }, mode: { type: 'string', enum: ['standard', 'logic_chain', 'consensus'] }, privacy: { type: 'string', enum: ['normal', 'private'] }, timeoutSec: { type: 'number' } } } },
      { name: 'agency_ask', description: 'Ask one specialist agent to do a task.', inputSchema: { type: 'object', required: ['agent', 'task'], properties: { agent: { type: 'string' }, task: { type: 'string' } } } },
      { name: 'agency_agents', description: 'List the agency\'s agents with roles, tools and fitness.', inputSchema: { type: 'object', properties: {} } },
      { name: 'memory_search', description: 'Search the agency\'s long-term memory.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, k: { type: 'number' } } } },
      { name: 'memory_save', description: 'Save a fact to the agency\'s long-term memory.', inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
      { name: 'ledger_verify', description: 'Verify the signed hash-chained ledger and return the Merkle root.', inputSchema: { type: 'object', properties: {} } },
      { name: 'workflow_run', description: 'Run a saved workflow by id with a JSON input.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, input: { type: 'object' } } } },
    ];
  }

  #send(msg) { this.output.write(JSON.stringify(msg) + '\n'); }

  async #call(name, args) {
    const a = this.agency;
    switch (name) {
      case 'agency_mission': {
        const m = a.missions.create(args.goal, { mode: args.mode, privacy: args.privacy });
        const done = await a.missions.waitFor(m.id, Math.min(3600, args.timeoutSec || 1800) * 1000);
        return done.status === 'completed' ? `${done.result.deliverable}\n\n(mission ${done.id}, score ${done.score})` : `Mission ${done.id} ${done.status}: ${done.error || ''}`;
      }
      case 'agency_ask': { const r = await a.runtime.run(args.agent, args.task); return r.final; }
      case 'agency_agents': return JSON.stringify(a.agents.list().map((x) => ({ id: x.id, name: x.name, role: x.role, tools: x.tools, fitness: x.fitness })), null, 2);
      case 'memory_search': return JSON.stringify(await a.memory.recall(args.query, { k: args.k || 6 }), null, 2);
      case 'memory_save': return JSON.stringify(await a.memory.write({ content: args.content, kind: 'fact', tags: args.tags || ['mcp'], source: 'mcp' }));
      case 'ledger_verify': return JSON.stringify(a.ledger.verify());
      case 'workflow_run': return JSON.stringify(await a.workflows.run(args.id, args.input || {}), null, 2);
      default: throw new Error(`unknown tool ${name}`);
    }
  }

  async handle(msg) {
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') return this.#send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'eyeoverthink-agency', version: '1.0.0' } } });
      if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return undefined;
      if (method === 'ping') return this.#send({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return this.#send({ jsonrpc: '2.0', id, result: { tools: this.tools } });
      if (method === 'tools/call') {
        try {
          const text = await this.#call(params?.name, params?.arguments || {});
          return this.#send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
        } catch (e) {
          return this.#send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${errorMessage(e)}` }], isError: true } });
        }
      }
      if (id !== undefined) this.#send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) {
      if (id !== undefined) this.#send({ jsonrpc: '2.0', id, error: { code: -32603, message: errorMessage(e) } });
    }
  }

  start() {
    const rl = readline.createInterface({ input: this.input });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return this.#send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      this.handle(msg);
    });
    this.log('agency MCP server ready on stdio');
    return rl;
  }
}

export class McpClient {
  constructor({ name, command, args = [], env = {}, safeTools = [] }) {
    Object.assign(this, { name, command, args, env, safeTools });
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
  }

  async connect(timeoutMs = 15000) {
    this.proc = spawn(this.command, this.args, { env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    });
    this.proc.on('exit', () => { for (const p of this.pending.values()) p.reject(new Error(`MCP server ${this.name} exited`)); this.pending.clear(); });
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'eyeoverthink-agency', version: '1.0.0' } }, timeoutMs);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return this;
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${this.name} ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async listTools() { return (await this.request('tools/list', {})).tools || []; }

  async callTool(name, args) {
    const r = await this.request('tools/call', { name, arguments: args });
    const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    if (r.isError) throw new Error(truncate(text, 500));
    return text;
  }

  /** Register remote tools into the agency registry as mcp.<server>.<tool>. */
  async registerInto(registry) {
    const tools = await this.listTools();
    const names = [];
    for (const t of tools) {
      const local = `mcp.${this.name}.${t.name}`.toLowerCase().replace(/[^a-z0-9_.]/g, '_').slice(0, 49);
      registry.register({
        name: local, description: `[MCP ${this.name}] ${t.description || t.name}`, untrusted: true,
        risk: this.safeTools.includes(t.name) ? 'safe' : 'approval',
        params: t.inputSchema && t.inputSchema.type === 'object' ? { type: 'object', properties: t.inputSchema.properties || {}, required: t.inputSchema.required || [] } : { type: 'object', properties: {} },
        run: (args) => this.callTool(t.name, args),
      });
      names.push(local);
    }
    return names;
  }

  close() { try { this.proc?.kill(); } catch { /* gone */ } }
}
