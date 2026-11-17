// HTTP API + SSE + static dashboard. Zero dependencies (node:http).
// Auth: Bearer <AGENCY_HOME/api-token> on /api/*. Public: /health, /mesh/*, /hooks/* (workflow key), /.well-known/agent.json.
import { edgeDoctor } from '../llm/edge-doctor.js';
import { issueReceipt } from '../core/receipt.js';
import { verifyReceipt } from '../core/receipt-verify.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { errorMessage, newId } from '../core/util.js';
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
  // Evolution runs for minutes on a local GPU, so it is a background job; progress arrives as evolution.* events.
  const evoOpts = (body) => ({ population: body.population || 4, repeats: body.repeats || 2, generations: body.generations || 1, confirm: body.confirm !== false,
    patience: body.patience ?? 2, adaptive: body.adaptive !== false, holdout: body.holdout !== false, holdoutRepeats: body.holdoutRepeats || 3, alpha: body.alpha ?? 0.1, maxConfirmRounds: body.maxConfirmRounds || 3 });
  add('POST', '/api/agents/:id/evolve', ({ params, body }) => a.evolution.start(params.id, evoOpts(body)));
  add('POST', '/api/evolution/fleet', ({ body }) => a.evolution.start(need(Array.isArray(body.agents) && body.agents.length ? body.agents : null, 'agents[] required'), evoOpts(body)));
  // A/A calibration: the same genome twice on identical seeds; the disagreement rate is the noise floor.
  add('POST', '/api/evolution/calibrate', ({ body }) => a.evolution.start(need(Array.isArray(body.agents) && body.agents.length ? body.agents : null, 'agents[] required'), { kind: 'calibrate', repeats: body.repeats || 3 }));
  // Red Queen exams: examiner proposes program-verified questions; frontier items join the agent's exam.
  add('POST', '/api/exams', ({ body }) => a.evolution.start(need(Array.isArray(body.agents) && body.agents.length ? body.agents : null, 'agents[] required'), { kind: 'exam', count: body.count || 6, repeats: body.repeats || 3 }));
  add('GET', '/api/agents/:id/exams', ({ params }) => a.examiner.list(params.id).map(({ program, ...r }) => ({ ...r, hasProgram: Boolean(program) })));
  add('GET', '/api/agents/:id/calibration', ({ params }) => a.evolution.calibration(params.id));
  add('GET', '/api/evolution/jobs', () => a.evolution.listJobs());
  add('GET', '/api/evolution/active', () => (a.evolution.active ? a.evolution.job(a.evolution.active) : null));
  add('GET', '/api/agents/:id/lineage', ({ params }) => a.evolution.lineage(params.id));
  add('GET', '/api/evolution/jobs/:id', ({ params }) => found(a.evolution.job(params.id), 'evolution job'));
  add('POST', '/api/evolution/jobs/:id/cancel', ({ params }) => ({ cancelled: a.evolution.cancel(params.id) }));
  add('GET', '/api/agents/:id/evolution', ({ params }) => a.evolution.history(params.id));
  add('GET', '/api/agents/:id/organism', ({ params }) => a.agents.exportOrganism(params.id, a.memory.playbook(params.id, 10).map((p) => p.content)));
  add('POST', '/api/organisms/import', ({ body }) => a.agents.importOrganism(need(body.plasmid, 'plasmid required')));
  add('POST', '/api/agents/import-manifests', ({ body }) => a.agents.importManifests(need(body.dirs, 'dirs required'), new Set(a.tools.catalog().map((t) => t.name))));
  add('POST', '/api/forge', async ({ body }) => a.forge.create(need(body.description, 'description required')));
  add('POST', '/api/forge/roster', async ({ body }) => a.forge.roster({ business: need(body.business, 'business required'), model: body.model, goal: need(body.goal, 'goal required'), count: body.count, commit: Boolean(body.commit) }));

  // ---------- missions ----------
  add('GET', '/api/missions', ({ url }) => a.missions.list({ limit: +url.searchParams.get('limit') || 50, status: url.searchParams.get('status') }));
  add('POST', '/api/missions', ({ body }) => a.missions.create(need(body.goal, 'goal required'), body));
  // Proof-carrying output: a mission receipt anyone can verify offline (bin/verify-receipt.js).
  add('GET', '/api/missions/:id/receipt', ({ params, url }) => issueReceipt(a, params.id, { includeGoal: url.searchParams.get('goal') === '1' }));
  add('POST', '/api/receipts/verify', async ({ body }) => verifyReceipt(need(body.receipt, 'receipt required'), { deliverable: body.deliverable ?? null }));
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
  // A direct dashboard call (not routed by the agency) reports its metadata so the ledger proves it ran. No text is sent.
  add('POST', '/api/edge/attest', ({ body }) => ({ entry: a.edge.attest({ ...body, origin: 'playground', job: null, missionId: null, worker: null }) }));
  add('GET', '/api/edge/doctor', () => edgeDoctor({ root: ROOT }));

  // ---------- Privacy Membrane ----------
  // Seal sessions live only in this process (the value map never leaves the server), expiring after 15 minutes.
  const sealSessions = new Map();
  const sweep = () => { const cut = Date.now() - 15 * 60 * 1000; for (const [k, v] of sealSessions) if (v.at < cut) sealSessions.delete(k); };
  const mask = (v) => (v.length <= 4 ? '•'.repeat(v.length) : `${v.slice(0, 2)}${'•'.repeat(Math.min(8, v.length - 4))}${v.slice(-2)}`);
  const sealView = (s) => ({ ner: s.ner, withheld: { ...s.session.counts }, total: s.session.size, items: s.session.values().map((v) => ({ type: v.type, placeholder: s.session.placeholder(v.type, v.value), preview: mask(v.value), tag: a.membrane.tag(v.value) })) });
  add('POST', '/api/membrane/preview', async ({ body }) => {
    const r = await a.membrane.sealMessages([{ role: 'user', content: need(body.text, 'text required') }], { useNer: body.ner !== false, strict: false });
    return { sealed: r.messages.at(-1).content, ...sealView(r) };
  });
  add('POST', '/api/membrane/seal', async ({ body }) => {
    sweep();
    const r = await a.membrane.sealMessages(Array.isArray(body.messages) ? body.messages : [{ role: 'user', content: need(body.text, 'text or messages required') }], { useNer: body.ner !== false });
    const id = newId('seal');
    sealSessions.set(id, { ...r, at: Date.now() });
    return { sessionId: id, messages: r.messages, ...sealView(r) };
  });
  add('POST', '/api/membrane/unseal', ({ body }) => {
    const s = found(sealSessions.get(body.sessionId), 'seal session');
    sealSessions.delete(body.sessionId); // one reply per session
    a.membrane.record({ session: s.session, payload: s.payload, provider: String(body.provider || 'firebase-ai-logic').slice(0, 40), model: String(body.model || '').slice(0, 60), origin: 'playground' });
    return { text: s.session.unseal(String(body.text ?? '')) };
  });
  add('GET', '/api/membrane/terms', () => a.membrane.terms());
  add('POST', '/api/membrane/terms', ({ body }) => a.membrane.setTerms(Array.isArray(body.terms) ? body.terms : []));
  // Sovereignty map: what stayed on this machine and what crossed the boundary, from the signed ledger.
  add('GET', '/api/sovereignty', () => {
    const count = (kind) => a.store.get('SELECT COUNT(*) AS n FROM ledger WHERE kind = ?', kind).n;
    const fire = a.store.all("SELECT data FROM ledger WHERE kind = 'edge.inference'").map((r) => JSON.parse(r.data));
    const cross = a.store.all("SELECT data FROM ledger WHERE kind = 'membrane.crossing'").map((r) => JSON.parse(r.data));
    const withheld = {};
    for (const c of cross) for (const [k, v] of Object.entries(c.withheld || {})) withheld[k] = (withheld[k] || 0) + v;
    const byModel = a.router.usage.byModel;
    const local = Object.entries(byModel).filter(([k]) => k.startsWith('ollama:') && !k.endsWith('-cloud')).reduce((s, [, v]) => s + v.calls, 0);
    return {
      ledger: a.store.get('SELECT COUNT(*) AS n FROM ledger').n,
      agents: a.agents.list().map((x) => ({ id: x.id, name: x.name, genome: x.genome, modelRole: x.modelRole })),
      firebase: { total: fire.length, inCloud: fire.filter((f) => f.inferenceSource === 'IN_CLOUD').length, onDevice: fire.filter((f) => f.inferenceSource === 'ON_DEVICE').length, overflow: fire.filter((f) => f.origin === 'agency-job').length },
      membrane: { crossings: cross.length, withheld, valuesWithheld: cross.reduce((s, c) => s + (c.total || 0), 0), egressBlocked: count('membrane.egress_blocked') },
      session: { localCalls: local, overflow: a.router.usage.edgeOverflow || 0, calls: a.router.usage.calls },
      gpu: { active: a.router.gpu.active, queued: a.router.gpu.queue.length },
      edgeWorkers: a.edge.liveWorkers().length,
      receipts: count('receipt.issue'),
    };
  });
  add('GET', '/api/membrane/crossings', ({ url }) => a.ledger.list({ limit: Math.min(100, +url.searchParams.get('limit') || 30), kind: 'membrane.crossing' }));
  add('GET', '/api/edge/proof', ({ url }) => {
    const entries = a.ledger.list({ limit: Math.min(200, +url.searchParams.get('limit') || 50), kind: 'edge.inference' });
    const by = (k) => entries.filter((e) => e.data.inferenceSource === k).length;
    return { total: entries.length, onDevice: by('ON_DEVICE'), inCloud: by('IN_CLOUD'), ledger: a.ledger.verify(), entries };
  });

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
