// Agent registry: persistence, seeding, manifest import, and organism (plasmid) export/import.
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../core/util.js';
import { traitsToGenome, genomeToTraits, validateGenome, DEFAULT_TRAITS, buildPlasmid, openPlasmid, toFasta, encodeCodon } from '../core/dna.js';
import { verifyWith } from '../core/identity.js';
import { CORE_AGENTS, parseManifest, TOOL_ALIASES } from './roster.js';

const MAX_FORGED = 30; // hard cap: an unbounded forge produced 3,000+ near-duplicate agents in Chandra

export class AgentRegistry {
  constructor({ store, keyring, ledger, bus }) {
    this.store = store;
    this.keyring = keyring;
    this.ledger = ledger;
    this.bus = bus;
  }

  #row(r) {
    if (!r) return null;
    const traits = { ...DEFAULT_TRAITS, ...genomeToTraits(r.genome) };
    return {
      id: r.id, name: r.name, role: r.role, description: r.description, modelRole: r.model_role,
      tools: JSON.parse(r.tools), systemPrompt: r.system_prompt, genome: r.genome, traits,
      meta: JSON.parse(r.traits || '{}'), source: r.source, generation: r.generation, fitness: r.fitness, runs: r.runs,
      enabled: Boolean(r.enabled), publicKey: r.public_key, created: r.created, updated: r.updated,
    };
  }

  get(id) { return this.#row(this.store.get('SELECT * FROM agents WHERE id = ?', id)); }
  list({ includeDisabled = false } = {}) {
    return this.store.all(`SELECT * FROM agents ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY source = 'builtin' DESC, name ASC LIMIT 500`).map((r) => this.#row(r));
  }

  upsert({ id, name, role, description = '', modelRole = 'reason', tools = [], prompt, traits = {}, genome = null, source = 'custom', meta = {} }) {
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(id)) throw new Error(`invalid agent id "${id}" (lowercase, starts with a letter, a-z0-9_-)`);
    if (!prompt || !name || !role) throw new Error('agent needs name, role and prompt');
    const g = genome && validateGenome(genome) ? genome : traitsToGenome({ ...DEFAULT_TRAITS, ...traits });
    const now = nowIso();
    const pub = this.keyring.get(`agent-${id}`).publicHex;
    const existing = this.store.get('SELECT id FROM agents WHERE id = ?', id);
    if (existing) {
      this.store.run(`UPDATE agents SET name=?, role=?, description=?, model_role=?, tools=?, system_prompt=?, genome=?, traits=?, source=?, updated=? WHERE id=?`,
        name, role, description, modelRole, tools, prompt, g, meta, source, now, id);
    } else {
      this.store.run(`INSERT INTO agents (id, name, role, description, model_role, tools, system_prompt, genome, traits, source, public_key, created, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, name, role, description, modelRole, tools, prompt, g, meta, source, pub, now, now);
    }
    this.ledger.append(existing ? 'agent.update' : 'agent.create', { id, source, genome: g }, 'agency');
    this.bus?.publish('agent.upsert', { id, name, source });
    return this.get(id);
  }

  setEnabled(id, enabled) {
    this.store.run('UPDATE agents SET enabled = ?, updated = ? WHERE id = ?', enabled ? 1 : 0, nowIso(), id);
    return this.get(id);
  }

  remove(id) {
    const a = this.get(id);
    if (!a) return false;
    if (a.source === 'builtin') throw new Error('builtin agents can be disabled, not deleted');
    this.store.run('DELETE FROM agents WHERE id = ?', id);
    this.ledger.append('agent.delete', { id }, 'agency');
    return true;
  }

  setGenome(id, genome, { generation, fitness } = {}) {
    if (!validateGenome(genome)) throw new Error('invalid genome');
    this.store.run('UPDATE agents SET genome = ?, generation = COALESCE(?, generation), fitness = COALESCE(?, fitness), updated = ? WHERE id = ?',
      genome, generation ?? null, fitness ?? null, nowIso(), id);
  }

  recordRun(id, score) {
    // Exponential moving average of critic scores = the agent's observed fitness.
    const a = this.store.get('SELECT fitness, runs FROM agents WHERE id = ?', id);
    if (!a) return;
    const f = a.fitness == null ? score : a.fitness * 0.8 + score * 0.2;
    this.store.run('UPDATE agents SET fitness = ?, runs = runs + 1 WHERE id = ?', Math.round(f * 1000) / 1000, id);
  }

  seed(knownTools = null) {
    for (const a of CORE_AGENTS) {
      const existing = this.store.get('SELECT genome FROM agents WHERE id = ?', a.id);
      if (existing) continue; // never clobber an evolved genome
      this.upsert({ ...a, tools: knownTools ? a.tools.filter((t) => knownTools.has(t)) : a.tools, source: 'builtin' });
    }
  }

  /** Import every *.md manifest from the given directories. Existing agents are updated, never duplicated. */
  importManifests(dirs, knownTools) {
    const results = { imported: [], skipped: [] };
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) { results.skipped.push({ dir, reason: 'not found' }); continue; }
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        try {
          const m = parseManifest(fs.readFileSync(path.join(dir, f), 'utf8'), path.basename(f, '.md'));
          const builtin = this.store.get("SELECT id FROM agents WHERE id = ? AND source = 'builtin'", m.id);
          if (builtin) { results.skipped.push({ file: f, reason: 'id collides with a builtin agent' }); continue; }
          const tools = [...new Set(m.tools.includes('*') ? ['memory_search', 'memory_save', 'web_search'] : m.tools.map((t) => TOOL_ALIASES[t] || t))]
            .filter((t) => knownTools.has(t));
          const modelRole = /code|engineer|java|wasm|dev/i.test(m.role) ? 'code' : /continu|archiv|context|memory/i.test(m.role) ? 'continuity' : 'reason';
          this.upsert({ id: m.id, name: m.name, role: m.role, description: m.description, modelRole, tools, prompt: m.prompt, source: `manifest:${path.basename(dir)}`, meta: { file: f, model: m.model } });
          results.imported.push(m.id);
        } catch (e) {
          results.skipped.push({ file: f, reason: e.message });
        }
      }
    }
    return results;
  }

  forgedCount() { return this.store.get("SELECT COUNT(*) AS n FROM agents WHERE source = 'forged'").n; }
  assertCanForge() { if (this.forgedCount() >= MAX_FORGED) throw new Error(`forge cap reached (${MAX_FORGED}); retire a forged agent first`); }

  /** Organism: an agent (manifest + genome + playbook) as a signed plasmid, portable to another agency. */
  exportOrganism(id, playbook = []) {
    const a = this.get(id);
    if (!a) throw new Error(`agent ${id} not found`);
    const manifest = { id: a.id, name: a.name, role: a.role, description: a.description, modelRole: a.modelRole, tools: a.tools, prompt: a.systemPrompt, generation: a.generation, fitness: a.fitness };
    const plasmid = buildPlasmid(`organism:${a.id}`, {
      'manifest.json': manifest, 'genome.fasta': toFasta(a.id, a.genome, { gen: a.generation, fitness: a.fitness ?? 'na' }),
      'genome.codon': encodeCodon(a.genome), 'playbook.json': playbook,
    }, this.keyring.get('agency'));
    return { organism: a.id, plasmid };
  }

  importOrganism(plasmid, { trustSigner = null } = {}) {
    const opened = openPlasmid(plasmid, verifyWith);
    if (trustSigner && plasmid.signer !== trustSigner) throw new Error('organism signer is not the trusted peer');
    const manifest = JSON.parse(opened.parts['manifest.json'].toString('utf8'));
    const fasta = opened.parts['genome.fasta'].toString('utf8');
    const genome = fasta.split('\n').slice(1).join('').trim();
    const agent = this.upsert({ id: manifest.id, name: manifest.name, role: manifest.role, description: manifest.description, modelRole: manifest.modelRole, tools: manifest.tools, prompt: manifest.prompt, genome, source: 'organism', meta: { signer: plasmid.signer } });
    const playbook = opened.parts['playbook.json'] ? JSON.parse(opened.parts['playbook.json'].toString('utf8')) : [];
    return { agent, playbook };
  }
}
