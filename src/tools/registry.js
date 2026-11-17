// Tool registry with JSON-schema-lite validation, risk classes, writ enforcement, evidence seals,
// bounded results (long output is spilled to disk with its hash), timeouts, and tracing.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, errorMessage, withTimeout } from '../core/util.js';
import { wrapUntrusted } from '../guard/sentinel.js';

const MAX_INLINE = 6000;

/** Validate args against a small JSON-schema subset: type, properties, required, enum, min/max, maxLength, items. */
export function validateArgs(schema, value, at = 'args') {
  if (!schema) return [];
  const errs = [];
  const t = schema.type;
  const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  if (t) {
    const actual = typeOf(value);
    const matches = (ty) => (ty === 'integer' ? Number.isInteger(value) : ty === 'number' ? typeof value === 'number' && Number.isFinite(value) : actual === ty);
    const ok = Array.isArray(t) ? t.some(matches) : matches(t);
    if (!ok) return [`${at} must be ${Array.isArray(t) ? t.join('|') : t} (got ${actual})`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.maxLength && value.length > schema.maxLength) errs.push(`${at} longer than ${schema.maxLength}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at} > ${schema.maximum}`);
  }
  if (t === 'object' && value) {
    for (const req of schema.required || []) if (value[req] === undefined) errs.push(`${at}.${req} is required`);
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value[k] !== undefined) errs.push(...validateArgs(sub, value[k], `${at}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in (schema.properties || {}))) errs.push(`${at}.${k} is not allowed`);
    }
  }
  if (t === 'array' && Array.isArray(value)) {
    if (schema.maxItems && value.length > schema.maxItems) errs.push(`${at} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateArgs(schema.items, v, `${at}[${i}]`)));
  }
  return errs;
}

export class ToolRegistry {
  constructor({ cfg, approvals, ledger, tracer, bus }) {
    this.cfg = cfg;
    this.approvals = approvals;
    this.ledger = ledger;
    this.tracer = tracer;
    this.bus = bus;
    this.tools = new Map();
    this.spillDir = path.join(cfg.home, 'spill');
    fs.mkdirSync(this.spillDir, { recursive: true });
  }

  /**
   * def: { name, description, params (schema), risk: 'safe'|'approval', untrusted?: bool, timeoutMs?, run(args, ctx) }
   * untrusted=true wraps output in an <untrusted> quarantine block (web, files, peers).
   */
  register(def) {
    if (!/^[a-z][a-z0-9_.]{1,48}$/.test(def.name)) throw new Error(`invalid tool name ${def.name}`);
    if (typeof def.run !== 'function') throw new Error(`tool ${def.name} has no run()`);
    const risk = this.cfg.security.approvalTools.includes(def.name) ? 'approval' : (def.risk || 'safe');
    this.tools.set(def.name, { ...def, risk, params: def.params || { type: 'object', properties: {} } });
    return this;
  }

  has(name) { return this.tools.has(name); }
  get(name) { return this.tools.get(name); }

  /** Tools visible to an agent: its allowlist ('*' = all). */
  forAgent(allow) {
    const all = [...this.tools.values()];
    if (!allow || allow.includes('*')) return all;
    return all.filter((t) => allow.includes(t.name));
  }

  describe(list) {
    return list.map((t) => {
      const props = Object.entries(t.params.properties || {}).map(([k, v]) => `${k}${(t.params.required || []).includes(k) ? '' : '?'}: ${v.type}${v.enum ? `(${v.enum.join('|')})` : ''}`);
      return `- ${t.name}(${props.join(', ')})${t.risk === 'approval' ? ' [needs human approval]' : ''}: ${t.description}`;
    }).join('\n');
  }

  catalog() {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, risk: t.risk, params: t.params, untrusted: Boolean(t.untrusted) }));
  }

  #bound(text) {
    const s = String(text ?? '');
    if (s.length <= MAX_INLINE) return { text: s, spilled: null };
    const hash = sha256(s);
    const file = path.join(this.spillDir, `${hash.slice(0, 24)}.txt`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, s);
    const head = s.slice(0, MAX_INLINE * 0.7), tail = s.slice(-MAX_INLINE * 0.25);
    return { text: `${head}\n…[${s.length - head.length - tail.length} chars spilled to spill/${path.basename(file)} sha256=${hash.slice(0, 16)}]…\n${tail}`, spilled: file };
  }

  /**
   * Execute a tool call. Returns a sealed result:
   *   { ok, tool, output (string for the model), data (raw), evidence: {sha256, bytes, executed, ms}, approvalId?, error? }
   * Approval-class tools without a valid writ return { ok:false, pending:true, approvalId }.
   */
  async call(name, args = {}, ctx = {}) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, tool: name, output: `Unknown tool "${name}". Available: ${[...this.tools.keys()].join(', ')}`, evidence: { executed: false } };
    if (ctx.allow && !ctx.allow.includes('*') && !ctx.allow.includes(name)) {
      return { ok: false, tool: name, output: `Tool "${name}" is not in this agent's allowlist.`, evidence: { executed: false } };
    }
    const errs = validateArgs(tool.params, args ?? {});
    if (errs.length) return { ok: false, tool: name, output: `Invalid arguments: ${errs.join('; ')}`, evidence: { executed: false } };

    // Egress guard: model calls are not the only way private text leaves the machine. Network tools are too.
    if (tool.egress && ctx.privacy === 'private') {
      this.ledger.append('membrane.egress_blocked', { tool: name, agentId: ctx.agentId, missionId: ctx.missionId, mode: 'private' }, ctx.agentId || 'agency');
      return { ok: false, tool: name, output: `Tool "${name}" sends data off this machine and is disabled for private work. Answer from local knowledge and memory instead.`, evidence: { executed: false } };
    }
    if (tool.egress && ctx.privacy === 'sealed' && this.membrane) {
      const spans = await this.membrane.spans(JSON.stringify(args ?? {}), { useNer: false });
      if (spans.length) {
        const types = [...new Set(spans.map((s) => s.type))];
        this.ledger.append('membrane.egress_blocked', { tool: name, agentId: ctx.agentId, missionId: ctx.missionId, mode: 'sealed', withheld: types, tags: spans.map((s) => this.membrane.tag(s.value)) }, ctx.agentId || 'agency');
        return { ok: false, tool: name, output: `Tool "${name}" was blocked: its arguments contain ${spans.length} sensitive value(s) (${types.join(', ')}) that must not leave this machine. Rephrase the request without them.`, evidence: { executed: false } };
      }
    }

    if (tool.risk === 'approval') {
      const check = ctx.writ ? this.approvals.consume(ctx.writ, name, args) : { ok: false, reason: 'no writ' };
      if (!check.ok) {
        if (ctx.writ) return { ok: false, tool: name, output: `Writ rejected: ${check.reason}`, evidence: { executed: false } };
        const approvalId = this.approvals.request({ missionId: ctx.missionId, taskId: ctx.taskId, agentId: ctx.agentId, tool: name, args, reason: ctx.reason || '' });
        return { ok: false, pending: true, approvalId, tool: name, output: `Tool "${name}" requires human approval. Approval ${approvalId} is pending.`, evidence: { executed: false } };
      }
    }

    const span = ctx.span?.child(`tool ${name}`, { kind: 'tool', attrs: { tool: name } });
    const t0 = Date.now();
    try {
      const raw = await withTimeout(Promise.resolve(tool.run(args ?? {}, ctx)), tool.timeoutMs || this.cfg.limits.toolTimeoutMs, `tool ${name}`);
      const asText = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      const evidence = { sha256: sha256(asText), bytes: Buffer.byteLength(asText), executed: true, ms: Date.now() - t0 };
      const bounded = this.#bound(asText);
      let output = bounded.text;
      let scan = null;
      if (tool.untrusted) ({ text: output, scan } = wrapUntrusted(`${name}`, bounded.text, evidence));
      span?.end('ok', { ms: evidence.ms, bytes: evidence.bytes, injection: scan?.flags });
      this.ledger.append('tool.call', { tool: name, agentId: ctx.agentId, missionId: ctx.missionId, ok: true, evidence: evidence.sha256 }, ctx.agentId || 'agency');
      this.bus?.publish('tool.result', { tool: name, agentId: ctx.agentId, ok: true, ms: evidence.ms, missionId: ctx.missionId });
      return { ok: true, tool: name, output, data: raw, evidence, spilled: bounded.spilled, injection: scan };
    } catch (e) {
      const msg = errorMessage(e);
      span?.end('error', { error: msg });
      this.ledger.append('tool.call', { tool: name, agentId: ctx.agentId, missionId: ctx.missionId, ok: false, error: msg.slice(0, 300) }, ctx.agentId || 'agency');
      this.bus?.publish('tool.result', { tool: name, agentId: ctx.agentId, ok: false, error: msg, missionId: ctx.missionId });
      return { ok: false, tool: name, output: `Tool error: ${msg}`, error: msg, evidence: { executed: true, ms: Date.now() - t0 } };
    }
  }
}
