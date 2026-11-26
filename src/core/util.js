// Shared, dependency-free helpers used across the agency runtime.
import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish base32, lowercase

/** Time-sortable unique id: 10 chars of time + 12 chars of randomness, with an optional prefix. */
export function newId(prefix = '') {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = crypto.randomBytes(12);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Deterministic JSON (RFC 8785 JCS compatible for standard JSON values):
 * object keys sorted by UTF-16 code units, no whitespace, undefined object keys dropped,
 * undefined array items serialized as null, -0 normalized to 0, Date via toJSON().
 */
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (typeof value.toJSON === 'function') return canonical(value.toJSON());
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

/** RFC 6962 domain-separated Merkle hashes: 0x00 for leaves, 0x01 for internal nodes. */
export const merkleLeafHash = (leafHex) => crypto.createHash('sha256').update(Buffer.from([0x00])).update(String(leafHex), 'utf8').digest('hex');
export const merkleNodeHash = (leftHex, rightHex) => crypto.createHash('sha256').update(Buffer.from([0x01])).update(String(leftHex), 'utf8').update(String(rightHex), 'utf8').digest('hex');

/**
 * Build an RFC 6962 domain-separated Merkle tree without odd-leaf duplication (lone odd nodes are promoted).
 * Returns { root, levels, proofOf(seq) } where seq is 1-based.
 */
export function buildMerkleTree(entryHashes) {
  if (!entryHashes.length) return { root: '0'.repeat(64), levels: [], proofOf: () => [] };
  const levels = [entryHashes.map(merkleLeafHash)];
  while (levels.at(-1).length > 1) {
    const prev = levels.at(-1), next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? merkleNodeHash(prev[i], prev[i + 1]) : prev[i]);
    }
    levels.push(next);
  }
  const root = levels.at(-1)[0];
  const proofOf = (seq) => {
    let idx = seq - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= entryHashes.length) throw new Error(`No ledger entry ${seq}`);
    const path = [];
    for (let l = 0; l < levels.length - 1; l++) {
      const level = levels[l];
      if (idx % 2 === 0 && idx + 1 === level.length) {
        // Lone odd node is promoted directly to the next level; no sibling hash emitted.
        idx = Math.floor(idx / 2);
        continue;
      }
      const sibling = idx % 2 === 0 ? level[idx + 1] : level[idx - 1];
      path.push({ hash: sibling, left: idx % 2 === 1 });
      idx = Math.floor(idx / 2);
    }
    return path;
  };
  return { root, levels, proofOf };
}

/** Deterministic expected left/right step sequence for 1-based seq in a tree of size leaves. */
export function expectedMerkleSteps(seq, size, version = 2) {
  if (!Number.isInteger(seq) || !Number.isInteger(size) || seq < 1 || size < 1 || seq > size) return null;
  const steps = [];
  let idx = seq - 1;
  let len = size;
  while (len > 1) {
    if (version >= 2 && idx % 2 === 0 && idx + 1 === len) {
      idx = Math.floor(idx / 2);
      len = Math.ceil(len / 2);
      continue;
    }
    steps.push(idx % 2 === 1);
    idx = Math.floor(idx / 2);
    len = Math.ceil(len / 2);
  }
  return steps;
}

export const nowIso = () => new Date().toISOString();
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : lo));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string') return text ?? fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * Pull the first balanced JSON object/array out of free-form model output.
 * Handles ```json fences, leading prose, and trailing commentary. Returns null if none parses.
 */
export function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const s = String(text);
  const direct = safeJsonParse(s.trim());
  if (direct !== null && typeof direct === 'object') return direct;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const f = safeJsonParse(fence[1].trim());
    if (f !== null && typeof f === 'object') return f;
  }
  for (let start = 0; start < s.length; start++) {
    const open = s[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = safeJsonParse(s.slice(start, i + 1));
          if (candidate !== null) return candidate;
          break;
        }
      }
    }
  }
  return null;
}

/** Rough token estimate (≈4 chars/token for English, conservative for code). */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 3.6);

export function truncate(text, max = 2000) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

export function slug(value, max = 40) {
  const s = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
  return s || 'item';
}

/** Promise with timeout that also aborts an AbortController if given. */
export async function withTimeout(promise, ms, label = 'operation', controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

/** Counting semaphore for bounding concurrency (e.g. one model on an 8 GB GPU at a time). */
export class Semaphore {
  constructor(max = 1) { this.max = Math.max(1, max); this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.max) { this.active++; return; }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

/** Cosine similarity between two equal-length numeric vectors. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Local embedding used when no embedding model is reachable: signed feature hashing of
 * word unigrams, bigrams and character trigrams into a fixed-size, L2-normalized vector.
 * Deterministic, offline, and good enough for lexical-semantic recall.
 */
export function hashEmbed(text, dims = 384) {
  const v = new Float64Array(dims);
  const words = String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const add = (feature, weight) => {
    const h = crypto.createHash('md5').update(feature).digest();
    const idx = h.readUInt32LE(0) % dims;
    const sign = h[4] & 1 ? 1 : -1;
    v[idx] += sign * weight;
  };
  for (let i = 0; i < words.length; i++) {
    add('w:' + words[i], 1.0);
    if (i + 1 < words.length) add('b:' + words[i] + '_' + words[i + 1], 0.7);
    const w = `#${words[i]}#`;
    for (let j = 0; j + 3 <= w.length; j++) add('c:' + w.slice(j, j + 3), 0.35);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}

export function tokenize(text) {
  return (String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || []);
}

const STOP = new Set('the a an and or of to in on for with is are was were be been it this that these those as at by from into about over under not no yes you your we our they their i me my he she his her them can will would should could do does did done has have had than then so if but what which who whom how when where why all any each some such only own same too very just also more most other'.split(' '));

/** Lightweight keyphrase/entity extraction for the knowledge graph (capitalized spans + frequent terms). */
export function extractEntities(text, max = 12) {
  const s = String(text ?? '');
  const out = new Map();
  for (const m of s.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:[ -][A-Z][a-zA-Z0-9]+){0,3})\b/g)) {
    const e = m[1].trim();
    if (e.length < 3 || STOP.has(e.toLowerCase())) continue;
    out.set(e.toLowerCase(), (out.get(e.toLowerCase()) || 0) + 2);
  }
  for (const w of tokenize(s)) {
    if (w.length < 5 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.set(w, (out.get(w) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([e]) => e);
}

export function errorMessage(err) {
  if (!err) return 'unknown error';
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
