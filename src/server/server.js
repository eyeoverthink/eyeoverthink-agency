// HTTP API + SSE + static dashboard. Zero dependencies (node:http).
// Auth: Bearer <AGENCY_HOME/api-token> on /api/*. Public: /health, /mesh/*, /hooks/* (workflow key), /.well-known/agent.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '../core/util.js';
import { NODE_TYPES } from '../workflows/engine.js';
import { encodeDna, decodeDna, encodeCodon, decodeCodon, gcContent, dnaHypervector } from '../core/dna.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function rateLimiter(perMinute) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    const b = buckets.get(key) || { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
    b.at = now;
    if (b.tokens < 1) { buckets.set(key, b); return false; }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 5000) buckets.clear();
    return true;
  };
}

async function readJson(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
}

export function createServer(agency) {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, public: Boolean(opts.public), limit: opts.limit });
  };
  const a = agency;
  const tokenBuf = Buffer.from(a.cfg.apiToken);
  const authed = (req, url) => {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
    const b = Buffer.from(t);
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };
  const need = (v, msg) => { if (v === undefined || v === null || v === '') throw new HttpError(400, msg); return v; };
  const found = (v, what = 'resource') => { if (!v) throw new HttpError(404, `${what} not found`); return v; };
  const hookLimit = rateLimiter(60), meshLimit = rateLimiter(120);

  // ---------- public ----------
  add('GET', '/health', () => ({ ok: true, name: a.cfg.name }), { public: true });
  add('GET', '/.well-known/agent.json', () => ({
    name: a.cfg.name, description: 'Sovereign multi-agent agency (EyeOverThink).', version: '1.0.0', protocol: 'eyeoverthink-mesh/1',
    identity: a.mesh.identity(), skills: a.agents.list().map((x) => ({ id: x.id, name: x.name, description: x.description })),
    endpoints: { mesh: '/mesh/inbox', identity: '/mesh/identity', hooks: '/hooks/{workflowId}' },
  }), { public: true });
  add('GET', '/mesh/identity', () => a.mesh.identity(), { public: true });
  add('POST', '/mesh/inbox', async ({ body }) => a.mesh.receive(body), { public: true, limit: meshLimit });
  add('POST', '/hooks/:id', async ({ params, body, req }) => {
    if (!a.workflows.checkKey(params.id, req.headers['x-agency-key'])) throw new HttpError(401, 'invalid workflow key');
    return a.workflows.run(params.id, body || {});
  }, { public: true, limit: hookLimit });

  // ---------- core ----------
  add('GET', '/api/status', () => a.status());
  add('GET', '/api/models', () => a.router.status());
  add('POST', '/api/models/refresh', async () => { await a.router.refresh(); return a.router.status(); });
  add('GET', '/api/tools', () => a.tools.catalog());
  add('GET', '/api/config', () => ({ name: a.cfg.name, models: a.cfg.models, limits: a.cfg.limits, security: a.cfg.security, dream: a.cfg.dream, edge: a.cfg.edge, home: a.cfg.home, workspace: a.cfg.workspaceDir }));

  // ---------- agents ----------
  add('GET', '/api/agents', ({ url }) => a.agents.list({ includeDisabled: url.searchParams.get('all') === '1' }));
  add('GET', '/api/agents/:id', ({ params }) => found(a.agents.get(params.id), 'agent'));
  add('POST', '/api/agents', ({ body }) => a.agents.upsert({ ...body, source: 'custom' }));
  add('POST', '/api/agents/:id/enabled', ({ params, body }) => a.agents.setEnabled(params.id, Boolean(body.enabled)));
  add('DELETE', '/api/agents/:id', ({ params }) => ({ removed: a.agents.remove(params.id) }));
  add('POST', '/api/agents/:id/ask', async ({ params, body }) => a.runtime.run(params.id, need(body.task, 'task required'), { privacy: body.privacy }));
  add('POST', '/api/agents/:id/evolve', async ({ params, body }) => a.evolution.evolve(params.id, { population: Math.min(8, Math.max(2, body.population || 4)) }));
  add('GET', '/api/agents/:id/evolution', ({ params }) => a.evolution.history(params.id));
  add('GET', '/api/agents/:id/organism', ({ params }) => a.agents.exportOrganism(params.id, a.memory.playbook(params.id, 10).map((p) => p.content)));
  add('POST', '/api/organisms/import', ({ body }) => a.agents.importOrganism(need(body.plasmid, 'plasmid required')));
  add('POST', '/api/agents/import-manifests', ({ body }) => a.agents.importManifests(need(body.dirs, 'dirs required'), new Set(a.tools.catalog().map((t) => t.name))));
  add('POST', '/api/forge', async ({ body }) => a.forge.create(need(body.description, 'description required')));
  add('POST', '/api/forge/roster', async ({ body }) => a.forge.roster({ business: need(body.business, 'business required'), model: body.model, goal: need(body.goal, 'goal required'), count: body.count, commit: Boolean(body.commit) }));

  // ---------- missions ----------
  add('GET', '/api/missions', ({ url }) => a.missions.list({ limit: +url.searchParams.get('limit') || 50, status: url.searchParams.get('status') }));
  add('POST', '/api/missions', ({ body }) => a.missions.create(need(body.goal, 'goal required'), body));
  add('GET', '/api/missions/:id', ({ params }) => found(a.missions.get(params.id), 'mission'));
  add('POST', '/api/missions/:id/cancel', ({ params }) => a.missions.cancel(params.id));
  add('GET', '/api/missions/:id/trace', ({ params }) => a.tracer.trace(params.id));
  add('GET', '/api/traces/:id', ({ params }) => a.tracer.trace(params.id));

  // ---------- approvals ----------
  add('GET', '/api/approvals', ({ url }) => a.approvals.list(url.searchParams.get('status') || 'pending'));
  add('POST', '/api/approvals/:id', ({ params, body }) => a.approvals.decide(params.id, Boolean(body.approve), 'dashboard'));

  // ---------- memory ----------
  add('GET', '/api/memory', ({ url }) => a.memory.list({ kind: url.searchParams.get('kind'), q: url.searchParams.get('q'), limit: +url.searchParams.get('limit') || 50, offset: +url.searchParams.get('offset') || 0 }));
  add('POST', '/api/memory', async ({ body }) => a.memory.write({ content: need(body.content, 'content required'), kind: body.kind || 'fact', tags: body.tags, importance: body.importance, source: 'dashboard' }));
  add('GET', '/api/memory/search', async ({ url }) => a.memory.recall(need(url.searchParams.get('q'), 'q required'), { k: +url.searchParams.get('k') || 8 }));
  add('GET', '/api/memory/graph', ({ url }) => a.memory.graph(+url.searchParams.get('limit') || 300));
  add('GET', '/api/memory/stats', () => a.memory.stats());
  add('GET', '/api/memory/:id/verify', ({ params }) => a.memory.verify(params.id));
  add('POST', '/api/memory/:id/archive', ({ params }) => { a.memory.archive(params.id); return { archived: params.id }; });

  // ---------- ledger ----------
  add('GET', '/api/ledger', ({ url }) => a.ledger.list({ limit: +url.searchParams.get('limit') || 100, before: url.searchParams.get('before') ? +url.searchParams.get('before') : null, kind: url.searchParams.get('kind') }));
  add('GET', '/api/ledger/verify', () => a.ledger.verify());
  add('GET', '/api/ledger/proof/:seq', ({ params }) => a.ledger.proof(+params.seq));

  // ---------- workflows ----------
  add('GET', '/api/workflow-node-types', () => NODE_TYPES);
  add('GET', '/api/workflows', () => a.workflows.list());
  add('POST', '/api/workflows', ({ body }) => a.workflows.save({ id: body.id, name: need(body.name, 'name required'), description: body.description, def: need(body.def, 'def required') }));
  add('GET', '/api/workflows/:id', ({ params }) => found(a.workflows.get(params.id), 'workflow'));
  add('DELETE', '/api/workflows/:id', ({ params }) => { a.workflows.remove(params.id); return { removed: params.id }; });
  add('POST', '/api/workflows/:id/run', async ({ params, body }) => a.workflows.run(params.id, body.input || {}));
  add('POST', '/api/workflows/:id/deploy', ({ params }) => a.workflows.deploy(params.id));
  add('POST', '/api/workflows/:id/undeploy', ({ params }) => { a.workflows.undeploy(params.id); return { undeployed: params.id }; });
  add('GET', '/api/workflows/:id/runs', ({ params }) => a.workflows.runs(params.id));
  add('GET', '/api/workflow-runs/:id', ({ params }) => found(a.workflows.getRun(params.id), 'run'));

  // ---------- intelligence ----------
  add('GET', '/api/dreams', () => a.dreamer.list());
  add('POST', '/api/dreams/run', async ({ body }) => a.dreamer.cycle({ force: body.force !== false }));
  add('GET', '/api/bench', () => a.bench.history());
  add('POST', '/api/bench', async ({ body }) => a.bench.run(body.suite || 'core', { only: body.only }));
  add('GET', '/api/telemetry/stats', () => a.tracer.stats());
  add('POST', '/api/selftest', async () => a.continuity.selftest());
  add('POST', '/api/continuity/export', () => a.continuity.brainDump());
  add('POST', '/api/continuity/snapshot', () => a.continuity.snapshot());

  // ---------- autonomy ----------
  add('GET', '/api/autonomy', () => ({ enabled: a.store.kvGet('autonomy:enabled', a.cfg.autonomy.enabled), goals: a.goals() }));
  add('POST', '/api/autonomy', ({ body }) => { a.store.kvSet('autonomy:enabled', Boolean(body.enabled)); a.ledger.append('autonomy.toggle', { enabled: Boolean(body.enabled) }, 'operator'); return { enabled: Boolean(body.enabled) }; });
  add('POST', '/api/autonomy/goals', ({ body }) => a.addGoal(need(body.goal, 'goal required'), body.everyHours));
  add('DELETE', '/api/autonomy/goals/:id', ({ params }) => { a.removeGoal(params.id); return { removed: params.id }; });
  add('POST', '/api/autonomy/tick', async () => ({ mission: await a.autonomyTick() }));

  // ---------- mesh ----------
  add('GET', '/api/mesh/peers', () => a.mesh.peers());
  add('POST', '/api/mesh/peers', async ({ body }) => a.mesh.addPeer(need(body.url, 'url required'), body.name));
  add('POST', '/api/mesh/peers/:id/trust', ({ params, body }) => { a.mesh.setTrust(params.id, body.trust); return { ok: true }; });
  add('GET', '/api/mesh/inbox', () => a.mesh.inbox());

  // ---------- DNA lab ----------
  add('POST', '/api/dna/encode', ({ body }) => {
    const text = String(need(body.text, 'text required'));
    const strand = body.format === 'codon' ? encodeCodon(text) : encodeDna(text);
    return { format: body.format || 'dna', strand, length: strand.length, gc: gcContent(strand), hypervector: dnaHypervector(strand).slice(0, 64) };
  });
  add('POST', '/api/dna/decode', ({ body }) => ({ text: (body.format === 'codon' ? decodeCodon(body.strand) : decodeDna(body.strand)).toString('utf8') }));

  // ---------- edge workers (dashboard tabs running Firebase AI Logic) ----------
  add('GET', '/api/edge', () => a.edge.snapshot());
  add('POST', '/api/edge/register', ({ body }) => a.edge.register(body));
  add('POST', '/api/edge/heartbeat', ({ body }) => ({ ok: a.edge.heartbeat(body.id, body) }));
  add('GET', '/api/edge/claim', async ({ url }) => a.edge.claim(url.searchParams.get('worker'), 25000));
  add('POST', '/api/edge/result', ({ body }) => ({ ok: a.edge.complete(body.worker, body.job, body) }));

  // ---------- server-sent events ----------
  const sse = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    for (const evt of a.bus.tail(80)) send(evt);
    const onEvt = (evt) => send(evt);
    a.bus.on('*', onEvt);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { a.bus.off('*', onEvt); clearInterval(ping); });
  };

  const distDir = path.join(ROOT, 'web', 'dist');
  const serveStatic = (res, pathname) => {
    const base = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : null;
    if (!base) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>EyeOverThink Agency</title><body style="font:15px system-ui;background:#0e0d0b;color:#eee;padding:40px"><h1>EyeOverThink Agency API is running</h1><p>The dashboard is not built yet. Run <code>npm run build</code> in the repository, then reload.</p><p>API token file: <code>${a.cfg.home.replace(/</g, '')}${path.sep}api-token</code></p></body>`);
    }
    let file = path.join(base, decodeURIComponent(pathname));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(base, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (!authed(req, url)) throw new HttpError(401, 'unauthorized');
        return sse(req, res);
      }
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
        throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
      }
      if (!route.public && !authed(req, url)) throw new HttpError(401, 'unauthorized: send Authorization: Bearer <api-token>');
      if (route.limit && !route.limit(req.socket.remoteAddress || 'x')) throw new HttpError(429, 'rate limit exceeded');
      const m = url.pathname.match(route.re);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const out = await route.handler({ req, res, url, params, body });
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? null));
    } catch (e) {
      const status = e.status || (/not found/i.test(e.message) ? 404 : /required|invalid|must|cannot|unknown/i.test(e.message) ? 400 : 500);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: errorMessage(e) }));
    }
  });
  server.requestTimeout = 0; // agent calls and long-polls can legitimately run for minutes
  server.headersTimeout = 60000;
  return server;
}
