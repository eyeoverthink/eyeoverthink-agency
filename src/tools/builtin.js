// Built-in tools. Everything is free and local except optional web fetch/search (DuckDuckGo HTML, allowlisted hosts).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { truncate } from '../core/util.js';
import { encodeDna, decodeDna, gcContent, encodeCodon, decodeCodon } from '../core/dna.js';

// ---------- safe calculator (shunting-yard; no eval) ----------
const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max, pow: Math.pow };
const CONSTS = { pi: Math.PI, e: Math.E, phi: (1 + Math.sqrt(5)) / 2 };
const OPS = { '+': [1, 'L', (a, b) => a + b], '-': [1, 'L', (a, b) => a - b], '*': [2, 'L', (a, b) => a * b], '/': [2, 'L', (a, b) => a / b], '%': [2, 'L', (a, b) => a % b], '^': [4, 'R', (a, b) => a ** b], neg: [3, 'R', null] };

export function calculate(expr) {
  // Accept the forms models actually write: Math.sqrt, **, ×, ÷, √x, thousands separators, trailing "=".
  let src = String(expr)
    .replace(/Math\./g, '').replace(/\*\*/g, '^').replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/√\s*(\d+(?:\.\d+)?)/g, 'sqrt($1)')
    .replace(/=\s*$/, '').replace(/\s+/g, '');
  if (!/[a-z]\(/i.test(src)) src = src.replace(/(\d),(\d{3})\b/g, '$1$2'); // thousands separators only when no function args
  if (!src || src.length > 500) throw new Error('expression empty or too long');
  const tokens = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z_]+|[-+*/%^(),]/gi);
  if (!tokens || tokens.join('') !== src) {
    const bad = src.replace(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z_]+|[-+*/%^(),]/gi, '');
    throw new Error(`unsupported characters "${bad.slice(0, 10)}" — use numbers, + - * / % ^ ( ), and functions like sqrt(x)`);
  }
  const out = [], stack = [], argc = [];
  let prev = null;
  for (const tok of tokens) {
    if (/^[\d.]/.test(tok)) out.push(Number(tok));
    else if (/^[a-z_]+$/i.test(tok)) {
      const name = tok.toLowerCase();
      if (name in CONSTS) out.push(CONSTS[name]);
      else if (name in FUNCS) { stack.push(name); }
      else throw new Error(`unknown identifier "${tok}": calc only evaluates concrete numbers; use code_run for symbolic or algorithmic work`);
    } else if (tok === ',') {
      while (stack.length && stack.at(-1) !== '(') out.push(stack.pop());
      if (argc.length) argc[argc.length - 1]++;
    } else if (tok === '(') {
      stack.push('(');
      argc.push(1);
    } else if (tok === ')') {
      while (stack.length && stack.at(-1) !== '(') out.push(stack.pop());
      if (!stack.length) throw new Error('mismatched parenthesis');
      stack.pop();
      const n = argc.pop();
      if (stack.length && stack.at(-1) in FUNCS) out.push({ fn: stack.pop(), n });
    } else {
      let op = tok;
      const unary = (op === '-' || op === '+') && (prev === null || (prev in OPS) || prev === '(' || prev === ',');
      if (unary) {
        if (op === '-') stack.push('neg');
        prev = op;
        continue;
      }
      while (stack.length && stack.at(-1) in OPS) {
        const top = stack.at(-1);
        const [p1, assoc] = OPS[op], [p2] = OPS[top];
        if ((assoc === 'L' && p1 <= p2) || (assoc === 'R' && p1 < p2)) out.push(stack.pop()); else break;
      }
      stack.push(op);
    }
    prev = tok;
  }
  while (stack.length) {
    const t = stack.pop();
    if (t === '(') throw new Error('mismatched parenthesis');
    out.push(t);
  }
  const st = [];
  for (const t of out) {
    if (typeof t === 'number') st.push(t);
    else if (typeof t === 'object') { const args = st.splice(st.length - t.n, t.n); st.push(FUNCS[t.fn](...args)); }
    else if (t === 'neg') { const a = st.pop(); if (a === undefined) throw new Error('malformed expression'); st.push(-a); }
    else { const b = st.pop(), a = st.pop(); if (a === undefined || b === undefined) throw new Error('malformed expression'); st.push(OPS[t][2](a, b)); }
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) throw new Error('expression did not evaluate to a finite number');
  return st[0];
}

// ---------- workspace sandbox ----------
export function resolveInWorkspace(root, rel) {
  const target = path.resolve(root, String(rel || '.'));
  const r = path.resolve(root);
  if (target !== r && !target.startsWith(r + path.sep)) throw new Error('path escapes the workspace sandbox');
  return target;
}

// ---------- web (SSRF-guarded) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

async function guardUrl(raw, allowlist) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs are allowed');
  const host = u.hostname.toLowerCase();
  const allowed = allowlist.some((d) => host === d || host.endsWith('.' + d));
  if (!allowed) throw new Error(`host ${host} is not on the allowlist (config.security.httpAllowlist)`);
  const local = host === 'localhost' || host === '127.0.0.1';
  if (!local) {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error(`host ${host} resolves to a private address`);
  }
  return u;
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function fetchText(url, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; EyeOverThinkAgency/1.0)', ...(body ? { 'content-type': 'application/json' } : {}) },
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`redirect to ${res.headers.get('location')} refused (fetch it explicitly if allowlisted)`);
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') || '', text };
}

export function parseDuckDuckGo(html, max = 8) {
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    let href = m[1].replace(/&amp;/g, '&');
    const ud = href.match(/[?&]uddg=([^&]+)/);
    if (ud) href = decodeURIComponent(ud[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    results.push({ title: htmlToText(m[2]), url: href, snippet: htmlToText(m[3] || '') });
  }
  return results;
}

// ---------- sandboxed code execution ----------
export function runSandboxedJs(code, { timeoutMs = 10000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--permission', '--max-old-space-size=128', '-'], {
      cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '', killed = false;
    const cap = (s, chunk) => (s.length < 20000 ? s + chunk : s);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString()); });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (codeExit) => {
      clearTimeout(timer);
      resolve({ exitCode: codeExit, timedOut: killed, stdout: truncate(stdout, 8000), stderr: truncate(stderr.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?/g, ''), 4000) });
    });
    child.stdin.end(String(code));
  });
}

function runShell(command, { cwd, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = '', err = '', killed = false;
    child.stdout.on('data', (d) => { if (out.length < 40000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, timedOut: killed, stdout: out, stderr: err }); });
  });
}

/** Register built-in tools. Agency-level tools (delegate, workflow_run, mesh_send) are added in agency.js. */
export function registerBuiltinTools(registry, { cfg, memory, ledger }) {
  const ws = cfg.workspaceDir;
  const allow = cfg.security.httpAllowlist;

  registry.register({
    name: 'calc', description: 'Evaluate a math expression exactly (+ - * / % ^, sqrt, log, ln, sin, cos, min, max, pi, e, phi).',
    params: { type: 'object', required: ['expression'], properties: { expression: { type: 'string', maxLength: 500 } } },
    run: ({ expression }) => ({ expression, result: calculate(expression) }),
  });

  registry.register({
    name: 'time_now', description: 'Current date and time (ISO 8601, local timezone name).',
    run: () => ({ iso: new Date().toISOString(), local: new Date().toString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });

  registry.register({
    name: 'memory_search', description: 'Search agency memory (semantic + keyword + graph). Use before answering anything that may have been learned before.',
    params: { type: 'object', required: ['query'], properties: { query: { type: 'string', maxLength: 1000 }, k: { type: 'integer', minimum: 1, maximum: 15 } } },
    run: async ({ query, k = 5 }) => (await memory.recall(query, { k })).map((r) => ({ id: r.id, kind: r.kind, score: r.score, content: truncate(r.content, 700) })),
  });

  registry.register({
    name: 'memory_save', description: 'Save a durable fact or finding to agency memory with tags.',
    params: { type: 'object', required: ['content'], properties: { content: { type: 'string', maxLength: 4000 }, kind: { type: 'string', enum: ['fact', 'semantic', 'episodic', 'reflection'] }, tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 8 }, importance: { type: 'number', minimum: 0, maximum: 1 } } },
    run: async ({ content, kind = 'fact', tags = [], importance = 0.6 }, ctx) => memory.write({ content, kind, tags, importance, agentId: ctx.agentId, source: ctx.missionId ? `mission:${ctx.missionId}` : 'tool' }),
  });

  registry.register({
    name: 'graph_link', description: 'Record a relation in the knowledge graph, e.g. ("ollama","serves","llama3.1").',
    params: { type: 'object', required: ['src', 'rel', 'dst'], properties: { src: { type: 'string', maxLength: 120 }, rel: { type: 'string', maxLength: 60 }, dst: { type: 'string', maxLength: 120 } } },
    run: ({ src, rel, dst }) => { memory.link(src, rel, dst); return { linked: [src, rel, dst] }; },
  });

  registry.register({
    name: 'graph_neighbors', description: 'List known relations of an entity in the knowledge graph.',
    params: { type: 'object', required: ['entity'], properties: { entity: { type: 'string', maxLength: 120 } } },
    run: ({ entity }) => memory.neighbors(entity, 25),
  });

  registry.register({
    name: 'ledger_query', description: 'Read recent entries from the signed, hash-chained agency ledger.',
    params: { type: 'object', properties: { kind: { type: 'string', maxLength: 60 }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    run: ({ kind = null, limit = 15 }) => ledger.list({ kind, limit }).map((e) => ({ seq: e.seq, ts: e.ts, kind: e.kind, actor: e.actor, data: e.data })),
  });

  registry.register({
    name: 'fs_list', description: 'List files in the agency workspace sandbox.',
    params: { type: 'object', properties: { dir: { type: 'string', maxLength: 300 } } },
    run: ({ dir = '.' }) => {
      const p = resolveInWorkspace(ws, dir);
      return fs.readdirSync(p, { withFileTypes: true }).slice(0, 300).map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: d.isFile() ? fs.statSync(path.join(p, d.name)).size : null }));
    },
  });

  registry.register({
    name: 'fs_read', description: 'Read a text file from the workspace sandbox.', untrusted: true,
    params: { type: 'object', required: ['path'], properties: { path: { type: 'string', maxLength: 300 } } },
    run: ({ path: rel }) => {
      const p = resolveInWorkspace(ws, rel);
      const st = fs.statSync(p);
      if (st.size > 2_000_000) throw new Error('file larger than 2 MB');
      return fs.readFileSync(p, 'utf8');
    },
  });

  registry.register({
    name: 'fs_write', description: 'Write a text file in the workspace sandbox (creates folders).', risk: 'approval',
    params: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', maxLength: 300 }, content: { type: 'string', maxLength: 500000 } } },
    run: ({ path: rel, content }) => {
      const p = resolveInWorkspace(ws, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return { written: path.relative(ws, p), bytes: Buffer.byteLength(content) };
    },
  });

  registry.register({
    name: 'http_get', description: 'Fetch a web page or API (allowlisted hosts only) and return readable text.', untrusted: true, egress: true, timeoutMs: 20000,
    params: { type: 'object', required: ['url'], properties: { url: { type: 'string', maxLength: 2000 } } },
    run: async ({ url }) => {
      const u = await guardUrl(url, allow);
      const r = await fetchText(u.href);
      const text = /html/i.test(r.contentType) ? htmlToText(r.text) : r.text;
      return `HTTP ${r.status} ${u.href}\n\n${truncate(text, 20000)}`;
    },
  });

  registry.register({
    name: 'http_post', description: 'POST JSON to an allowlisted URL.', risk: 'approval', untrusted: true, egress: true, timeoutMs: 20000,
    params: { type: 'object', required: ['url', 'body'], properties: { url: { type: 'string', maxLength: 2000 }, body: { type: 'object' } } },
    run: async ({ url, body }) => {
      const u = await guardUrl(url, allow);
      const r = await fetchText(u.href, { method: 'POST', body: JSON.stringify(body) });
      return `HTTP ${r.status}\n${truncate(r.text, 20000)}`;
    },
  });

  registry.register({
    name: 'web_search', description: 'Free web search (DuckDuckGo). Returns titles, URLs and snippets.', untrusted: true, egress: true, timeoutMs: 20000,
    params: { type: 'object', required: ['query'], properties: { query: { type: 'string', maxLength: 300 }, max: { type: 'integer', minimum: 1, maximum: 10 } } },
    run: async ({ query, max = 6 }) => {
      const r = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
      const results = parseDuckDuckGo(r.text, max);
      if (!results.length) throw new Error(`no results parsed (HTTP ${r.status})`);
      return results;
    },
  });

  registry.register({
    name: 'code_run', description: 'Run a JavaScript (Node) program in a sandbox (no file system, no env, 10 s, 128 MB). Use console.log for output. Use it to verify code and computations.',
    params: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 60000 } } },
    timeoutMs: 15000,
    run: ({ code }) => runSandboxedJs(code, { cwd: ws }),
  });

  registry.register({
    name: 'shell', description: 'Run a shell command in the workspace (human approval required).', risk: 'approval', timeoutMs: 70000,
    params: { type: 'object', required: ['command'], properties: { command: { type: 'string', maxLength: 2000 } } },
    run: ({ command }) => runShell(command, { cwd: ws }),
  });

  registry.register({
    name: 'dna_encode', description: 'Encode text as DNA (2-bit nucleotides) or as a Carbon X codon frame.',
    params: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 20000 }, format: { type: 'string', enum: ['dna', 'codon'] } } },
    run: ({ text, format = 'dna' }) => {
      const strand = format === 'codon' ? encodeCodon(text) : encodeDna(text);
      return { format, length: strand.length, gc: Math.round(gcContent(strand) * 1000) / 1000, strand: truncate(strand, 4000) };
    },
  });

  registry.register({
    name: 'dna_decode', description: 'Decode a DNA strand (2-bit) or Carbon X codon frame back to text.',
    params: { type: 'object', required: ['strand'], properties: { strand: { type: 'string', maxLength: 200000 }, format: { type: 'string', enum: ['dna', 'codon'] } } },
    run: ({ strand, format = 'dna' }) => ({ text: (format === 'codon' ? decodeCodon(strand) : decodeDna(strand)).toString('utf8') }),
  });

  return registry;
}
