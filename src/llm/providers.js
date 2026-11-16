// Model providers. Each implements: available(), listModels(), chat(req), embed(texts, model).
// chat(req) -> { text, model, provider, usage: {prompt, completion}, latencyMs, raw? }
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from '../core/util.js';

async function httpJson(url, { method = 'GET', body, headers = {}, timeoutMs = 30000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method, signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Local GPU inference through Ollama. Streams so cloud-backed tags (gpt-oss:*-cloud) return content. */
export class OllamaProvider {
  constructor(cfg) {
    this.name = 'ollama';
    this.url = cfg.url.replace(/\/$/, '');
    this.numCtx = cfg.numCtx;
    this.keepAlive = cfg.keepAlive;
    this.timeoutMs = cfg.timeoutMs;
    this.modelsDir = cfg.modelsDir;
    this.models = [];
    this.lastCheck = 0;
    this.lastError = null;
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.lastCheck < 15000) return this.models;
    try {
      const data = await httpJson(`${this.url}/api/tags`, { timeoutMs: 4000 });
      this.models = (data.models || []).map((m) => ({
        name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size,
        quant: m.details?.quantization_level,
      }));
      this.lastError = null;
    } catch (e) {
      this.models = [];
      this.lastError = e.message;
    }
    this.lastCheck = Date.now();
    return this.models;
  }

  async available() { await this.refresh(); return this.lastError === null; }
  async listModels() { await this.refresh(); return this.models.map((m) => m.name); }
  has(model) { return this.models.some((m) => m.name === model); }

  /**
   * Models that exist on disk under OLLAMA_MODELS but are not reported by the running server —
   * the signature of a server started without the OLLAMA_MODELS environment variable.
   */
  onDiskModels() {
    const dir = this.modelsDir;
    if (!dir) return [];
    const lib = path.join(dir, 'manifests', 'registry.ollama.ai', 'library');
    const out = [];
    try {
      for (const name of fs.readdirSync(lib)) {
        for (const tag of fs.readdirSync(path.join(lib, name))) out.push(`${name}:${tag}`);
      }
    } catch { /* directory missing */ }
    return out;
  }

  diagnose() {
    const disk = this.onDiskModels();
    const served = new Set(this.models.map((m) => m.name));
    const missing = disk.filter((m) => !served.has(m));
    const notes = [];
    if (this.lastError) notes.push(`Ollama not reachable at ${this.url}: ${this.lastError}`);
    if (!this.lastError && served.size === 0 && disk.length > 0) {
      notes.push(`Ollama is running but serves 0 models while ${disk.length} exist in ${this.modelsDir}. ` +
        'The server process was probably started without OLLAMA_MODELS set; restart it from an environment that has it.');
    }
    return { url: this.url, served: [...served], onDisk: disk, notServed: missing, notes };
  }

  async chat({ model, messages, json = false, temperature = 0.4, topP, maxTokens = 1024, signal, onToken, numCtx, seed }) {
    const t0 = Date.now();
    const body = {
      model, messages, stream: true, keep_alive: this.keepAlive,
      options: { temperature, num_ctx: numCtx || this.numCtx, num_predict: maxTokens, ...(topP ? { top_p: topP } : {}), ...(Number.isInteger(seed) ? { seed } : {}) },
    };
    if (json) body.format = 'json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('ollama chat timeout')), this.timeoutMs);
    signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
    let text = '', promptTokens = 0, completionTokens = 0, thinking = '';
    try {
      const res = await fetch(`${this.url}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal: ctrl.signal, headers: { 'content-type': 'application/json' } });
      if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const evt = JSON.parse(line);
          if (evt.error) throw new Error(`ollama: ${evt.error}`);
          const piece = evt.message?.content || '';
          if (evt.message?.thinking) thinking += evt.message.thinking;
          if (piece) { text += piece; onToken?.(piece); }
          if (evt.done) { promptTokens = evt.prompt_eval_count || 0; completionTokens = evt.eval_count || 0; }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!text && thinking) text = thinking; // reasoning models occasionally emit only the thinking channel
    return {
      text, model, provider: this.name, latencyMs: Date.now() - t0,
      usage: { prompt: promptTokens || estimateTokens(JSON.stringify(messages)), completion: completionTokens || estimateTokens(text) },
    };
  }

  async embed(texts, model) {
    const data = await httpJson(`${this.url}/api/embed`, { method: 'POST', body: { model, input: texts, keep_alive: this.keepAlive }, timeoutMs: 60000 });
    if (!Array.isArray(data.embeddings)) throw new Error('ollama embed returned no embeddings');
    return data.embeddings;
  }
}

/** Any OpenAI-compatible endpoint: LM Studio, llama.cpp server, vLLM, or a free hosted tier. */
export class OpenAICompatProvider {
  constructor(cfg) {
    this.name = 'openai-compat';
    this.url = (cfg.url || '').replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
    this.configured = cfg.models || [];
    this.models = [];
    this.lastError = null;
    this.lastCheck = 0;
  }
  get enabled() { return Boolean(this.url); }
  #headers() { return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}; }

  async refresh(force = false) {
    if (!this.enabled) return [];
    if (!force && Date.now() - this.lastCheck < 30000) return this.models;
    try {
      const data = await httpJson(`${this.url}/models`, { headers: this.#headers(), timeoutMs: 5000 });
      this.models = (data.data || []).map((m) => m.id);
      this.lastError = null;
    } catch (e) {
      this.models = [...this.configured];
      this.lastError = e.message;
    }
    this.lastCheck = Date.now();
    return this.models;
  }
  async available() { if (!this.enabled) return false; await this.refresh(); return this.models.length > 0; }
  async listModels() { return this.refresh(); }
  has(model) { return this.models.includes(model); }

  async chat({ model, messages, json = false, temperature = 0.4, topP, maxTokens = 1024, signal, seed }) {
    const t0 = Date.now();
    const body = { model, messages, temperature, max_tokens: maxTokens, ...(topP ? { top_p: topP } : {}), ...(Number.isInteger(seed) ? { seed } : {}) };
    if (json) body.response_format = { type: 'json_object' };
    const data = await httpJson(`${this.url}/chat/completions`, { method: 'POST', body, headers: this.#headers(), timeoutMs: 180000, signal });
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text, model, provider: this.name, latencyMs: Date.now() - t0,
      usage: { prompt: data.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)), completion: data.usage?.completion_tokens ?? estimateTokens(text) },
    };
  }

  async embed(texts, model) {
    const data = await httpJson(`${this.url}/embeddings`, { method: 'POST', body: { model, input: texts }, headers: this.#headers(), timeoutMs: 60000 });
    return (data.data || []).map((d) => d.embedding);
  }
}

/** Gemini Developer API (free tier, API key). Optional server-side cloud fallback only. */
export class GeminiProvider {
  constructor(cfg) {
    this.name = 'gemini';
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.lastError = null;
  }
  get enabled() { return Boolean(this.apiKey); }
  async available() { return this.enabled; }
  async listModels() { return this.enabled ? [this.model] : []; }
  has(model) { return this.enabled && model === this.model; }

  async chat({ model, messages, json = false, temperature = 0.4, maxTokens = 1024, signal }) {
    const t0 = Date.now();
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }],
    }));
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || this.model)}:generateContent`;
    const data = await httpJson(url, { method: 'POST', body, headers: { 'x-goog-api-key': this.apiKey }, timeoutMs: 120000, signal });
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return {
      text, model: model || this.model, provider: this.name, latencyMs: Date.now() - t0,
      usage: { prompt: data.usageMetadata?.promptTokenCount ?? 0, completion: data.usageMetadata?.candidatesTokenCount ?? estimateTokens(text) },
    };
  }

  async embed() { throw new Error('gemini provider is not used for embeddings'); }
}
