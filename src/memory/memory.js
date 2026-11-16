// Vertiso memory: tiered, signed, hybrid-recall memory with an entity graph.
//   kinds: episodic (what happened), semantic (consolidated knowledge), fact, playbook (proven
//          patterns injected into agent prompts), governance (owner laws, always injected), reflection
// Recall score = 0.55·vector + 0.25·keyword(BM25) + 0.1·importance + 0.1·recency, plus a graph boost
// for memories that share entities with the query.
import { newId, sha256, nowIso, cosine, hashEmbed, extractEntities, clamp, truncate } from '../core/util.js';

export const MEMORY_KINDS = ['episodic', 'semantic', 'fact', 'playbook', 'governance', 'reflection'];

export class Memory {
  constructor({ store, router, keyring, ledger, bus }) {
    this.store = store;
    this.router = router;
    this.keyring = keyring;
    this.ledger = ledger;
    this.bus = bus;
  }

  /** Write a memory. Duplicate content (same kind+content hash) bumps importance instead of duplicating. */
  async write({ content, kind = 'episodic', agentId = null, scope = 'agency', tags = [], importance = 0.5, source = null }) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('memory content is empty');
    if (!MEMORY_KINDS.includes(kind)) throw new Error(`unknown memory kind: ${kind}`);
    const hash = sha256(`${kind}\n${text}`);
    const existing = this.store.get('SELECT id, importance FROM memories WHERE hash = ?', hash);
    if (existing) {
      const imp = clamp(existing.importance + 0.1, 0, 1);
      this.store.run('UPDATE memories SET importance = ?, archived = 0, accessed = ? WHERE id = ?', imp, nowIso(), existing.id);
      return { id: existing.id, deduplicated: true };
    }
    const { model, vectors } = await this.router.embed([text]);
    const id = newId('mem');
    const signer = this.#signer(agentId);
    const sig = signer.sign(hash);
    const tagList = Array.isArray(tags) ? tags.map(String).slice(0, 12) : [];
    this.store.tx(() => {
      this.store.run(`INSERT INTO memories (id, agent_id, scope, kind, content, tags, importance, embedding, embed_model, source, hash, sig, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, agentId, scope, kind, text, tagList, clamp(importance, 0, 1), vectors[0], model, source, hash, sig, nowIso());
      this.#linkEntities(id, text);
    });
    this.ledger?.append('memory.write', { id, kind, hash, agentId }, agentId || 'agency');
    this.bus?.publish('memory.write', { id, kind, agentId, preview: truncate(text, 140) });
    return { id, deduplicated: false };
  }

  /** Entity graph: co-occurring entities are connected; each entity also points at the memory. */
  #linkEntities(memoryId, text) {
    const ents = extractEntities(text, 8);
    const now = nowIso();
    const upsert = (src, rel, dst, w) => this.store.run(
      `INSERT INTO edges (id, src, rel, dst, weight, memory_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src, rel, dst) DO UPDATE SET weight = weight + excluded.weight, updated = excluded.updated`,
      newId('ed'), src, rel, dst, w, memoryId, now, now);
    for (const e of ents) upsert(e, 'mentioned_in', memoryId, 1);
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < Math.min(ents.length, i + 4); j++) upsert(ents[i], 'related_to', ents[j], 0.5);
    }
  }

  /** Explicit relation (used by agents through the graph_link tool). */
  link(src, rel, dst, weight = 1) {
    const now = nowIso();
    this.store.run(`INSERT INTO edges (id, src, rel, dst, weight, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(src, rel, dst) DO UPDATE SET weight = weight + excluded.weight, updated = excluded.updated`,
    newId('ed'), String(src).toLowerCase(), String(rel).toLowerCase(), String(dst).toLowerCase(), weight, now, now);
  }

  neighbors(entity, limit = 20) {
    const e = String(entity).toLowerCase();
    return this.store.all(`SELECT src, rel, dst, weight FROM edges WHERE (src = ? OR dst = ?) AND rel != 'mentioned_in'
      ORDER BY weight DESC LIMIT ${Math.min(200, limit | 0)}`, e, e);
  }

  graph(limit = 300) {
    const edges = this.store.all(`SELECT src, rel, dst, weight FROM edges WHERE rel != 'mentioned_in' ORDER BY weight DESC LIMIT ${Math.min(2000, limit | 0)}`);
    const nodes = new Map();
    for (const e of edges) {
      nodes.set(e.src, (nodes.get(e.src) || 0) + e.weight);
      nodes.set(e.dst, (nodes.get(e.dst) || 0) + e.weight);
    }
    return { nodes: [...nodes].map(([id, w]) => ({ id, weight: w })), edges };
  }

  /** Hybrid recall. Returns [{id, kind, content, score, ...}] sorted by score. */
  async recall(query, { k = 6, kinds = null, agentId = null, minScore = 0.12, includeArchived = false } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const kindFilter = kinds?.length ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    const params = kinds?.length ? kinds : [];
    const rows = this.store.all(`SELECT rowid, id, agent_id, kind, content, tags, importance, embedding, embed_model, created, access_count
      FROM memories WHERE (archived = 0 OR ?) ${kindFilter} AND (agent_id IS NULL OR ? IS NULL OR agent_id = ?)
      ORDER BY created DESC LIMIT 4000`, includeArchived ? 1 : 0, ...params, agentId, agentId);
    if (rows.length === 0) return [];

    const { model, vectors } = await this.router.embed([q]);
    const qVec = vectors[0];
    const qHash = model === 'hash-384' ? qVec : hashEmbed(q, 384);

    // Keyword relevance via FTS5 BM25 (lower bm25 is better; normalize to 0..1).
    const kw = new Map();
    const ftsQuery = q.toLowerCase().match(/[a-z0-9]{3,}/g)?.slice(0, 12).map((t) => `"${t}"`).join(' OR ');
    if (ftsQuery) {
      try {
        const hits = this.store.all(`SELECT rowid, bm25(memories_fts) AS s FROM memories_fts WHERE memories_fts MATCH ? ORDER BY s LIMIT 200`, ftsQuery);
        if (hits.length) {
          const best = Math.min(...hits.map((h) => h.s)), worst = Math.max(...hits.map((h) => h.s));
          for (const h of hits) kw.set(h.rowid, worst === best ? 1 : (worst - h.s) / (worst - best));
        }
      } catch { /* malformed FTS query: ignore keyword channel */ }
    }

    const qEnts = new Set(extractEntities(q, 8));
    const graphBoost = new Map();
    if (qEnts.size) {
      const ph = [...qEnts].map(() => '?').join(',');
      for (const r of this.store.all(`SELECT dst AS id, SUM(weight) AS w FROM edges WHERE rel = 'mentioned_in' AND src IN (${ph}) GROUP BY dst`, ...qEnts)) {
        graphBoost.set(r.id, Math.min(1, r.w / 3));
      }
    }

    const now = Date.now();
    const scored = rows.map((r) => {
      let vec = 0;
      const emb = r.embedding ? JSON.parse(r.embedding) : null;
      if (emb) vec = r.embed_model === model ? cosine(qVec, emb) : (r.embed_model === 'hash-384' ? cosine(qHash, emb) : 0);
      const ageDays = (now - Date.parse(r.created)) / 86400000;
      const recency = Math.exp(-ageDays / 30);
      const score = 0.55 * Math.max(0, vec) + 0.25 * (kw.get(r.rowid) || 0) + 0.1 * r.importance + 0.1 * recency + 0.15 * (graphBoost.get(r.id) || 0);
      return { id: r.id, kind: r.kind, agentId: r.agent_id, content: r.content, tags: JSON.parse(r.tags), importance: r.importance, created: r.created, score: Math.round(score * 1000) / 1000 };
    }).filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score).slice(0, k);

    if (scored.length) {
      const ph = scored.map(() => '?').join(',');
      this.store.run(`UPDATE memories SET access_count = access_count + 1, accessed = ? WHERE id IN (${ph})`, nowIso(), ...scored.map((s) => s.id));
    }
    return scored;
  }

  /** Governance memories (owner laws) are always injected, newest first. */
  governance(limit = 8) {
    return this.store.all(`SELECT id, content FROM memories WHERE kind = 'governance' AND archived = 0 ORDER BY importance DESC, created DESC LIMIT ${limit | 0}`);
  }

  playbook(agentId, limit = 5) {
    return this.store.all(`SELECT id, content, importance FROM memories WHERE kind = 'playbook' AND archived = 0
      AND (agent_id = ? OR agent_id IS NULL) ORDER BY importance DESC, created DESC LIMIT ${limit | 0}`, agentId);
  }

  /** Context pack for prompts: governance laws + playbook + recalled memories, bounded in characters. */
  async contextPack(query, { agentId = null, k = 5, maxChars = 3500 } = {}) {
    const parts = [];
    const gov = this.governance();
    if (gov.length) parts.push('## Owner laws (always follow)\n' + gov.map((g) => `- ${g.content}`).join('\n'));
    if (agentId) {
      const pb = this.playbook(agentId);
      if (pb.length) parts.push('## Proven patterns (from your past verified work)\n' + pb.map((p) => `- ${p.content}`).join('\n'));
    }
    // Automatic injection uses a stricter floor than explicit search: weakly related memories distract small models.
    const recalled = await this.recall(query, { k, kinds: ['semantic', 'fact', 'episodic', 'reflection'], minScore: 0.3 });
    if (recalled.length) parts.push('## Relevant memory\n' + recalled.map((r) => `- [${r.kind} ${r.id}] ${truncate(r.content, 500)}`).join('\n'));
    let text = parts.join('\n\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…';
    return { text, recalled };
  }

  list({ kind = null, limit = 50, offset = 0, q = null } = {}) {
    const lim = Math.min(500, Math.max(1, limit | 0));
    const off = Math.max(0, offset | 0);
    if (q) {
      return this.store.all(`SELECT m.id, m.agent_id, m.kind, m.content, m.tags, m.importance, m.created, m.access_count, m.archived
        FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND (? IS NULL OR m.kind = ?)
        ORDER BY bm25(memories_fts) LIMIT ${lim} OFFSET ${off}`, q.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).map((t) => `"${t}"`).join(' OR ') || '""', kind, kind);
    }
    return this.store.all(`SELECT id, agent_id, kind, content, tags, importance, created, access_count, archived FROM memories
      WHERE (? IS NULL OR kind = ?) ORDER BY created DESC LIMIT ${lim} OFFSET ${off}`, kind, kind);
  }

  get(id) { return this.store.get('SELECT * FROM memories WHERE id = ?', id); }

  verify(id) {
    const m = this.get(id);
    if (!m) return { ok: false, reason: 'not found' };
    if (sha256(`${m.kind}\n${m.content}`) !== m.hash) return { ok: false, reason: 'content altered (hash mismatch)' };
    const signer = this.#signer(m.agent_id);
    return { ok: signer.verify(m.hash, m.sig), signer: signer.id };
  }

  #signer(agentId) {
    const key = agentId ? `agent-${agentId}` : null;
    return this.keyring.get(key && this.keyring.has(key) ? key : 'agency');
  }

  archive(id) { this.store.run('UPDATE memories SET archived = 1 WHERE id = ?', id); }

  stats() {
    const byKind = this.store.all('SELECT kind, COUNT(*) AS n, SUM(archived) AS archived FROM memories GROUP BY kind');
    const edges = this.store.get("SELECT COUNT(*) AS n FROM edges WHERE rel != 'mentioned_in'").n;
    const entities = this.store.get('SELECT COUNT(DISTINCT src) AS n FROM edges').n;
    return { byKind, edges, entities };
  }
}
