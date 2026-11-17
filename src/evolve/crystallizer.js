// Crystallization: the agency keeps what the models figure out.
//
// Most AI products rent intelligence per call: nothing the model works out is retained, and a model swap leaves the
// product exactly as capable as before. Crystallization turns a solved task into a SKILL, a pure function the agency
// owns, verifies, signs and can call without any model:
//   extract : a local model distills a solved task into `function main(input) { ... }` + description + input schema.
//   verify  : differential testing. A DIFFERENT model sees only the description and schema (never the code) and writes
//             edge-case inputs AND its own reference implementation; both run in the permission-locked sandbox and must
//             agree on every input. On disagreement a third blind implementation decides (2 of 3). Measured in Phase 8:
//             a model-written program is not trustworthy because it runs; independent agreement is what catches errors.
//   admit   : the skill is ledgered (code hash + provenance) and registered as a tool `skill_<name>` agents can call.
//             Skills may call earlier skills (the library is injected), so capability compounds.
//   measure : uses, failures, and model calls avoided: the curve that shows the system, not the model, improving.
import { newId, nowIso, sha256 } from '../core/util.js';
import { runSandboxedJs } from '../tools/builtin.js';

const NAME = /^[a-z][a-z0-9_]{2,39}$/;

/** Deep equality with numeric tolerance, for comparing two implementations' outputs. */
export function sameOutput(a, b) {
  // Independent implementations wrap the same value differently ({"averageSpeed": 0} vs 0); compare the value.
  // Measured: a correct harmonic-mean skill lost a tie-break on exactly this.
  const unwrap = (v) => { while (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1) v = v[Object.keys(v)[0]]; return v; };
  a = unwrap(a); b = unwrap(b);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameOutput(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameOutput(a[k], b[k]));
  }
  return a === b;
}

const STOP = new Set('the and for with that this from into what which when then than are was were has have had its his her their them they you your our who how why per each all any but not can will would should could does did done get gets got use used using one two after before about over under then also only just very more most much many some such same other another final answer task compute calculate find give return value result total number amount'.split(' '));
const NUM = /(?<![\w.])-?\d+(?:\.\d+)?/g; // "2026-11" is 2026 and 11, not -11
/** Content words, lightly stemmed, for the no-model prefilter. */
export function words(text) {
  return String(text).toLowerCase().replace(/%/g, ' percent percentage ').match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)).map((w) => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length >= 3) || [];
}

/**
 * Why a bound input cannot be trusted, or null. Every number and string must appear literally in the task (a binder
 * may not invent, convert or rescale values: "12%" stays 12, never 0.12), and the schema's required keys and types hold.
 */
export function groundingProblem(input, schema, task) {
  const taskNums = new Set((String(task).match(NUM) || []).map(Number));
  // A percentage may be passed as a decimal ONLY when the skill's verified contract declares it ("rate as a decimal")
  // and the task literally states that percentage. Measured: a learned discount skill takes 0.12 for 12%, and a
  // no-conversion rule rejected every correct binding to it.
  const pcts = new Set([...String(task).matchAll(/(-?\d+(?:\.\d+)?)\s*(?:%|percent)/gi)].map((m) => Number(m[1])));
  const declaresDecimal = (path) => { const p = schema?.properties?.[path.split(/[.[]/)[0]]; return /\b(decimal|fraction)\b/i.test(`${p?.description || ''} ${p?.items?.description || ''}`); };
  const lower = String(task).toLowerCase();
  const leaves = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    else leaves.push([path, v]);
  };
  walk(input, '');
  for (const [path, v] of leaves) {
    if (typeof v === 'number' && !taskNums.has(v) && !(declaresDecimal(path) && pcts.has(Math.round(v * 100 * 1e9) / 1e9))) return `${path} = ${v} does not appear in the task`;
    if (typeof v === 'string' && v.trim() && !lower.includes(v.toLowerCase())) return `${path} = "${v.slice(0, 40)}" does not appear in the task`;
  }
  for (const k of schema?.required || []) if (!(k in input)) return `required input ${k} is missing`;
  for (const [k, p] of Object.entries(schema?.properties || {})) {
    if (!(k in input) || !p?.type) continue;
    const v = input[k];
    const ok = p.type === 'number' || p.type === 'integer' ? typeof v === 'number' : p.type === 'array' ? Array.isArray(v) : p.type === 'string' ? typeof v === 'string' : p.type === 'boolean' ? typeof v === 'boolean' : p.type === 'object' ? v && typeof v === 'object' : true;
    if (!ok) return `${k} should be ${p.type}`;
  }
  return null;
}

const parseJson = (text) => { try { return JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return {}; } };

export class Crystallizer {
  constructor({ store, router, tools, missions, ledger, bus, cfg = null, sandbox = runSandboxedJs }) {
    Object.assign(this, { store, router, tools, missions, ledger, bus, cfg, sandbox });
  }

  list(status = null) {
    return this.store.all(`SELECT * FROM skills ${status ? 'WHERE status = ?' : ''} ORDER BY created`, ...(status ? [status] : []))
      .map((r) => ({ ...r, params: JSON.parse(r.params), verification: JSON.parse(r.verification || '{}') }));
  }

  /** Source for a sandbox run: the skill library (so skills compose), the candidate, and one input. */
  #program(code, input, library) {
    const lib = library.map((s) => `const skill_${s.name} = (() => { ${s.code}\n return main; })();`).join('\n');
    return `${lib}\n${code}\nconst __out = main(${JSON.stringify(input)});\nconsole.log(JSON.stringify({ out: __out === undefined ? null : __out }));`;
  }

  async #run(code, input, library) {
    const r = await this.sandbox(this.#program(code, input, library), { timeoutMs: 5000 });
    if (r.exitCode !== 0 || r.timedOut) return { error: (r.stderr || 'failed').split('\n')[0].slice(0, 160) };
    const line = String(r.stdout).trim().split(/\r?\n/).at(-1);
    try { return { out: JSON.parse(line).out }; } catch { return { error: 'no JSON output' }; }
  }

  /** Run an admitted skill (the tool body). Counts uses and failures. */
  async invoke(name, input) {
    const s = this.store.get("SELECT * FROM skills WHERE name = ? AND status = 'active'", name);
    if (!s) throw new Error(`no active skill ${name}`);
    const library = this.list('active').filter((x) => x.name !== name);
    const r = await this.#run(s.code, input, library);
    this.store.run(`UPDATE skills SET ${r.error ? 'failures = failures + 1' : 'uses = uses + 1'}, updated = ? WHERE id = ?`, nowIso(), s.id);
    if (r.error) throw new Error(`skill ${name} failed: ${r.error}`);
    return r.out;
  }

  #register(skill) {
    if (this.tools.tools?.has(`skill_${skill.name}`)) return;
    this.tools.register({
      name: `skill_${skill.name}`,
      description: `[crystallized skill] ${skill.description} Runs verified code locally with no model call.`,
      params: { type: 'object', required: ['input'], properties: { input: skill.params } },
      timeoutMs: 8000,
      run: async ({ input }) => ({ result: await this.invoke(skill.name, input), skill: skill.name, codeSha256: skill.code_sha256 }),
    });
  }

  /** Register every active skill as a tool (called at boot). */
  load() { for (const s of this.list('active')) this.#register(s); return this.list('active').length; }

  /** Context for extraction from a completed mission: goal, deliverable, and the code its agents actually ran. */
  missionSource(missionId) {
    const m = this.missions.get(missionId);
    if (!m || m.status !== 'completed') throw new Error(`mission ${missionId} is not completed`);
    const code = this.store.all("SELECT data FROM ledger WHERE kind = 'tool.call'").map((r) => JSON.parse(r.data)).filter((d) => d.missionId === missionId).length;
    return { kind: 'mission', ref: missionId, text: `Goal: ${m.goal}\n\nVerified deliverable:\n${String(m.result.deliverable).slice(0, 4000)}\n\n(${code} tool call(s) were used.)` };
  }

  /**
   * Crystallize one skill from a solved task. source: { kind, ref, text }.
   * Returns { admitted, skill?, reason, verification }.
   */
  async crystallize(source, { tests = 6, signal } = {}) {
    const library = this.list('active');
    const ex = await this.router.chat({
      role: 'code', privacy: 'private', json: true, temperature: 0.2, maxTokens: 1600, signal,
      messages: [
        { role: 'system', content: 'You turn a solved task into ONE reusable, general, pure JavaScript function so that next time this KIND of task can be solved by code instead of a language model. The function must be named main, take a single JSON input object, return a JSON-serializable value, and use no I/O, network, randomness or dates. Reply with JSON only.' },
        { role: 'user', content: `${source.text}\n\nExisting skills you may call (as skill_<name>(input)): ${library.map((s) => `skill_${s.name}: ${s.description}`).join('; ') || 'none'}\n\nReturn {"name":"snake_case_name","description":"what it computes, in one sentence","params":{"type":"object","properties":{...},"required":[...]},"code":"function main(input) { ... }"} or {"none":true} if no reusable computation exists.` },
      ],
    });
    const cand = parseJson(ex.text);
    const fail = (reason, verification = {}) => {
      this.ledger.append('skill.reject', { source: `${source.kind}:${source.ref}`, name: cand?.name || null, reason }, 'crystallizer');
      this.bus?.publish('skill.reject', { name: cand?.name || null, reason });
      return { admitted: false, reason, verification };
    };
    if (cand.none) return fail('no reusable computation in this task');
    const name = String(cand.name || '').toLowerCase();
    if (!NAME.test(name) || !String(cand.code || '').includes('function main') || !cand.params || typeof cand.params !== 'object') return fail('malformed skill proposal');
    if (this.store.get('SELECT id FROM skills WHERE name = ?', name)) return fail(`a skill named ${name} already exists`);

    // Independent reference: a different role sees only the description and schema, never the candidate's code.
    // The reference sees the solved task (ground truth) plus description and schema, but never the candidate's code.
    // Measured: with description + parameter names alone, a reference misread "speed_to/speed_from" and a correct
    // harmonic-mean skill was rejected. The task text is what both implementations should be derived from.
    const spec = `Function: ${cand.description}\nInput schema: ${JSON.stringify(cand.params)}\nThe solved task it generalizes (use it to understand the meaning, then implement the general function):\n${String(source.text).slice(0, 2500)}`;
    const ref = await this.#reference(spec, 'reason', tests, signal);
    if (ref.error) return fail(`reference failed: ${ref.error}`);
    const inputs = ref.inputs.slice(0, tests);
    if (inputs.length < 3) return fail('too few test inputs');

    const rows = [];
    for (const input of inputs) {
      const [c, r] = await Promise.all([this.#run(cand.code, input, library), this.#run(ref.code, input, library)]);
      rows.push({ input, candidate: c, reference: r });
    }
    if (rows.some((x) => x.candidate.error)) return fail(`candidate crashed: ${rows.find((x) => x.candidate.error).candidate.error}`, { rows });
    let disagree = rows.filter((x) => x.reference.error || !sameOutput(x.candidate.out, x.reference.out));
    let tiebreak = null;
    if (disagree.length) {
      // Third blind implementation decides the disputed inputs (2 of 3).
      const third = await this.#reference(spec, 'plan', 0, signal, inputs);
      if (third.error) return fail(`implementations disagree on ${disagree.length}/${rows.length} input(s) and the tie-break failed`, { rows });
      tiebreak = [];
      for (const x of disagree) {
        const t = await this.#run(third.code, x.input, library);
        tiebreak.push({ input: x.input, third: t });
        // Two of three implementations deliberately reject this input (e.g. a speed of 0 or below): it is outside
        // the function's domain, not evidence that the candidate is wrong. Measured on a correct harmonic-mean skill.
        if (x.reference.error && t.error) { x.outOfDomain = true; continue; }
        if (t.error || !sameOutput(t.out, x.candidate.out)) return fail(`implementations disagree on ${disagree.length}/${rows.length} input(s); the candidate lost the 2-of-3 vote`, { rows, tiebreak });
      }
      disagree = [];
    }
    const inDomain = rows.filter((x) => !x.outOfDomain);
    if (inDomain.length < 3) return fail(`only ${inDomain.length} in-domain input(s) agree; at least 3 are required`, { rows, tiebreak });
    const verification = { method: 'differential, 2 of 3', inputs: inDomain.length, outOfDomain: rows.length - inDomain.length, referenceModel: ref.model, extractorModel: ex.model, tiebreak: Boolean(tiebreak), rows: rows.map((x) => ({ input: x.input, out: x.candidate.out })) };
    const id = newId('sk');
    const codeSha = sha256(cand.code);
    this.store.run('INSERT INTO skills (id, name, description, params, code, code_sha256, status, source, verification, uses, failures, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
      id, name, String(cand.description).slice(0, 300), JSON.stringify(cand.params), cand.code, codeSha, 'active', `${source.kind}:${source.ref}`, JSON.stringify(verification), nowIso(), nowIso());
    const skill = this.list('active').find((s) => s.id === id);
    this.#register(skill);
    this.ledger.append('skill.admit', { id, name, codeSha256: codeSha, source: `${source.kind}:${source.ref}`, inputs: rows.length, tiebreak: Boolean(tiebreak), extractor: ex.model, reference: ref.model }, 'crystallizer');
    this.bus?.publish('skill.admit', { name, inputs: rows.length });
    return { admitted: true, skill: { name, description: skill.description, codeSha256: codeSha }, reason: `verified against an independent implementation on ${inDomain.length} input(s)${tiebreak ? ' (2-of-3 tie-break)' : ''}${rows.length > inDomain.length ? `; ${rows.length - inDomain.length} input(s) rejected by 2 of 3 as out of domain` : ''}`, verification };
  }

  /** A blind reference implementation (and, optionally, edge-case inputs) from the spec alone. */
  async #reference(spec, role, tests, signal, givenInputs = null) {
    let res;
    try {
      res = await this.router.chat({
        role, privacy: 'private', json: true, temperature: 0.1, maxTokens: 1400, signal,
        messages: [
          { role: 'system', content: 'You independently implement a specified function and design tests for it. Write JavaScript `function main(input) { ... }` from the specification alone: pure, no I/O. Reply with JSON only.' },
          { role: 'user', content: `${spec}\n\n${tests ? `Also give ${tests} test inputs covering normal and edge cases (input objects only, matching the schema).\n` : ''}Return {"code":"function main(input) { ... }"${tests ? ',"inputs":[{...}, ...]' : ''}}` },
        ],
      });
    } catch (e) { return { error: 'model unavailable' }; }
    const p = parseJson(res.text);
    if (!String(p.code || '').includes('function main')) return { error: 'no implementation' };
    const inputs = givenInputs || (Array.isArray(p.inputs) ? p.inputs.filter((x) => x && typeof x === 'object') : []);
    return { code: p.code, inputs, model: res.model };
  }

  /**
   * Skill-first routing: before an agent spends model turns on a task, check whether an owned skill already answers it.
   *   1. prefilter (no model): content-word overlap with the skill's name, description and parameter names, and the task
   *      must state at least as many numbers as the skill has required numeric parameters. No candidate, no cost.
   *   2. bind (one short local call): pick the skill whose output alone answers the task and extract its input.
   *   3. ground (no model): every number and string in the bound input must appear literally in the task, so a binder
   *      cannot invent or convert values; the input must satisfy the schema's required keys and types.
   *   4. run the verified code. Any failure falls through to the normal agent loop; nothing is lost by trying.
   * Returns { skill, input, out, bindModel, usage } or { miss: reason, usage }.
   */
  async route(task, { signal, privacy = 'normal', agentId = null, missionId = null, reflection = 0 } = {}) {
    const cfg = this.cfg?.skills || {};
    const zero = { prompt: 0, completion: 0 };
    const active = this.list('active');
    if (!active.length) return { miss: 'no skills', usage: zero };
    const text = String(task);
    const taskWords = new Set(words(text));
    const nums = text.match(NUM) || [];
    const candidates = active.map((s) => {
      const vocab = new Set([...words(s.name.replace(/_/g, ' ')), ...words(s.description), ...Object.entries(s.params?.properties || {}).flatMap(([k, p]) => words(`${k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')} ${p?.description || ''}`))]);
      const shared = [...vocab].filter((w) => taskWords.has(w));
      const needNums = (s.params?.required || []).filter((k) => ['number', 'integer', 'array'].includes(s.params?.properties?.[k]?.type)).length;
      return { s, score: shared.length, shared, ok: shared.length >= (cfg.minOverlap ?? 1) && nums.length >= needNums };
    }).filter((c) => c.ok).sort((a, b) => b.score - a.score).slice(0, 3);
    if (!candidates.length) return { miss: 'no candidate skill', usage: zero };

    let res;
    try {
      res = await this.router.chat({
        role: cfg.bindRole || 'fast', privacy: 'private', json: true, temperature: 0, maxTokens: 400, signal, missionId,
        messages: [
          { role: 'system', content: 'You route tasks to verified functions. A function may be used ONLY if its output alone is the complete answer to what the task asks. Copy input values exactly as written in the task, except where a parameter description in the input schema explicitly asks for another form (for example a percentage as a decimal). Never invent values. Reply with JSON only.' },
          { role: 'user', content: `Task:\n${text.slice(0, 3000)}\n\nFunctions:\n${candidates.map(({ s }) => `- ${s.name}: ${s.description} Input schema: ${JSON.stringify(s.params)}`).join('\n')}\n\nReturn {"skill":"<name>","input":{...}} or {"skill":null} if none fully answers the task.` },
        ],
      });
    } catch { return { miss: 'binder unavailable', usage: zero }; }
    const usage = res.usage || zero;
    const p = parseJson(res.text);
    const miss = (reason) => {
      this.ledger.append('skill.route_miss', { agentId, missionId, reason, candidates: candidates.map((c) => c.s.name), bindModel: res.model }, 'crystallizer');
      return { miss: reason, usage, bindModel: res.model };
    };
    if (!p.skill) return miss('binder found no skill that fully answers the task');
    const hit = candidates.find((c) => c.s.name === String(p.skill).replace(/^skill_/, ''));
    if (!hit) return miss(`binder named an unknown skill (${String(p.skill).slice(0, 40)})`);
    const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : null;
    const problem = !input ? 'no input object' : groundingProblem(input, hit.s.params, text);
    if (problem) return miss(`binding rejected: ${problem}`);
    let out;
    try {
      const library = active.filter((x) => x.name !== hit.s.name);
      const r = await this.#run(hit.s.code, input, library);
      if (r.error) return miss(`skill rejected the bound input: ${r.error}`);
      out = r.out;
    } catch (e) { return miss(`skill run failed: ${e.message}`); }
    this.store.run('UPDATE skills SET uses = uses + 1, updated = ? WHERE id = ?', nowIso(), hit.s.id);
    // The agent loop would have spent at least one turn plus its reflection rounds; routing spent one bind call.
    const baselineMin = 1 + Math.min(Math.max(0, reflection | 0), 2);
    const private_ = privacy === 'private' || privacy === 'sealed';
    this.ledger.append('skill.route', { skill: hit.s.name, codeSha256: hit.s.code_sha256, agentId, missionId, bindModel: res.model,
      input: private_ ? undefined : input, inputSha256: sha256(JSON.stringify(input)), baselineMin, spent: 1, bindTokens: usage.prompt + usage.completion }, 'crystallizer');
    this.bus?.publish('skill.route', { skill: hit.s.name, agentId, missionId });
    return { skill: hit.s, input, out, bindModel: res.model, usage };
  }

  /** The final answer a routed task returns: the exact result plus its provenance. */
  static answerText(skill, input, out, privacy = 'normal') {
    const shown = typeof out === 'number' ? String(Number(out.toPrecision(12))) : typeof out === 'string' ? out : `\n\n\`\`\`json\n${JSON.stringify(out, null, 2)}\n\`\`\``;
    const inp = privacy === 'normal' ? ` on input \`${JSON.stringify(input)}\`` : '';
    return `**Answer: ${shown}**\n\nComputed exactly by the agency's crystallized skill \`skill_${skill.name}\` (${skill.description} Verified by differential testing; code sha256 ${skill.code_sha256.slice(0, 12)})${inp}. No model reasoning produced this result.`;
  }

  retire(name, reason = 'operator') {
    const ok = this.store.run("UPDATE skills SET status = 'retired', updated = ? WHERE name = ? AND status = 'active'", nowIso(), name).changes > 0;
    if (ok) { this.tools.tools?.delete(`skill_${name}`); this.ledger.append('skill.retire', { name, reason }, 'operator'); }
    return ok;
  }

  /** The compounding curve: how much work learned skills are doing instead of models. */
  stats() {
    const active = this.list('active');
    const uses = active.reduce((s, k) => s + k.uses, 0);
    const calls = this.store.get("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'tool.call'").n;
    // Skill-first routing, from the ledger: each route replaced an agent loop (>= 1 turn + reflection) with one bind call.
    const routes = this.store.all("SELECT ts, data FROM ledger WHERE kind = 'skill.route' ORDER BY seq").map((r) => ({ ts: r.ts, ...JSON.parse(r.data) }));
    const misses = this.store.get("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'skill.route_miss'").n;
    const rejected = this.store.get("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'skill.route_rejected'").n;
    let avoided = 0;
    const curve = routes.map((r, i) => { avoided += Math.max(0, (r.baselineMin ?? 1) - (r.spent ?? 1)); return { at: r.ts, routes: i + 1, avoided, skill: r.skill }; });
    return { active: active.length, retired: this.list('retired').length, uses, failures: active.reduce((s, k) => s + k.failures, 0), modelCallsAvoided: uses, toolCalls: calls,
      routed: routes.length, routeMisses: misses, routeRejected: rejected, bindCalls: routes.length + misses, callsAvoidedMin: avoided, curve: curve.slice(-200) };
  }
}
