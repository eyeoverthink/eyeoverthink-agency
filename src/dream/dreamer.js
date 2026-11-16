// Dreamer: idle-time consolidation. Clusters recent episodes, distills lessons into semantic memory,
// decays stale memories and graph edges, upgrades old embeddings, and keeps a signed dream journal
// (NNNN-dream-<kind>.md + .sig — the same sidecar format as the FRAYMUS dream corpus).
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso, cosine, hashEmbed, extractJson, truncate, errorMessage, canonical, slug } from '../core/util.js';

export class Dreamer {
  constructor({ cfg, store, router, memory, keyring, ledger, bus }) {
    Object.assign(this, { cfg, store, router, memory, keyring, ledger, bus });
    this.dir = path.join(cfg.home, 'dreams');
    fs.mkdirSync(this.dir, { recursive: true });
    this.running = false;
  }

  #cluster(rows, threshold = 0.62) {
    const vecs = rows.map((r) => {
      const e = r.embedding ? JSON.parse(r.embedding) : null;
      return e && r.embed_model === rows[0].embed_model ? e : hashEmbed(r.content, 384);
    });
    const clusters = [];
    rows.forEach((r, i) => {
      let best = null, bestSim = threshold;
      for (const c of clusters) {
        const s = cosine(vecs[i], vecs[c.seed]);
        if (s >= bestSim) { best = c; bestSim = s; }
      }
      if (best) best.members.push(i); else clusters.push({ seed: i, members: [i] });
    });
    return clusters.map((c) => c.members.map((i) => rows[i])).sort((a, b) => b.length - a.length);
  }

  async cycle({ force = false, signal } = {}) {
    if (this.running) return { skipped: 'already dreaming' };
    this.running = true;
    const stats = { episodes: 0, clusters: 0, lessons: 0, archived: 0, edgesPruned: 0, reembedded: 0, errors: [] };
    try {
      const since = this.store.kvGet('dream:last', '1970-01-01T00:00:00.000Z');
      const rows = this.store.all(`SELECT id, content, embedding, embed_model, importance, tags FROM memories
        WHERE kind = 'episodic' AND archived = 0 AND created > ? ORDER BY created ASC LIMIT 300`, since);
      stats.episodes = rows.length;
      const lessons = [];
      if (rows.length >= (force ? 1 : this.cfg.dream.minEpisodes)) {
        const clusters = this.#cluster(rows).slice(0, 5);
        stats.clusters = clusters.length;
        for (const cluster of clusters) {
          if (signal?.aborted) break;
          try {
            const res = await this.router.chat({ role: 'reason', json: true, temperature: 0.5, maxTokens: 800, signal,
              messages: [
                { role: 'system', content: 'You are the Dreamer. You compress experiences into durable, reusable lessons. Reply with JSON only.' },
                { role: 'user', content: `Episodes:\n${cluster.map((r) => `- ${truncate(r.content, 500)}`).join('\n')}\n\nReturn {"lessons": ["<standalone, reusable lesson>", ...up to 3], "idea": "<one speculative idea worth testing, or empty>"}` },
              ] });
            const parsed = extractJson(res.text) || {};
            for (const lesson of (parsed.lessons || []).slice(0, 3)) {
              const text = String(lesson).trim();
              if (text.length < 15) continue;
              await this.memory.write({ kind: 'semantic', content: text, tags: ['dream', 'lesson'], importance: Math.min(0.95, 0.5 + cluster.length * 0.08), agentId: 'dreamer', source: 'dream' });
              lessons.push(text);
            }
            if (parsed.idea && String(parsed.idea).trim().length > 15) {
              await this.memory.write({ kind: 'reflection', content: `Speculative idea (untested): ${String(parsed.idea).trim()}`, tags: ['dream', 'idea'], importance: 0.4, agentId: 'dreamer', source: 'dream' });
            }
          } catch (e) {
            if (signal?.aborted) break;
            stats.errors.push(errorMessage(e));
          }
          for (const r of cluster) this.store.run('UPDATE memories SET importance = importance * 0.8 WHERE id = ?', r.id);
        }
        stats.lessons = lessons.length;
      }

      // Decay: long-unused, low-importance memories are archived (not deleted — continuity is append-only).
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      stats.archived = Number(this.store.run(`UPDATE memories SET archived = 1 WHERE archived = 0 AND kind IN ('episodic','reflection')
        AND importance < 0.25 AND COALESCE(accessed, created) < ?`, cutoff).changes);
      this.store.run("UPDATE edges SET weight = weight * 0.98 WHERE rel != 'mentioned_in'");
      stats.edgesPruned = Number(this.store.run("DELETE FROM edges WHERE rel != 'mentioned_in' AND weight < 0.05").changes);

      // Embedding upgrade: re-embed memories made with an older/fallback model when a better one is served.
      const probe = await this.router.embed(['probe']);
      if (probe.model !== 'hash-384') {
        const stale = this.store.all('SELECT id, content FROM memories WHERE embed_model != ? AND archived = 0 LIMIT 64', probe.model);
        if (stale.length) {
          const { vectors, model } = await this.router.embed(stale.map((s) => s.content));
          if (model === probe.model) {
            stale.forEach((s, i) => this.store.run('UPDATE memories SET embedding = ?, embed_model = ? WHERE id = ?', vectors[i], model, s.id));
            stats.reembedded = stale.length;
          }
        }
      }

      this.store.kvSet('dream:last', nowIso());
      const kind = lessons.length ? 'consolidation' : 'maintenance';
      const summary = lessons.length ? lessons.map((l) => `- ${l}`).join('\n') : 'No new lessons; maintenance only.';
      const record = this.#journal(kind, summary, rows.map((r) => r.id), stats);
      this.bus?.publish('dream.complete', { id: record.id, kind, stats });
      return { ...record, stats, lessons };
    } finally {
      this.running = false;
    }
  }

  #journal(kind, summary, inputs, stats) {
    const id = newId('dr');
    const signer = this.keyring.get('agent-dreamer');
    const sig = signer.sign(canonical({ id, kind, summary, inputs, stats }));
    this.store.run('INSERT INTO dreams (id, kind, summary, inputs, stats, sig, created) VALUES (?, ?, ?, ?, ?, ?, ?)', id, kind, summary, inputs, stats, sig, nowIso());
    const n = this.store.get('SELECT COUNT(*) AS n FROM dreams').n;
    const file = path.join(this.dir, `${String(n).padStart(4, '0')}-dream-${slug(kind, 20)}.md`);
    fs.writeFileSync(file, `# Dream ${n}: ${kind}\n\n**Kind:** ${kind}\n**Dreamed:** ${nowIso()}\n**Inputs:** ${inputs.length} episodes\n**Stats:** ${JSON.stringify(stats)}\n\n${summary}\n\nSigned by Dreamer identity ${signer.fingerprint}\n`);
    this.keyring.signFile('agent-dreamer', file);
    this.ledger.append('dream', { id, kind, lessons: stats.lessons, file: path.basename(file) }, 'dreamer');
    return { id, kind, file };
  }

  list(limit = 30) {
    return this.store.all(`SELECT id, kind, summary, stats, created FROM dreams ORDER BY created DESC LIMIT ${Math.min(200, limit | 0)}`)
      .map((d) => ({ ...d, stats: JSON.parse(d.stats) }));
  }
}
