// Configuration: defaults <- AGENCY_HOME/agency.config.json <- environment variables <- overrides.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULTS = Object.freeze({
  name: 'EyeOverThink Agency',
  host: '127.0.0.1',
  port: 8790,
  // Local GPU inference. num_ctx is pinned: Ollama's 131k default spills an 8 GB GPU to CPU.
  ollama: { url: 'http://127.0.0.1:11434', numCtx: 8192, keepAlive: '10m', timeoutMs: 240000, modelsDir: '' },
  // Optional OpenAI-compatible local/free endpoint (LM Studio, llama.cpp server, Groq free tier).
  openaiCompat: { url: '', apiKey: '', models: [] },
  // Optional Gemini Developer API free tier (server-side cloud fallback). Never required.
  gemini: { apiKey: '', model: 'gemini-3.5-flash-lite' },
  // Browser edge tier: Firebase AI Logic hybrid (Gemini Nano on-device, cloud fallback) via a connected dashboard.
  edge: {
    enabled: true, claimTimeoutMs: 20000, resultTimeoutMs: 180000,
    // While the local GPU is busy, these roles spill to a connected Firebase AI Logic edge worker instead of queueing.
    overflow: { enabled: true, roles: ['fast', 'plan', 'critic', 'reason'] },
  },
  // Role -> ordered model preference. The router skips models that are not installed or whose breaker is open.
  models: {
    reason: ['fraymus-prime:v1', 'niles-fraymus:v9', 'hermes3:latest', 'llama3.1:8b', 'gemma4:latest'],
    plan: ['hermes3:latest', 'fraymus-prime:v1', 'llama3.1:8b', 'niles-fraymus:v9'],
    code: ['qwen2.5-coder:7b', 'fraymus-prime:v1', 'llama3.1:8b'],
    fast: ['llama3.2:latest', 'fraynix-3b:latest', 'llama3.1:8b'],
    critic: ['hermes3:latest', 'llama3.1:8b', 'fraymus-prime:v1'],
    continuity: ['niles-continuity-8b:latest', 'niles-continuity:latest', 'llama3.1:8b'],
    dna: ['fraynix-dna:8b', 'fraynix-8b:latest', 'llama3.1:8b'],
    vision: ['qwen3-vl:4b-16k', 'qwen3-vl:4b', 'niles-vl:latest'],
    big: ['gpt-oss:120b-cloud'],
    embed: ['nomic-embed-text:latest'],
  },
  limits: {
    localConcurrency: 1, // one local generation at a time on an 8 GB GPU
    maxAgentSteps: 8,
    maxTaskAttempts: 2,
    maxReplans: 2,
    maxTasksPerMission: 8,
    criticThreshold: 0.6,
    missionTimeoutMs: 45 * 60 * 1000,
    toolTimeoutMs: 30000,
    contextTokens: 6000,
  },
  // Skill-first routing: before an agent spends model turns, a matching crystallized skill answers with verified code.
  // The prefilter costs nothing; only a plausible match spends one short bind call (bindRole), grounded against the task.
  // learnBinders: grounded model bindings become examples; at binderMinExamples the bind step itself is crystallized.
  skills: { first: true, bindRole: 'fast', minOverlap: 1, learnBinders: true, binderMinExamples: 3 },
  dream: { enabled: true, intervalMinutes: 30, minEpisodes: 3 },
  autonomy: { enabled: false, intervalMinutes: 15 },
  security: {
    // Tools that never run without a human approval in the dashboard or CLI.
    approvalTools: ['shell', 'fs_write', 'http_post', 'mesh_send'],
    httpAllowlist: ['duckduckgo.com', 'html.duckduckgo.com', 'en.wikipedia.org', 'api.github.com', 'raw.githubusercontent.com'],
    allowLoopback: false,
  },
  manifestDirs: [],
  peers: [],
});

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * OLLAMA_HOST is the server's *bind* address (often 0.0.0.0 or ":11434"); turn it into a URL a client can call.
 */
export function ollamaClientUrl(raw) {
  if (!raw) return undefined;
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || u.hostname === '0.0.0.0' || u.hostname === '[::]' || u.hostname === '::') u.hostname = '127.0.0.1';
    if (!u.port && !/^https?:\/\/[^/]+:\d+/.test(s)) u.port = '11434';
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'http://127.0.0.1:11434';
  }
}

function envOverrides(env) {
  const o = {};
  const set = (pathKeys, value) => {
    if (value === undefined || value === '') return;
    let cur = o;
    for (let i = 0; i < pathKeys.length - 1; i++) cur = cur[pathKeys[i]] ??= {};
    cur[pathKeys.at(-1)] = value;
  };
  set(['host'], env.AGENCY_HOST);
  set(['port'], env.AGENCY_PORT && Number(env.AGENCY_PORT));
  set(['ollama', 'url'], env.AGENCY_OLLAMA_URL || ollamaClientUrl(env.OLLAMA_HOST));
  set(['ollama', 'numCtx'], env.AGENCY_NUM_CTX && Number(env.AGENCY_NUM_CTX));
  set(['ollama', 'modelsDir'], env.OLLAMA_MODELS);
  set(['openaiCompat', 'url'], env.OPENAI_COMPAT_URL);
  set(['openaiCompat', 'apiKey'], env.OPENAI_COMPAT_KEY);
  set(['gemini', 'apiKey'], env.GEMINI_API_KEY);
  set(['gemini', 'model'], env.GEMINI_MODEL);
  set(['limits', 'localConcurrency'], env.AGENCY_CONCURRENCY && Number(env.AGENCY_CONCURRENCY));
  if (env.AGENCY_MANIFEST_DIRS) set(['manifestDirs'], env.AGENCY_MANIFEST_DIRS.split(path.delimiter).filter(Boolean));
  return o;
}

/**
 * Load configuration. AGENCY_HOME (default ./data) holds the database, keys and config file.
 * An API token for the HTTP server is generated on first run and stored in AGENCY_HOME/api-token.
 */
export function loadConfig(overrides = {}, env = process.env) {
  const home = path.resolve(overrides.home || env.AGENCY_HOME || path.join(process.cwd(), 'data'));
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'agency.config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try { fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`Invalid JSON in ${file}: ${e.message}`);
    }
  }
  const cfg = deepMerge(deepMerge(deepMerge(structuredClone(DEFAULTS), fileCfg), envOverrides(env)), overrides);
  cfg.home = home;
  cfg.configFile = file;
  cfg.dbPath = overrides.dbPath || path.join(home, 'agency.db');
  cfg.keysDir = path.join(home, 'keys');
  cfg.workspaceDir = path.resolve(overrides.workspaceDir || fileCfg.workspaceDir || path.join(home, 'workspace'));
  cfg.exportDir = path.join(home, 'exports');
  for (const d of [cfg.keysDir, cfg.workspaceDir, cfg.exportDir]) fs.mkdirSync(d, { recursive: true });
  const tokenFile = path.join(home, 'api-token');
  if (!overrides.apiToken && !env.AGENCY_API_TOKEN && !fs.existsSync(tokenFile)) {
    fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
  }
  cfg.apiToken = overrides.apiToken || env.AGENCY_API_TOKEN || fs.readFileSync(tokenFile, 'utf8').trim();
  return cfg;
}

/** Persist a partial config change into agency.config.json (merging, never clobbering unrelated keys). */
export function saveConfigPatch(cfg, patch) {
  let current = {};
  if (fs.existsSync(cfg.configFile)) current = JSON.parse(fs.readFileSync(cfg.configFile, 'utf8'));
  const next = deepMerge(current, patch);
  fs.writeFileSync(cfg.configFile, JSON.stringify(next, null, 2));
  return next;
}
