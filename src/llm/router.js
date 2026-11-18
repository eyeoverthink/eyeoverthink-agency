// Model router: role-based model selection across providers, per-model circuit breakers,
// automatic fallback, a GPU concurrency gate, confidence-triage escalation, and embeddings.
import { OllamaProvider, OpenAICompatProvider, GeminiProvider } from './providers.js';
import { EdgeProvider } from './edge.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Semaphore, hashEmbed, errorMessage } from '../core/util.js';

/** Closed -> (failures >= threshold) -> open -> (cooldown) -> half-open -> success closes / failure re-opens. */
export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 60000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = 0;
    this.lastError = null;
  }
  canPass() {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) this.state = 'half-open';
    return this.state !== 'open';
  }
  success() { this.failures = 0; this.state = 'closed'; this.lastError = null; }
  failure(err) {
    this.failures++;
    this.lastError = errorMessage(err);
    if (this.state === 'half-open' || this.failures >= this.threshold) { this.state = 'open'; this.openedAt = Date.now(); }
  }
  toJSON() { return { state: this.state, failures: this.failures, lastError: this.lastError }; }
}

const HIGH_STAKES = /\b(identity|memory|repair|protocol|chain|continuity|security|delete|payment|legal|medical|private key|credential)\b/i;

export class ModelRouter {
  constructor(cfg, { edgeHub = null, tracer = null, bus = null } = {}) {
    this.cfg = cfg;
    this.tracer = tracer;
    this.bus = bus;
    this.ollama = new OllamaProvider(cfg.ollama);
    this.openai = new OpenAICompatProvider(cfg.openaiCompat);
    this.gemini = new GeminiProvider(cfg.gemini);
    this.edge = edgeHub ? new EdgeProvider(edgeHub) : null;
    this.providers = [this.ollama, this.openai, this.gemini, this.edge].filter(Boolean);
    this.breakers = new Map();
    this.gpu = new Semaphore(cfg.limits.localConcurrency);
    this.usage = { calls: 0, promptTokens: 0, completionTokens: 0, byModel: {} };
    this.meters = new AsyncLocalStorage();
    this.extra = []; // test or plugin providers
  }

  /** Register an additional provider (plugins, tests). It takes precedence over built-ins. */
  addProvider(provider) { this.extra.unshift(provider); this.providers.unshift(provider); }

  breaker(key) {
    let b = this.breakers.get(key);
    if (!b) { b = new CircuitBreaker(); this.breakers.set(key, b); }
    return b;
  }

  async refresh() {
    await Promise.all(this.providers.map((p) => p.refresh?.(true)));
  }

  /** Resolve the ordered candidate list for a role (or explicit model) given privacy constraints. */
  async candidates({ role = 'reason', model = null, privacy = 'normal', seed } = {}) {
    await Promise.all(this.providers.map((p) => p.refresh?.()));
    const wanted = model ? [model, ...(this.cfg.models[role] || [])] : [...(this.cfg.models[role] || [])];
    const out = [];
    const seen = new Set();
    const push = (provider, m, extra = {}) => {
      const key = `${provider.name}:${m}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (this.breaker(key).canPass()) out.push({ provider, model: m, key, ...extra });
    };
    // Private content: only local GPU or the browser's on-device model.
    const allowCloud = privacy !== 'private';
    // GPU overflow: the local GPU runs one generation at a time. While it is busy and a dashboard tab is serving as a
    // Firebase AI Logic edge worker, this call goes to the edge instead of waiting in the GPU queue. Seeded calls
    // (benchmarks, evolution) and explicit model requests stay local, so paired comparisons keep one model.
    if (this.#overflowToEdge({ role, model, privacy, seed })) push(this.edge, privacy === 'private' ? 'edge:only_on_device' : 'edge:prefer_on_device', { overflow: true });
    // An explicitly requested edge model comes first, before plugin providers: measured in Phase 17, a plugin model was
    // ordered ahead of 'edge:prefer_in_cloud', so a call meant for Gemini (an independent judge voice) ran locally.
    if (model && String(model).startsWith('edge:') && this.edge?.has(model)) push(this.edge, privacy === 'private' ? 'edge:only_on_device' : model);
    // Plugin providers that send data off the machine (remote: true) are never candidates for private work.
    for (const p of this.extra) for (const m of wanted) if (p.has(m) && (allowCloud || p.remote !== true)) push(p, m);
    for (const m of wanted) {
      if (String(m).startsWith('edge:') && this.edge?.has(m)) push(this.edge, privacy === 'private' ? 'edge:only_on_device' : m);
      else if (this.ollama.has(m) && (allowCloud || !String(m).endsWith('-cloud'))) push(this.ollama, m);
      else if (this.openai.has(m) && allowCloud) push(this.openai, m);
    }
    // Role list exhausted: any installed local chat model, then edge, then cloud fallbacks.
    if (out.length === 0) {
      for (const m of this.ollama.models.map((x) => x.name)) {
        if (/embed/.test(m) || (!allowCloud && m.endsWith('-cloud'))) continue;
        push(this.ollama, m);
        if (out.length >= 2) break;
      }
    }
    if (this.edge?.hub.available) push(this.edge, privacy === 'private' ? 'edge:only_on_device' : 'edge:prefer_on_device');
    if (allowCloud) {
      for (const m of (this.openai.models || []).slice(0, 1)) push(this.openai, m);
      if (this.gemini.enabled) push(this.gemini, this.gemini.model);
    }
    return out;
  }

  /** Does this candidate send data off the machine? (Cloud APIs, cloud-hosted Ollama models, browser edge workers.) */
  isRemote(c) {
    return c.provider.remote === true || c.provider === this.openai || c.provider === this.gemini || c.provider === this.edge
      || (c.provider === this.ollama && String(c.model).endsWith('-cloud'));
  }

  #overflowToEdge({ role, model, privacy, seed }) {
    const ov = this.cfg.edge?.overflow;
    if (!ov?.enabled || model || Number.isInteger(seed) || !this.edge?.hub.available) return false;
    if (!(ov.roles || []).includes(role)) return false;
    if (this.gpu.active < this.gpu.max) return false;
    // Private work may only run ON_DEVICE: overflow it only to a worker that can run Gemini Nano.
    if (privacy === 'private') return this.edge.hub.liveWorkers().some((w) => w.onDevice === 'available');
    return true;
  }

  /**
   * Chat with automatic fallback. Throws only if every candidate fails.
   * req: { role, model, privacy, messages, json, temperature, maxTokens, signal, span, onToken }
   */
  async chat(req) {
    const cands = await this.candidates(req);
    if (cands.length === 0) {
      const diag = this.ollama.diagnose();
      throw new Error(`No model available for role "${req.role || 'reason'}". ${diag.notes.join(' ') || 'Install an Ollama model or configure a provider.'}`);
    }
    const errors = [];
    let sealed = null; // privacy 'sealed': computed once, reused by every remote candidate
    for (const c of cands) {
      const span = req.span?.child(`llm ${c.model}`, { kind: 'llm', attrs: { provider: c.provider.name, model: c.model, role: req.role } });
      const crossing = req.privacy === 'sealed' && this.isRemote(c);
      try {
        let creq = { ...req, model: c.model };
        if (crossing) {
          // Privacy Membrane: only the sealed text may leave the machine; a failed leak audit throws here.
          if (!this.membrane) throw new Error('privacy "sealed" needs the membrane, which is not configured');
          sealed ??= await this.membrane.sealMessages(req.messages);
          creq = { ...creq, messages: sealed.messages, onToken: undefined }; // no sealed tokens streamed to the UI
        }
        const run = () => c.provider.chat(creq);
        let res = c.provider === this.ollama && !c.model.endsWith('-cloud') ? await this.gpu.run(run) : await run();
        if (!res.text || !res.text.trim()) throw new Error('empty completion');
        if (crossing) {
          res = { ...res, text: sealed.session.unseal(res.text, { json: req.json }), sealed: { withheld: { ...sealed.session.counts }, total: sealed.session.size } };
          this.membrane.record({ session: sealed.session, payload: sealed.payload, provider: c.provider.name, model: c.model, origin: req.role || 'reason', missionId: req.missionId });
        }
        this.breaker(c.key).success();
        this.#account(res);
        const meter = this.meters.getStore();
        if (meter) { meter.calls++; meter.tokens += (res.usage?.prompt || 0) + (res.usage?.completion || 0); if (c.overflow) meter.overflow++; if (this.isRemote(c)) meter.remote++; }
        // Live boundary telemetry (ephemeral): where did this call run, and did it leave the machine?
        this.bus?.publish('router.call', { provider: c.provider.name, model: c.model, role: req.role || 'reason', remote: this.isRemote(c), sealed: Boolean(crossing), overflow: Boolean(c.overflow), inferenceSource: res.inferenceSource || null, missionId: req.missionId || null, ms: res.latencyMs || 0 }, { ephemeral: true });
        if (c.overflow) {
          this.usage.edgeOverflow = (this.usage.edgeOverflow || 0) + 1;
          this.bus?.publish('router.overflow', { role: req.role || 'reason', model: c.model, inferenceSource: res.inferenceSource });
        }
        span?.end('ok', { latencyMs: res.latencyMs, promptTokens: res.usage.prompt, completionTokens: res.usage.completion, inferenceSource: res.inferenceSource });
        return res;
      } catch (e) {
        if (req.signal?.aborted) { span?.end('aborted'); throw e; }
        this.breaker(c.key).failure(e);
        errors.push(`${c.key}: ${errorMessage(e)}`);
        span?.end('error', { error: errorMessage(e) });
        this.bus?.publish('router.fallback', { from: c.key, error: errorMessage(e) });
      }
    }
    throw new Error(`All model candidates failed: ${errors.join(' | ')}`);
  }

  /**
   * Confidence triage: draft on a fast model that must end with "CONF: 0.xx". Escalate to the
   * reasoning role when confidence is low, missing, or the prompt is high-stakes.
   */
  async triaged(req, { threshold = 0.7 } = {}) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content || '';
    const highStakes = HIGH_STAKES.test(lastUser);
    if (!highStakes) {
      const draftMessages = [...req.messages, { role: 'user', content: 'After your answer, on the final line write "CONF: <0..1>" with your honest confidence.' }];
      try {
        const draft = await this.chat({ ...req, role: 'fast', messages: draftMessages });
        const m = draft.text.match(/CONF:\s*([01](?:\.\d+)?)/i);
        const conf = m ? Number(m[1]) : null;
        if (conf !== null && conf >= threshold) {
          return { ...draft, text: draft.text.replace(/\n?\s*CONF:\s*[01](?:\.\d+)?\s*$/i, '').trim(), confidence: conf, escalated: false };
        }
        const res = await this.chat(req);
        return { ...res, confidence: conf, escalated: true, reason: conf === null ? 'no confidence reported' : `confidence ${conf} < ${threshold}` };
      } catch {
        // fall through to the full model
      }
    }
    const res = await this.chat(req);
    return { ...res, escalated: highStakes, reason: highStakes ? 'high-stakes prompt' : 'draft failed' };
  }

  /** Embeddings: nomic-embed-text through Ollama when served, otherwise deterministic local hashing. */
  async embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    const embedModel = (this.cfg.models.embed || []).find((m) => this.ollama.has(m));
    if (embedModel && this.breaker(`ollama:${embedModel}`).canPass()) {
      try {
        const vecs = await this.ollama.embed(list.map((t) => String(t).slice(0, 8000)), embedModel);
        this.breaker(`ollama:${embedModel}`).success();
        return { model: embedModel, vectors: vecs };
      } catch (e) {
        this.breaker(`ollama:${embedModel}`).failure(e);
      }
    }
    return { model: 'hash-384', vectors: list.map((t) => hashEmbed(t, 384)) };
  }

  /** Run fn and count every model call made on its behalf (async context, so concurrent work elsewhere is not counted). */
  async metered(fn) {
    const meter = { calls: 0, tokens: 0, overflow: 0, remote: 0 };
    const t0 = Date.now();
    const result = await this.meters.run(meter, fn);
    return { result, meter: { ...meter, ms: Date.now() - t0 } };
  }

  #account(res) {
    this.usage.calls++;
    this.usage.promptTokens += res.usage?.prompt || 0;
    this.usage.completionTokens += res.usage?.completion || 0;
    const k = `${res.provider}:${res.model}`;
    const m = (this.usage.byModel[k] ||= { calls: 0, latencyMs: 0 });
    m.calls++;
    m.latencyMs += res.latencyMs || 0;
  }

  async status() {
    await Promise.all(this.providers.map((p) => p.refresh?.(true)));
    const roles = {};
    for (const role of Object.keys(this.cfg.models)) {
      const c = await this.candidates({ role });
      roles[role] = c.slice(0, 3).map((x) => x.key);
    }
    return {
      ollama: this.ollama.diagnose(),
      openaiCompat: { enabled: this.openai.enabled, models: this.openai.models, error: this.openai.lastError },
      gemini: { enabled: this.gemini.enabled, model: this.gemini.enabled ? this.gemini.model : null },
      edge: this.edge ? this.edge.hub.snapshot() : null,
      roles,
      breakers: Object.fromEntries([...this.breakers].map(([k, b]) => [k, b.toJSON()])),
      usage: this.usage,
    };
  }
}
