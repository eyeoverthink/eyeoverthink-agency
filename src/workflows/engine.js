// Workflow DAG engine. Definition: { nodes: [{id, type, data}], edges: [{from, to, when?}] }
// Ready nodes run in parallel; condition nodes activate edges whose `when` matches their boolean output;
// a node whose incoming edges are all inactive is skipped (branch pruning). Deployable as an API.
import crypto from 'node:crypto';
import { newId, nowIso, sha256, extractJson, truncate, errorMessage } from '../core/util.js';

export const NODE_TYPES = {
  input: 'Workflow input (optionally a field of it)',
  llm: 'Prompt a model role ({{templates}}), optional json and privacy',
  agent: 'Run an agent on a templated task',
  tool: 'Call a tool with templated args',
  memory_recall: 'Hybrid memory search',
  memory_write: 'Write a memory',
  condition: 'Boolean test on a value (contains|equals|regex|truthy|gt|lt)',
  transform: 'Template string, or JSON pick of a path',
  merge: 'Concatenate all upstream outputs',
  mission: 'Run a full mission and wait for the deliverable',
  human_gate: 'Pause until a human approves in the dashboard',
  output: 'Mark the workflow result',
};

function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const p of String(path).split('.')) {
    if (cur == null) return undefined;
    if (typeof cur === 'string') { const j = extractJson(cur); cur = j && typeof j === 'object' ? j : undefined; if (cur == null) return undefined; }
    cur = cur[p];
  }
  return cur;
}

export function renderTemplate(tpl, scope) {
  return String(tpl ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const [head, ...rest] = key.split('.');
    const base = head === 'input' ? scope.input : scope.nodes[head];
    const v = getPath(base, rest.join('.'));
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function renderDeep(value, scope) {
  if (typeof value === 'string') return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, scope)]));
  return value;
}

export function validateWorkflow(def) {
  const errs = [];
  if (!def || !Array.isArray(def.nodes) || def.nodes.length === 0) return ['workflow needs nodes[]'];
  const ids = new Set();
  for (const n of def.nodes) {
    if (!n.id || !/^[\w-]{1,40}$/.test(n.id)) errs.push(`bad node id ${n.id}`);
    if (ids.has(n.id)) errs.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (!NODE_TYPES[n.type]) errs.push(`node ${n.id}: unknown type ${n.type}`);
  }
  for (const e of def.edges || []) if (!ids.has(e.from) || !ids.has(e.to)) errs.push(`edge ${e.from}->${e.to} references unknown node`);
  // cycle check
  const indeg = new Map([...ids].map((i) => [i, 0]));
  for (const e of def.edges || []) indeg.set(e.to, indeg.get(e.to) + 1);
  const q = [...indeg].filter(([, d]) => d === 0).map(([i]) => i);
  let seen = 0;
  while (q.length) { const id = q.shift(); seen++; for (const e of def.edges || []) if (e.from === id) { indeg.set(e.to, indeg.get(e.to) - 1); if (!indeg.get(e.to)) q.push(e.to); } }
  if (seen !== ids.size) errs.push('workflow graph has a cycle');
  return errs;
}

export class WorkflowEngine {
  constructor(deps) { Object.assign(this, deps); } // store, router, runtime, tools, memory, missions, approvals, ledger, bus, tracer

  save({ id = null, name, description = '', def }) {
    const errs = validateWorkflow(def);
    if (errs.length) throw new Error(`invalid workflow: ${errs.join('; ')}`);
    const wid = id || newId('wf');
    const existing = this.store.get('SELECT id, version FROM workflows WHERE id = ?', wid);
    if (existing) this.store.run('UPDATE workflows SET name = ?, description = ?, def = ?, version = version + 1, updated = ? WHERE id = ?', name, description, def, nowIso(), wid);
    else this.store.run('INSERT INTO workflows (id, name, description, def, created, updated) VALUES (?, ?, ?, ?, ?, ?)', wid, name, description, def, nowIso(), nowIso());
    this.ledger.append('workflow.save', { id: wid, defHash: sha256(JSON.stringify(def)) }, 'operator');
    return this.get(wid);
  }

  get(id) {
    const r = this.store.get('SELECT * FROM workflows WHERE id = ?', id);
    return r ? { id: r.id, name: r.name, description: r.description, def: JSON.parse(r.def), version: r.version, deployed: Boolean(r.api_key_hash), created: r.created, updated: r.updated } : null;
  }

  list() { return this.store.all('SELECT id, name, description, version, api_key_hash IS NOT NULL AS deployed, updated FROM workflows ORDER BY updated DESC LIMIT 200'); }
  remove(id) { this.store.run('DELETE FROM workflows WHERE id = ?', id); }

  /** Deploy as API: returns the raw key once; only its hash is stored. */
  deploy(id) {
    if (!this.get(id)) throw new Error('workflow not found');
    const key = `wfk_${crypto.randomBytes(24).toString('base64url')}`;
    this.store.run('UPDATE workflows SET api_key_hash = ? WHERE id = ?', sha256(key), id);
    this.ledger.append('workflow.deploy', { id }, 'operator');
    return { id, key, endpoint: `/hooks/${id}` };
  }
  undeploy(id) { this.store.run('UPDATE workflows SET api_key_hash = NULL WHERE id = ?', id); }
  checkKey(id, key) {
    const r = this.store.get('SELECT api_key_hash FROM workflows WHERE id = ?', id);
    if (!r?.api_key_hash || !key) return false;
    const a = Buffer.from(r.api_key_hash), b = Buffer.from(sha256(key));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  runs(workflowId, limit = 30) {
    return this.store.all(`SELECT id, status, created, finished, error FROM workflow_runs WHERE workflow_id = ? ORDER BY created DESC LIMIT ${Math.min(200, limit | 0)}`, workflowId);
  }
  getRun(id) {
    const r = this.store.get('SELECT * FROM workflow_runs WHERE id = ?', id);
    return r ? { ...r, input: JSON.parse(r.input || 'null'), output: JSON.parse(r.output || 'null'), node_states: JSON.parse(r.node_states || '{}') } : null;
  }

  async run(id, input = {}, { signal } = {}) {
    const wf = this.get(id);
    if (!wf) throw new Error('workflow not found');
    const runId = newId('wr');
    this.store.run('INSERT INTO workflow_runs (id, workflow_id, status, input, created) VALUES (?, ?, ?, ?, ?)', runId, id, 'running', input, nowIso());
    const span = this.tracer.start(`workflow ${wf.name}`, { kind: 'workflow', traceId: runId, attrs: { workflowId: id } });
    const { nodes, edges = [] } = wf.def;
    const state = Object.fromEntries(nodes.map((n) => [n.id, { status: 'pending' }]));
    const scope = { input, nodes: {} };
    const incoming = (nid) => edges.filter((e) => e.to === nid);
    const upstreamValues = (nid) => incoming(nid).filter((e) => state[e.from].status === 'done').map((e) => scope.nodes[e.from]).filter((v) => v !== undefined);
    const edgeActive = (e) => {
      const src = state[e.from];
      if (src.status !== 'done') return false;
      if (e.when === undefined || e.when === null) return true;
      return Boolean(scope.nodes[e.from]) === (e.when === true || e.when === 'true');
    };
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('aborted');
        let progressed = false;
        const ready = [];
        for (const n of nodes) {
          if (state[n.id].status !== 'pending') continue;
          const inc = incoming(n.id);
          if (inc.some((e) => ['pending', 'running'].includes(state[e.from].status))) continue;
          if (inc.length && !inc.some(edgeActive)) { state[n.id] = { status: 'skipped' }; progressed = true; continue; }
          ready.push(n);
        }
        if (!ready.length && !progressed) break;
        await Promise.all(ready.map(async (n) => {
          state[n.id] = { status: 'running', started: Date.now() };
          this.bus.publish('workflow.node', { runId, node: n.id, status: 'running' });
          try {
            const out = await this.#exec(n, scope, upstreamValues(n.id), { span, runId, signal });
            scope.nodes[n.id] = out;
            state[n.id] = { status: 'done', ms: Date.now() - state[n.id].started, preview: truncate(typeof out === 'string' ? out : JSON.stringify(out), 300) };
          } catch (e) {
            state[n.id] = { status: 'failed', error: errorMessage(e) };
            throw new Error(`node ${n.id} failed: ${errorMessage(e)}`);
          } finally {
            this.bus.publish('workflow.node', { runId, node: n.id, status: state[n.id].status });
          }
        }));
      }
      const outNode = nodes.find((n) => n.type === 'output' && state[n.id].status === 'done');
      const output = outNode ? scope.nodes[outNode.id] : scope.nodes[nodes.at(-1).id];
      this.store.run("UPDATE workflow_runs SET status = 'completed', output = ?, node_states = ?, finished = ? WHERE id = ?", { result: output ?? null }, state, nowIso(), runId);
      span.end('ok');
      this.ledger.append('workflow.run', { workflowId: id, runId, ok: true }, 'agency');
      return { runId, status: 'completed', output, nodes: state };
    } catch (e) {
      this.store.run("UPDATE workflow_runs SET status = 'failed', error = ?, node_states = ?, finished = ? WHERE id = ?", errorMessage(e), state, nowIso(), runId);
      span.end('error', { error: errorMessage(e) });
      this.ledger.append('workflow.run', { workflowId: id, runId, ok: false }, 'agency');
      return { runId, status: 'failed', error: errorMessage(e), nodes: state };
    }
  }

  async #exec(node, scope, upstream, { span, runId, signal }) {
    const d = node.data || {};
    const prev = upstream.length ? upstream.at(-1) : scope.input;
    const r = (t) => renderTemplate(t ?? '{{input}}', { ...scope, nodes: { ...scope.nodes, prev } });
    switch (node.type) {
      case 'input': return d.field ? getPath(scope.input, d.field) : scope.input;
      case 'llm': {
        const res = await this.router.chat({ role: d.role || 'reason', privacy: d.privacy || 'normal', json: Boolean(d.json), temperature: d.temperature ?? 0.4, maxTokens: d.maxTokens || 1200, signal, span: span.child(`node ${node.id}`, { kind: 'llm' }),
          messages: [...(d.system ? [{ role: 'system', content: r(d.system) }] : []), { role: 'user', content: r(d.prompt || '{{prev}}') }] });
        return d.json ? (extractJson(res.text) ?? res.text) : res.text.trim();
      }
      case 'agent': {
        const res = await this.runtime.run(d.agent, r(d.task || '{{prev}}'), { span, signal, privacy: d.privacy });
        return res.final;
      }
      case 'tool': {
        const res = await this.tools.call(d.tool, renderDeep(d.args || {}, { ...scope, nodes: { ...scope.nodes, prev } }), { agentId: 'workflow', span });
        if (res.pending) {
          const decision = await this.approvals.wait(res.approvalId, d.approvalTimeoutMs || 0);
          if (decision.status !== 'approved') throw new Error(`approval ${decision.status}`);
          const again = await this.tools.call(d.tool, renderDeep(d.args || {}, { ...scope, nodes: { ...scope.nodes, prev } }), { agentId: 'workflow', span, writ: decision.writ });
          if (!again.ok) throw new Error(again.output);
          return again.data ?? again.output;
        }
        if (!res.ok) throw new Error(res.output);
        return res.data ?? res.output;
      }
      case 'memory_recall': return (await this.memory.recall(r(d.query || '{{prev}}'), { k: d.k || 5 })).map((m) => ({ id: m.id, kind: m.kind, content: m.content, score: m.score }));
      case 'memory_write': return this.memory.write({ content: r(d.content || '{{prev}}'), kind: d.kind || 'fact', tags: d.tags || ['workflow'], source: `workflow:${runId}` });
      case 'condition': {
        const v = d.path ? getPath(prev, d.path) : prev;
        const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
        switch (d.op || 'truthy') {
          case 'contains': return s.toLowerCase().includes(String(r(d.value)).toLowerCase());
          case 'equals': return s.trim() === String(r(d.value)).trim();
          case 'regex': return new RegExp(d.value, 'i').test(s);
          case 'gt': return Number(v) > Number(d.value);
          case 'lt': return Number(v) < Number(d.value);
          default: return Boolean(v) && s !== 'false' && s !== '""';
        }
      }
      case 'transform': return d.pick ? getPath(prev, d.pick) : r(d.template || '{{prev}}');
      case 'merge': return upstream.map((u) => (typeof u === 'string' ? u : JSON.stringify(u, null, 2))).join(d.separator ?? '\n\n---\n\n');
      case 'mission': {
        const m = this.missions.create(r(d.goal || '{{prev}}'), { mode: d.mode, privacy: d.privacy });
        const done = await this.missions.waitFor(m.id, d.timeoutMs || 1800000);
        if (done.status !== 'completed') throw new Error(`mission ${done.status}: ${done.error || ''}`);
        return done.result.deliverable;
      }
      case 'human_gate': {
        const id = this.approvals.request({ tool: 'workflow_gate', args: { runId, node: node.id, message: r(d.message || 'Continue the workflow?'), preview: truncate(typeof prev === 'string' ? prev : JSON.stringify(prev), 1500) }, reason: 'workflow human gate' });
        const decision = await this.approvals.wait(id, d.timeoutMs || 0);
        if (decision.status !== 'approved') throw new Error(`human gate ${decision.status}`);
        return prev;
      }
      case 'output': return d.template ? r(d.template) : prev;
      default: throw new Error(`unknown node type ${node.type}`);
    }
  }
}

/** Pre-built workflows seeded on first run. */
export const SEED_WORKFLOWS = [
  {
    id: 'wf_research_brief', name: 'Research brief', description: 'Scout researches a topic, Lumen writes a brief, Solon reviews it.',
    def: {
      nodes: [
        { id: 'topic', type: 'input', data: { field: 'topic' } },
        { id: 'research', type: 'agent', data: { agent: 'spearhead', task: 'Research this topic and report the key facts with source URLs: {{topic}}' } },
        { id: 'brief', type: 'agent', data: { agent: 'lumen', task: 'Write a one-page brief on "{{topic}}" from these findings. Keep the sources.\n\n{{research}}' } },
        { id: 'review', type: 'llm', data: { role: 'critic', json: true, prompt: 'Review this brief for accuracy and completeness. Return {"score":0..1,"issues":[...]}.\n\n{{brief}}' } },
        { id: 'out', type: 'output', data: { template: '{{brief}}\n\n---\nReview score: {{review.score}}' } },
      ],
      edges: [{ from: 'topic', to: 'research' }, { from: 'research', to: 'brief' }, { from: 'brief', to: 'review' }, { from: 'review', to: 'out' }],
    },
  },
  {
    id: 'wf_verified_code', name: 'Verified code', description: 'ForgeKeeper writes code and proves it in the sandbox; Solon checks it.',
    def: {
      nodes: [
        { id: 'spec', type: 'input', data: { field: 'spec' } },
        { id: 'build', type: 'agent', data: { agent: 'forge_keeper', task: 'Write a self-contained JavaScript solution with tests (console.log the results) and run it with code_run until it passes. Spec: {{spec}}' } },
        { id: 'check', type: 'agent', data: { agent: 'solon', task: 'Verify this solution meets the spec "{{spec}}". Re-run the code with code_run if needed.\n\n{{build}}' } },
        { id: 'out', type: 'merge', data: {} },
      ],
      edges: [{ from: 'spec', to: 'build' }, { from: 'build', to: 'check' }, { from: 'build', to: 'out' }, { from: 'check', to: 'out' }],
    },
  },
  {
    id: 'wf_triage', name: 'Triage router', description: 'Classifies a request and routes it to the analyst or the scribe.',
    def: {
      nodes: [
        { id: 'req', type: 'input', data: { field: 'request' } },
        { id: 'classify', type: 'llm', data: { role: 'fast', json: true, prompt: 'Classify the request. Return {"quantitative": true|false}.\nRequest: {{req}}' } },
        { id: 'isQuant', type: 'condition', data: { path: 'quantitative', op: 'truthy' } },
        { id: 'analyst', type: 'agent', data: { agent: 'tycho', task: '{{req}}' } },
        { id: 'scribe', type: 'agent', data: { agent: 'lumen', task: '{{req}}' } },
        { id: 'out', type: 'merge', data: {} },
      ],
      edges: [{ from: 'req', to: 'classify' }, { from: 'classify', to: 'isQuant' }, { from: 'isQuant', to: 'analyst', when: true }, { from: 'isQuant', to: 'scribe', when: false }, { from: 'analyst', to: 'out' }, { from: 'scribe', to: 'out' }],
    },
  },
  {
    id: 'wf_private_draft', name: 'Private draft (on-device)', description: 'Drafts sensitive text with privacy=private: local GPU or the browser on-device model only, never cloud.',
    def: {
      nodes: [
        { id: 'notes', type: 'input', data: { field: 'notes' } },
        { id: 'draft', type: 'llm', data: { role: 'fast', privacy: 'private', prompt: 'Turn these private notes into a clear, polite draft message:\n{{notes}}' } },
        { id: 'gate', type: 'human_gate', data: { message: 'Approve this private draft?' } },
        { id: 'out', type: 'output', data: {} },
      ],
      edges: [{ from: 'notes', to: 'draft' }, { from: 'draft', to: 'gate' }, { from: 'gate', to: 'out' }],
    },
  },
  {
    id: 'wf_memory_digest', name: 'Memory digest', description: 'Recalls memories on a subject, condenses them, and stores the digest as semantic memory.',
    def: {
      nodes: [
        { id: 'subject', type: 'input', data: { field: 'subject' } },
        { id: 'recall', type: 'memory_recall', data: { query: '{{subject}}', k: 10 } },
        { id: 'digest', type: 'llm', data: { role: 'continuity', prompt: 'Condense these memories about "{{subject}}" into 3-6 durable facts. Memories:\n{{recall}}' } },
        { id: 'store', type: 'memory_write', data: { kind: 'semantic', content: 'Digest on {{subject}}: {{digest}}', tags: ['digest'] } },
        { id: 'out', type: 'output', data: { template: '{{digest}}' } },
      ],
      edges: [{ from: 'subject', to: 'recall' }, { from: 'recall', to: 'digest' }, { from: 'digest', to: 'store' }, { from: 'store', to: 'out' }],
    },
  },
];
