// Agent Forge (the full version of Agent Factory Lite): design single agents or whole team rosters from
// a description, validate them against the real tool registry, give each a genome, and register them.
import { extractJson, slug } from '../core/util.js';

const MODEL_ROLES = ['reason', 'code', 'fast', 'critic', 'continuity', 'plan'];

export class Forge {
  constructor({ router, agents, tools }) { Object.assign(this, { router, agents, tools }); }

  #toolMenu() { return this.tools.catalog().filter((t) => t.risk === 'safe').map((t) => `${t.name}: ${t.description}`).join('\n'); }

  #sanitize(spec, prefix = '') {
    const known = new Set(this.tools.catalog().map((t) => t.name));
    let id = slug(spec.id || spec.name || 'agent', 30).replace(/^[^a-z]+/, '');
    if (prefix && !id.startsWith(prefix)) id = `${prefix}_${id}`.slice(0, 40);
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(id)) id = `${prefix || 'forged'}_${Date.now().toString(36)}`;
    const tools = (Array.isArray(spec.tools) ? spec.tools : []).map(String).filter((t) => known.has(t)).slice(0, 6);
    const clamp01 = (x, d) => (Number.isFinite(+x) ? Math.min(1, Math.max(0, +x)) : d);
    return {
      id, name: String(spec.name || id).slice(0, 60), role: String(spec.role || 'Specialist').slice(0, 80),
      description: String(spec.description || spec.goal || '').slice(0, 400),
      modelRole: MODEL_ROLES.includes(spec.modelRole) ? spec.modelRole : 'reason',
      tools: tools.length ? tools : ['memory_search'],
      prompt: String(spec.prompt || `You are ${spec.name}, ${spec.role}. ${spec.goal || ''} ${spec.voice ? `Voice: ${spec.voice}` : ''}`).slice(0, 4000),
      traits: { temperature: clamp01(spec.temperature, 0.4), rigor: clamp01(spec.rigor, 0.6), creativity: clamp01(spec.creativity, 0.5), caution: clamp01(spec.caution, 0.5) },
    };
  }

  async design(description) {
    const res = await this.router.chat({ role: 'plan', json: true, temperature: 0.4, maxTokens: 1400, messages: [
      { role: 'system', content: 'You design AI agents. Reply with JSON only.' },
      { role: 'user', content: `Design one agent for: ${description}\n\nTools you may grant (choose 1-6, only from this list):\n${this.#toolMenu()}\n\nReturn {"id": "lowercase_id", "name": "...", "role": "...", "description": "...", "modelRole": "${MODEL_ROLES.join('|')}", "tools": [...], "prompt": "<second-person system prompt, specific and practical>", "temperature": 0..1, "rigor": 0..1, "creativity": 0..1, "caution": 0..1}` },
    ] });
    const spec = extractJson(res.text);
    if (!spec || typeof spec !== 'object') throw new Error('forge model did not return an agent spec');
    return this.#sanitize(spec);
  }

  async create(description) {
    this.agents.assertCanForge();
    const spec = await this.design(description);
    return this.agents.upsert({ ...spec, source: 'forged', meta: { forgedFrom: description.slice(0, 300) } });
  }

  /** Team roster for a business (Agent Factory flow). Returns specs; set commit=true to register them. */
  async roster({ business, model = 'Product studio', goal, count = 4, commit = false }) {
    const n = Math.min(8, Math.max(2, count | 0));
    const prefix = slug(business, 16);
    const res = await this.router.chat({ role: 'plan', json: true, temperature: 0.6, maxTokens: 2200, messages: [
      { role: 'system', content: 'You design compact, practical AI agent teams for small businesses. Reply with JSON only.' },
      { role: 'user', content: `Business: ${business}\nModel: ${model}\nGoal: ${goal}\nTeam size: exactly ${n}\n\nTools (choose from this list only):\n${this.#toolMenu()}\n\nReturn {"agents": [{"id","name","role","goal","tools":[...],"voice","modelRole","prompt"}]}. Roles must be distinct and practical.` },
    ] });
    const parsed = extractJson(res.text);
    const list = Array.isArray(parsed?.agents) ? parsed.agents.slice(0, n) : [];
    if (!list.length) throw new Error('forge model returned no agents');
    const specs = list.map((a) => this.#sanitize({ ...a, description: a.goal }, prefix));
    if (commit) {
      const room = 30 - this.agents.forgedCount();
      if (specs.length > room) throw new Error(`forge cap: room for ${room} more forged agents`);
      return specs.map((s) => this.agents.upsert({ ...s, source: 'forged', meta: { business } }));
    }
    return specs;
  }
}
