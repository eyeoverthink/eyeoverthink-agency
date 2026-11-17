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
import { induce, leaveOneOut, compileSpec, applySpec, questionWords, numberTokens, learnBlocks, contested, novelWording, wordingOf } from './binder-induction.js';

const NAME = /^[a-z][a-z0-9_]{2,39}$/;

/** Deep equality with numeric tolerance, for comparing two implementations' outputs. */
/** A computed value matches an agent's answer: within 0.2%, or equal at the answer's own rounding ("110.16", "51"). */
export function nearAnswer(out, answer) {
  if (typeof out !== 'number' || typeof answer !== 'number' || !Number.isFinite(out)) return false;
  const dec = Math.min(4, (String(answer).split('.')[1] || '').length);
  return Math.abs(out - answer) <= Math.max(0.01, Math.abs(answer) * 0.002) || (dec <= 2 && Math.abs(Number(out.toFixed(dec)) - answer) < 1e-9);
}

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

/** Strict structural equality with numeric tolerance (no unwrapping): for comparing two bindings of the same skill. */
export function sameInput(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameInput(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameInput(a[k], b[k]));
  }
  return a === b;
}

// Question forms whose answer is not a single computed value: a difference, a choice, a comparison or a yes/no.
const FORMS = [
  ['a difference or saving', /\b(sav(e|es|ed|ing|ings)|difference|how (much|many \w+) (more|less|cheaper|lower|higher))\b|\b(cheaper|lower|higher|more|less|faster|slower)\b[^.?!]*\bthan\b/i],
  ['a choice between options', /\bwhich\b|\b(better|worse|best|worst)\b/i],
  ['a yes/no answer', /\byes or no\b|\btrue or false\b|(^|[.!?]\s+)(is|are|does|do|can|should|will|would)\s[^.?!]*\?/i],
];

/**
 * Structural checks no model can talk its way past, measured on real models in Phase 11 (llama3.2 3B, hermes3 and
 * fraymus-prime 8B each routed 5-6 of 6 near-miss tasks; model size did not help):
 *   unused numbers : the task states a number the binding does not use ("60 mph FOR 3 HOURS"), so the skill cannot be
 *                    using everything the answer depends on;
 *   answer form    : the task asks for a difference, a choice or a yes/no, and the skill's own description does not say
 *                    it computes one.
 * Returns a reason, or null. Grounding (groundingProblem) runs first.
 */
const walk2 = (v, out) => { if (Array.isArray(v)) v.forEach((x) => walk2(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk2(x, out)); else if (typeof v === 'number') out.push(v); };

export function bindingProblem(input, skill, task) {
  const g = groundingProblem(input, skill.params, task);
  if (g) return g;
  const used = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); else if (typeof v === 'number') { used.add(v); used.add(Math.round(v * 100 * 1e9) / 1e9); } };
  walk(input);
  const unused = [...new Set((String(task).match(NUM) || []).map(Number))].filter((n) => !used.has(n));
  if (unused.length) return `the task states ${unused.slice(0, 3).join(', ')} but the binding does not use ${unused.length > 1 ? 'them' : 'it'}`;
  // Occurrences, not just values, in the fullest line of the task (mission prompts restate the goal on other lines).
  // Measured: "10% off, then 10% off ... including 8% tax" bound 10 and 8, and a set-based check saw every value used.
  const lines = String(task).split(/\n+/).map((l) => (l.match(NUM) || []).map(Number));
  const fullest = lines.reduce((a, b) => (b.length > a.length ? b : a), []);
  const pool = [...fullest];
  const leaves = [];
  walk2(input, leaves);
  for (const v of leaves) { const i = pool.findIndex((n) => n === v || n === Math.round(v * 100 * 1e9) / 1e9); if (i >= 0) pool.splice(i, 1); }
  if (pool.length) return `the task states ${pool.join(', ')} once more than the binding uses`;
  for (const [form, re] of FORMS) if (re.test(String(task)) && !re.test(`${skill.name.replace(/_/g, ' ')} ${skill.description}`)) return `the task asks for ${form}, which this skill does not compute`;
  return null;
}

// ---- Skill composition (Phase 14): chains of owned skills ----------------------------------------------------------

const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v.ref);

/** A binder's chain proposal, normalized: 2-3 steps of {skill, input}; refs as {"ref": k} (also "$k" / "step k"). */
export function normalizeChain(p) {
  const raw = Array.isArray(p?.steps) ? p.steps : null;
  if (!raw || raw.length < 2 || raw.length > 3) return null;
  const steps = [];
  for (const s of raw) {
    if (!s || typeof s.skill !== 'string' || !s.input || typeof s.input !== 'object' || Array.isArray(s.input)) return null;
    const input = {};
    for (const [k, v] of Object.entries(s.input)) {
      const m = typeof v === 'string' ? v.trim().match(/^(?:\$|step\s*)(\d)$/i) : null;
      input[k] = m ? { ref: Number(m[1]) } : isRef(v) ? { ref: v.ref } : v;
    }
    steps.push({ skill: s.skill.replace(/^skill_/, ''), input });
  }
  return steps;
}

/** The shape of a chain, independent of its values: which skills, which inputs come from which earlier step. */
export function chainSignature(steps) {
  return steps.map((s) => `${s.skill}(${Object.keys(s.input).sort().map((k) => (isRef(s.input[k]) ? `${k}=@${s.input[k].ref}` : k)).join(',')})`).join(' > ');
}

/**
 * Why a chain cannot be trusted, or null. The single-skill gates, generalized:
 *   - every literal is grounded in the task (per parameter contract), every ref points at an EARLIER step;
 *   - every step but the last feeds a later one (no dead steps), and each step's required inputs are present;
 *   - every number the task states is used, occurrence by occurrence, somewhere in the chain;
 *   - the task's answer form (difference, choice, yes/no) must be what the LAST skill computes.
 */
export function chainProblem(steps, skills, task) {
  const used = new Set();
  const literals = [];
  for (const [i, s] of steps.entries()) {
    const sk = skills.find((x) => x.name === s.skill);
    if (!sk) return `step ${i + 1} names an unknown skill (${s.skill})`;
    const props = sk.params?.properties || {};
    for (const k of sk.params?.required || []) if (!(k in s.input)) return `step ${i + 1} (${s.skill}) is missing required input ${k}`;
    for (const [k, v] of Object.entries(s.input)) {
      if (isRef(v)) {
        if (v.ref < 1 || v.ref > i) return `step ${i + 1} refers to step ${v.ref}, which is not an earlier step`;
        used.add(v.ref);
        continue;
      }
      const g = groundingProblem({ [k]: v }, { type: 'object', properties: { [k]: props[k] || {} } }, task);
      if (g) return `step ${i + 1} (${s.skill}): ${g}`;
      walk2(v, literals);
    }
  }
  for (let i = 1; i < steps.length; i++) if (!used.has(i)) return `step ${i} (${steps[i - 1].skill}) feeds nothing: its output is never used`;
  const lines = String(task).split(/\n+/).map((l) => (l.match(NUM) || []).map(Number));
  const pool = [...lines.reduce((a, b) => (b.length > a.length ? b : a), [])];
  for (const v of literals) { const j = pool.findIndex((n) => n === v || n === Math.round(v * 100 * 1e9) / 1e9); if (j >= 0) pool.splice(j, 1); }
  if (pool.length) return `the task states ${pool.join(', ')} but the chain does not use ${pool.length > 1 ? 'them' : 'it'}`;
  const last = skills.find((x) => x.name === steps.at(-1).skill);
  for (const [form, re] of FORMS) if (re.test(String(task)) && !re.test(`${last.name.replace(/_/g, ' ')} ${last.description}`)) return `the task asks for ${form}, which the last step (${last.name}) does not compute`;
  return null;
}

/**
 * A composed skill, written by the agency itself (no model): its code calls the owned skills in order. Every literal
 * slot of the chain becomes a parameter (step-suffixed when two steps share a name), with its contract copied.
 */
export function composeChainSkill(steps, skills) {
  const counts = {};
  for (const s of steps) for (const [k, v] of Object.entries(s.input)) if (!isRef(v)) counts[k] = (counts[k] || 0) + 1;
  const slots = [];
  const properties = {};
  for (const [i, s] of steps.entries()) {
    const sk = skills.find((x) => x.name === s.skill);
    for (const [k, v] of Object.entries(s.input)) {
      if (isRef(v)) continue;
      const param = counts[k] > 1 ? `${k}_${i + 1}` : k;
      slots.push({ step: i, key: k, param });
      properties[param] = { ...(sk.params?.properties?.[k] || { type: typeof v === 'number' ? 'number' : 'string' }) };
    }
  }
  const body = steps.map((s, i) => `  const s${i + 1} = skill_${s.skill}({ ${Object.entries(s.input).map(([k, v]) => `${JSON.stringify(k)}: ${isRef(v) ? `s${v.ref}` : `input[${JSON.stringify(slots.find((x) => x.step === i && x.key === k).param)}]`}`).join(', ')} });`);
  const code = ['function main(input) {', ...body, `  return s${steps.length};`, '}'].join('\n');
  const short = (n) => n.replace(/^calculate_/, '').split('_').slice(0, 4).join('_');
  let name = steps.map((s) => short(s.skill)).join('_then_').replace(/[^a-z0-9_]/g, '').slice(0, 34);
  name = `${name}_${sha256(chainSignature(steps)).slice(0, 4)}`.replace(/^[^a-z]/, 'c');
  const description = `Composed from owned skills: ${steps.map((s) => skills.find((x) => x.name === s.skill)?.description?.replace(/\.$/, '') || s.skill).join('; then ')}.`.slice(0, 300);
  return { name, description, params: { type: 'object', properties, required: Object.keys(properties) }, code, slots };
}

/**
 * Chain inference: the model gives the values, the agency gives the structure. Measured in Phase 14: the 3B binder
 * understood that a task needed composing and bound every value correctly, but answered {"skill":"chain","input":
 * {original_price, discount, tax_rate, number_of_people}} instead of steps. Given such a flat binding, search the
 * orders of 2-3 offered skills in which every step's required inputs come from the binding by name, except exactly one
 * input of each later step, which is fed by the step before; every bound value must be used exactly once. Only a
 * Every structure that fits is returned; the judge decides between them (the chain whose result matches the agent
 * loop's answer), and each still faces chainProblem.
 */
export function inferChain(flat, skills) {
  if (!flat || typeof flat !== 'object' || Array.isArray(flat)) return null;
  const keys = Object.keys(flat);
  const found = new Map();
  const orders = [];
  for (const a of skills) for (const b of skills) if (b !== a) { orders.push([a, b]); for (const c of skills) if (c !== a && c !== b) orders.push([a, b, c]); }
  for (const order of orders) {
    const used = new Set();
    const steps = [];
    let ok = true;
    for (const [i, s] of order.entries()) {
      const props = Object.keys(s.params?.properties || {});
      const required = s.params?.required || props;
      const input = {};
      const missing = [];
      for (const k of props) {
        if (k in flat && !used.has(k)) { input[k] = flat[k]; used.add(k); }
        else if (required.includes(k)) missing.push(k);
      }
      if (i === 0 ? missing.length : missing.length !== 1) { ok = false; break; }
      if (i > 0) input[missing[0]] = { ref: i };
      steps.push({ skill: s.name, input });
    }
    if (ok && used.size === keys.length) found.set(chainSignature(steps), steps);
  }
  return [...found.values()];
}

/**
 * Chain extension: a single-skill binding that leaves task numbers unused ("split among 3 friends" after a discount)
 * is extended by ONE step: an offered skill with exactly one required input fed by the bound step and the rest filled,
 * in order, by the unused numbers. Measured ambiguity: the bound step's output could feed total_amount OR
 * number_of_people; both are returned and the agent loop's answer picks one.
 */
export function extendChain(skill, input, unused, skills) {
  const found = [];
  for (const s of skills) {
    if (s.name === skill.name) continue;
    const required = s.params?.required || Object.keys(s.params?.properties || {});
    if (required.length !== unused.length + 1) continue;
    for (const fed of required) {
      const rest = required.filter((k) => k !== fed);
      if (!rest.every((k) => ['number', 'integer'].includes(s.params?.properties?.[k]?.type))) continue;
      found.push([{ skill: skill.name, input }, { skill: s.name, input: { [fed]: { ref: 1 }, ...Object.fromEntries(rest.map((k, i) => [k, unused[i]])) } }]);
    }
  }
  return found;
}

/** The composed skill's input for one verified chain: its literal slots, by parameter name. */
export const chainInput = (steps, slots) => Object.fromEntries(slots.map((x) => [x.param, steps[x.step].input[x.key]]));

/** Models sometimes double-escape code inside JSON (a literal backslash-n for a newline); such a program is unescaped. */
export function normalizeCode(code) {
  const c = String(code || '');
  return !c.includes('\n') && /\\n/.test(c) ? c.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"') : c;
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
  async crystallize(source, { tests = 6, signal, answerKey = null } = {}) {
    const library = this.list('active');
    const keyAsk = answerKey?.length ? `\n\nAlso return "bindings": one entry per solved task above, in the same order, each {"input":{...}} with values copied exactly from that task (a percentage as a decimal only if your schema says so).` : '';
    const ex = await this.router.chat({
      role: 'code', privacy: 'private', json: true, temperature: 0.2, maxTokens: 2000, signal,
      messages: [
        { role: 'system', content: 'You turn a solved task into ONE reusable, general, pure JavaScript function so that next time this KIND of task can be solved by code instead of a language model. The function must be named main, take a single JSON input object, return a JSON-serializable value, and use no I/O, network, randomness or dates. Reply with JSON only.' },
        { role: 'user', content: `${source.text}\n\nExisting skills you may call (as skill_<name>(input)): ${library.map((s) => `skill_${s.name}: ${s.description}`).join('; ') || 'none'}${keyAsk}\n\nReturn {"name":"snake_case_name","description":"what it computes, in one sentence","params":{"type":"object","properties":{...},"required":[...]},"code":"function main(input) { ... }"${answerKey?.length ? ',"bindings":[{"input":{...}}, ...]' : ''}} or {"none":true} if no reusable computation exists.` },
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
    // Before the reference reads the contract: it must implement the repaired one (measured: a reference written from
    // the unrepaired schema implemented whole-number percentages and lost the vote to a candidate passing 8/8 keys).
    let contractRepaired = null;
    if (answerKey?.length) {
      // Contract repair from evidence. Measured: the extractor bound "10%" as 0.1 in every binding but its schema never
      // said "decimal", so grounding (a conversion only when the contract declares it, Phase 10) refused all of them,
      // for the candidate and the reference alike. A parameter whose every binding is one of its task's stated
      // percentages / 100 (or 0 where the task states none) gets the clause it was missing; the key still checks the result.
      const b = Array.isArray(cand.bindings) ? cand.bindings : [];
      const props = cand.params?.properties || {};
      const pcts = (t) => [...String(t).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)].map((m) => Number(m[1]));
      contractRepaired = Object.keys(props).filter((k) => {
        if (props[k]?.type !== 'number' || /\b(decimal|fraction)\b/i.test(props[k]?.description || '')) return false;
        const vals = answerKey.map((key, i) => ({ v: (b[i]?.input ?? b[i])?.[k], p: pcts(key.task) }));
        return vals.every((x) => typeof x.v === 'number') && vals.some((x) => x.v > 0) && vals.every((x) => x.v === 0 || x.p.some((p) => Math.abs(p / 100 - x.v) < 1e-9));
      });
      for (const k of contractRepaired) props[k].description = `${props[k].description ? `${props[k].description} ` : ''}(as a decimal fraction: 0.2 for 20%)`;
      if (!contractRepaired.length) contractRepaired = null;
    }
    const spec = `Function: ${cand.description}\nInput schema: ${JSON.stringify(cand.params)}\nThe solved task it generalizes (use it to understand the meaning, then implement the general function):\n${String(source.text).slice(0, 2500)}`;
    let ref = await this.#reference(spec, 'reason', tests, signal);
    if (ref.error) return fail(`reference failed: ${ref.error}`);
    const inputs = ref.inputs.slice(0, tests);
    if (inputs.length < 3) return fail('too few test inputs');

    // Answer key FIRST (Phase 13): a skill learned from refused tasks must reproduce, from grounded inputs, the answers
    // two different agents corroborated for them. Ground truth outranks a vote between models, and it applies to EVERY
    // implementation. Measured on real models: the 7B extractor treated percentages as fractions (90 x (1 - 20) x
    // (1 + 6) = -11970) while the blind reference matched all 3 corroborated answers, and the vote threw away the correct
    // code because it was only the referee. Now a reference that passes the key where the candidate fails is PROMOTED,
    // and a fresh, independent implementation must agree with it. At most one key in four may miss.
    let keyRows = null, promoted = null;
    const scoreKey = async (code) => {
      const b = Array.isArray(cand.bindings) ? cand.bindings : [];
      const out = [];
      for (const [i, k] of answerKey.entries()) {
        const input = b[i]?.input ?? b[i];
        const g = !input || typeof input !== 'object' || Array.isArray(input) ? 'no binding' : groundingProblem(input, cand.params, k.task);
        const run = g ? null : await this.#run(code, input, library);
        const ok = !g && !run.error && typeof run.out === 'number' && nearAnswer(run.out, k.answer);
        out.push({ task: k.task, input: input ?? null, expected: k.answer, out: run?.out ?? null, ok, problem: g || run?.error || null });
      }
      const pass = out.filter((x) => x.ok).length;
      return { rows: out, pass, ok: pass >= answerKey.length - Math.floor(answerKey.length / 4) };
    };
    if (answerKey?.length) {
      const kc = await scoreKey(cand.code);
      keyRows = kc.rows;
      if (!kc.ok) {
        const kr = await scoreKey(ref.code);
        if (!kr.ok) return fail(`reproduces only ${kc.pass}/${answerKey.length} corroborated answers (the blind reference: ${kr.pass}/${answerKey.length})`, { keyRows, refKeyRows: kr.rows });
        promoted = { from: ex.model, to: ref.model, candidateKey: `${kc.pass}/${answerKey.length}` };
        cand.code = ref.code; keyRows = kr.rows;
        const fresh = await this.#reference(spec, 'plan', 0, signal, inputs);
        if (fresh.error) return fail(`the reference passed the answer key but no independent implementation could check it: ${fresh.error}`, { keyRows });
        ref = { ...fresh, inputs };
      }
    }

    const rows = [];
    for (const input of inputs) {
      const [c, r] = await Promise.all([this.#run(cand.code, input, library), this.#run(ref.code, input, library)]);
      rows.push({ input, candidate: c, reference: r });
    }
    if (rows.some((x) => x.candidate.error)) return fail(`candidate crashed: ${rows.find((x) => x.candidate.error).candidate.error}`, { rows });
    let disagree = rows.filter((x) => x.reference.error || !sameOutput(x.candidate.out, x.reference.out));
    let tiebreak = null;
    if (disagree.length) {
      // Third blind implementation decides the disputed inputs (2 of 3). After a promotion the 'plan' model is already
      // the referee, so the extractor's model writes the third one, this time from the spec alone.
      const third = await this.#reference(spec, promoted ? 'code' : 'plan', 0, signal, inputs);
      if (third.error) return fail(`implementations disagree on ${disagree.length}/${rows.length} input(s) and the tie-break failed`, { rows });
      tiebreak = [];
      for (const x of disagree) {
        const t = await this.#run(third.code, x.input, library);
        tiebreak.push({ input: x.input, third: t });
        // Two of three implementations deliberately reject this input (e.g. a speed of 0 or below): it is outside
        // the function's domain, not evidence that the candidate is wrong. Measured on a correct harmonic-mean skill.
        if (x.reference.error && t.error) { x.outOfDomain = true; continue; }
        if (t.error || !sameOutput(t.out, x.candidate.out)) return fail(`implementations disagree on ${disagree.length}/${rows.length} input(s); the candidate lost the 2-of-3 vote`, { rows, tiebreak, keyRows });
      }
      disagree = [];
    }
    const inDomain = rows.filter((x) => !x.outOfDomain);
    if (inDomain.length < 3) return fail(`only ${inDomain.length} in-domain input(s) agree; at least 3 are required`, { rows, tiebreak });
    const verification = { method: answerKey?.length ? 'differential 2 of 3 + corroborated answer key' : 'differential, 2 of 3', answerKey: keyRows ? `${keyRows.filter((x) => x.ok).length}/${keyRows.length}` : undefined, promoted: promoted || undefined, contractRepaired: contractRepaired || undefined, inputs: inDomain.length, outOfDomain: rows.length - inDomain.length, referenceModel: ref.model, extractorModel: ex.model, tiebreak: Boolean(tiebreak), rows: rows.map((x) => ({ input: x.input, out: x.candidate.out })) };
    const id = newId('sk');
    const codeSha = sha256(cand.code);
    this.store.run('INSERT INTO skills (id, name, description, params, code, code_sha256, status, source, verification, uses, failures, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
      id, name, String(cand.description).slice(0, 300), JSON.stringify(cand.params), cand.code, codeSha, 'active', `${source.kind}:${source.ref}`, JSON.stringify(verification), nowIso(), nowIso());
    const skill = this.list('active').find((s) => s.id === id);
    this.#register(skill);
    this.ledger.append('skill.admit', { id, name, codeSha256: codeSha, source: `${source.kind}:${source.ref}`, inputs: rows.length, tiebreak: Boolean(tiebreak), extractor: ex.model, reference: ref.model }, 'crystallizer');
    this.bus?.publish('skill.admit', { name, inputs: rows.length });
    // Answer-key bindings are verified three ways (grounded, code-computed, two agents agree): the new skill's first
    // positive examples, so its binder can be learned without waiting for model binds.
    for (const k of keyRows || []) if (k.ok) this.#example(name, k.task, k.input, 'pos');
    return { admitted: true, keyRows, skill: { name, description: skill.description, codeSha256: codeSha }, reason: `verified against an independent implementation on ${inDomain.length} input(s)${tiebreak ? ' (2-of-3 tie-break)' : ''}${rows.length > inDomain.length ? `; ${rows.length - inDomain.length} input(s) rejected by 2 of 3 as out of domain` : ''}`, verification };
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
    const scored = active.map((s) => {
      const vocab = new Set([...words(s.name.replace(/_/g, ' ')), ...words(s.description), ...Object.entries(s.params?.properties || {}).flatMap(([k, p]) => words(`${k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')} ${p?.description || ''}`))]);
      const shared = [...vocab].filter((w) => taskWords.has(w));
      const needNums = (s.params?.required || []).filter((k) => ['number', 'integer', 'array'].includes(s.params?.properties?.[k]?.type)).length;
      return { s, score: shared.length, shared, related: shared.length >= (cfg.minOverlap ?? 1), ok: shared.length >= (cfg.minOverlap ?? 1) && nums.length >= needNums };
    }).sort((a, b) => b.score - a.score);
    const candidates = scored.filter((c) => c.ok).slice(0, 3);
    // Composition (Phase 14): skills related to the task by wording may chain, each step's output feeding the next.
    // A step fed by an earlier step needs fewer numbers from the task, so the number-count filter does not apply.
    const chainCands = cfg.compose === false ? [] : scored.filter((c) => c.related).slice(0, 4);
    const compose = chainCands.length >= 2;
    if (!candidates.length && !compose) return { miss: 'no candidate skill', usage: zero };
    const private_ = privacy === 'private' || privacy === 'sealed';
    const ctx = { agentId, missionId, privacy, reflection, active };

    // Zero-call path: a learned binder (the routing step itself, crystallized and verified) parses the task. Its output
    // passes the same grounding as a model binding; anything doubtful falls through to the model binder.
    const binderNulls = new Set();
    let gated = null;
    for (const c of candidates) {
      const b = this.binder(c.s.name);
      if (!b) continue;
      const r = await this.#runBinder(b.code, text);
      if (r.error || !r.out || typeof r.out !== 'object' || Array.isArray(r.out) || bindingProblem(r.out, c.s, text)) { binderNulls.add(c.s.name); continue; }
      // The learned gate applies to zero-call routes too. A declined binding is kept as a shadow: the agent loop answers
      // and the two answers are compared. No model binder call is spent re-asking about wording nobody has verified.
      const gate = this.#learnedBlock(c.s.name, text);
      if (gate) {
        // Another candidate (for example a skill learned from this one's refusals) may still answer: keep looking.
        gated ??= { skill: c.s.name, input: r.out, reason: gate };
        binderNulls.add(c.s.name);
        continue;
      }
      const run = await this.#run(c.s.code, r.out, active.filter((x) => x.name !== c.s.name));
      if (run.error) { binderNulls.add(c.s.name); continue; }
      this.store.run('UPDATE skill_binders SET uses = uses + 1, updated = ? WHERE id = ?', nowIso(), b.id);
      return this.#commitRoute(c.s, r.out, run.out, { ...ctx, bindModel: 'learned-binder', binderId: b.id, spent: 0, usage: zero });
    }
    // The only candidate declined its own binding: refuse at zero cost (the shadow verdict learns from it).
    if (gated && candidates.length === 1 && !compose) {
      this.ledger.append('skill.route_miss', { agentId, missionId, reason: `binding rejected: ${gated.reason}`, candidates: [gated.skill], bindModel: 'learned-binder' }, 'crystallizer');
      return { miss: `binding rejected: ${gated.reason}`, usage: zero, shadow: private_ ? null : gated };
    }

    const offered = [...new Map([...candidates, ...chainCands].map((c) => [c.s.name, c.s])).values()];
    let res;
    try {
      res = await this.router.chat({
        role: cfg.bindRole || 'fast', privacy: 'private', json: true, temperature: 0, maxTokens: compose ? 600 : 400, signal, missionId,
        messages: [
          { role: 'system', content: 'You route tasks to verified functions. A function may be used ONLY if its output alone is the complete answer to what the task asks. Copy input values exactly as written in the task, except where a parameter description in the input schema explicitly asks for another form (for example a percentage as a decimal). Never invent values. Reply with JSON only.' },
          { role: 'user', content: `Task:\n${text.slice(0, 3000)}\n\nFunctions:\n${offered.map((s) => `- ${s.name}: ${s.description} Input schema: ${JSON.stringify(s.params)}`).join('\n')}\n\nReturn {"skill":"<name>","input":{...}}${compose ? ', or, ONLY if no single function answers but a chain of 2 or 3 of them does (each step\'s output feeding a later step), {"steps":[{"skill":"<name>","input":{...}},{"skill":"<name>","input":{"<param>":{"ref":1},...}}]} where {"ref":k} is the output of step k,' : ''} or {"skill":null} if ${compose ? 'neither fully answers' : 'none fully answers'} the task.` },
        ],
      });
    } catch { return { miss: 'binder unavailable', usage: zero }; }
    const usage = res.usage || zero;
    const p = parseJson(res.text);
    const miss = (reason, extra = {}) => {
      this.ledger.append('skill.route_miss', { agentId, missionId, reason, candidates: offered.map((s) => s.name), bindModel: res.model }, 'crystallizer');
      return { miss: reason, usage, bindModel: res.model, shadow: private_ ? null : gated, ...extra };
    };
    const tryChain = async (chain, how) => {
      const cp = chainProblem(chain, offered, text);
      if (cp) return miss(`chain rejected${how ? ` (${how})` : ''}: ${cp}`);
      const ran = await this.#runChain(chain, active);
      if (ran.error) return miss(`chain failed: ${ran.error}`);
      const sig = chainSignature(chain);
      const verified = this.store.get("SELECT COUNT(*) AS n FROM skill_chains WHERE signature = ? AND label = 'verified'", sig).n;
      // A new composition is not trusted until the judge has verified its shape (as with new wording, Phase 12): the
      // agent loop answers and the chain's result is compared with it.
      if (verified < (cfg.chainTrust ?? 2)) return miss(`unverified composition${how ? ` (${how})` : ''} (${sig}, verified ${verified}x): the agent loop answers, and its answer is compared with the chain's`, { shadow: private_ ? null : { chain, signature: sig, out: ran.out, reason: 'unverified composition' } });
      // A trusted shape is trusted only for the wording its verified chains used (Phase 12, for chains). Measured in
      // Phase 14: "an 18% tip is added" was bound as a second discount and answered by the trusted discount-then-split
      // chain, and then saved as an example of the composed skill.
      if (cfg.verifyWording !== false) {
        const seen = this.chains(sig).filter((c) => c.label === 'verified').map((c) => ({ task: c.task }));
        const novel = novelWording(seen, text);
        if (novel.length) return miss(`unverified wording for composition ${sig} (${novel.slice(0, 4).map((w) => `"${w}"`).join(', ')}): the agent loop answers, and its answer is compared with the chain's`, { shadow: private_ ? null : { chain, signature: sig, out: ran.out, reason: 'unverified wording' } });
      }
      return this.#commitChain(chain, sig, ran, { ...ctx, task: text, bindModel: res.model, spent: 1, usage });
    };
    // Several candidate structures (inferred or extended): a single verified shape is used; otherwise all valid ones
    // are run and kept as the shadow, and the agent loop's answer decides which (if any) is right.
    const tryChains = async (list, how) => {
      const valid = list.filter((c) => !chainProblem(c, offered, text));
      if (!valid.length) return list.length ? tryChain(list[0], how) : null;
      if (valid.length === 1) return tryChain(valid[0], how);
      const trusted = valid.filter((c) => this.store.get("SELECT COUNT(*) AS n FROM skill_chains WHERE signature = ? AND label = 'verified'", chainSignature(c)).n >= (cfg.chainTrust ?? 2));
      if (trusted.length === 1) return tryChain(trusted[0], how);
      const runs = [];
      for (const c of valid.slice(0, 4)) { const ran = await this.#runChain(c, active); if (!ran.error && typeof ran.out === 'number') runs.push({ chain: c, signature: chainSignature(c), out: ran.out }); }
      if (!runs.length) return miss(`chain failed (${how})`);
      return miss(`ambiguous composition (${how}): ${runs.length} structures fit; the agent loop answers, and its answer picks one`, { shadow: private_ ? null : { candidates: runs, reason: 'ambiguous composition' } });
    };
    if (p.steps !== undefined && compose) {
      const chain = normalizeChain(p);
      if (!chain) return miss('malformed chain (2-3 steps of {skill, input} expected)');
      return tryChain(chain, null);
    }
    if (typeof p.skill === 'string' && /^(none|null|n\/a|)$/i.test(p.skill.trim())) p.skill = null; // "none" is a refusal
    // A binding to no known skill, but with values: the agency infers the chain structure itself (unique or nothing).
    if (compose && p.skill && !offered.some((s) => s.name === String(p.skill).replace(/^skill_/, '')) && p.input && typeof p.input === 'object') {
      const r = await tryChains(inferChain(p.input, offered), 'structure inferred from a flat binding');
      if (r) return r;
    }
    if (!p.skill) {
      // A refusal is a negative example for every candidate: the learned binder must also say no to tasks like this.
      if (!private_) for (const c of candidates) this.#example(c.s.name, text, null, 'neg');
      return miss('binder found no skill that fully answers the task');
    }
    const named = offered.find((s) => s.name === String(p.skill).replace(/^skill_/, ''));
    const hit = named ? { s: named } : null;
    if (!hit) return miss(`binder named an unknown skill (${String(p.skill).slice(0, 40)})`);
    const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : null;
    const problem = !input ? 'no input object' : bindingProblem(input, hit.s, text);
    if (problem && compose && input && !groundingProblem(input, hit.s.params, text)) {
      // A grounded single binding that leaves numbers unused may be one step short of a chain.
      const usedLeaves = [];
      walk2(input, usedLeaves);
      const pool = [...(text.split(/\n+/).map((l) => (l.match(NUM) || []).map(Number)).reduce((a, b) => (b.length > a.length ? b : a), []))];
      for (const v of usedLeaves) { const j = pool.findIndex((n) => n === v || n === Math.round(v * 100 * 1e9) / 1e9); if (j >= 0) pool.splice(j, 1); }
      const r = pool.length ? await tryChains(extendChain(hit.s, input, pool, offered), 'single binding extended by one step') : null;
      if (r) return r;
    }
    if (problem) return miss(`binding rejected: ${problem}`);
    const blocked = this.#learnedBlock(hit.s.name, text);
    if (blocked) return { ...miss(`binding rejected: ${blocked}`), shadow: private_ ? null : { skill: hit.s.name, input, reason: blocked } };
    let out;
    try {
      const library = active.filter((x) => x.name !== hit.s.name);
      const r = await this.#run(hit.s.code, input, library);
      if (r.error) return miss(`skill rejected the bound input: ${r.error}`);
      out = r.out;
    } catch (e) { return miss(`skill run failed: ${e.message}`); }
    // A grounded model binding is a positive example; enough of them and the binding step is learned too.
    if (!private_) { this.#example(hit.s.name, text, input, 'pos'); this.#maybeLearn(hit.s.name); }
    return this.#commitRoute(hit.s, input, out, { ...ctx, bindModel: res.model, spent: 1, usage, binderMissed: binderNulls.has(hit.s.name) });
  }

  #commitRoute(skill, input, out, { agentId, missionId, privacy, reflection, bindModel, binderId = null, spent, usage, binderMissed = false }) {
    this.store.run('UPDATE skills SET uses = uses + 1, updated = ? WHERE id = ?', nowIso(), skill.id);
    // The agent loop would have spent at least one turn plus its reflection rounds; routing spent `spent` model calls.
    const baselineMin = 1 + Math.min(Math.max(0, reflection | 0), 2);
    const private_ = privacy === 'private' || privacy === 'sealed';
    this.ledger.append('skill.route', { skill: skill.name, codeSha256: skill.code_sha256, agentId, missionId, bindModel, binderId, binderMissed,
      input: private_ ? undefined : input, inputSha256: sha256(JSON.stringify(input)), baselineMin, spent, bindTokens: usage.prompt + usage.completion }, 'crystallizer');
    this.bus?.publish('skill.route', { skill: skill.name, agentId, missionId, zeroCall: spent === 0 });
    return { skill, input, out, bindModel, binderId, usage };
  }

  /** Question words this skill's past refusals taught it to refuse; they gate model bindings too, not just the learned binder. */
  #learnedBlock(skill, task) {
    // Learned from the recorded examples, not read from the active binder: when the critic retires a binder, the
    // lesson must hold even before (or if never) a replacement binder is admitted.
    const ex = this.examples(skill);
    const pos = ex.filter((e) => e.label === 'pos'), neg = ex.filter((e) => e.label === 'neg');
    const sig = `${ex.length}:${ex.at(-1)?.id}:${pos.length}:${neg.length}`;
    this.blockCache ??= new Map();
    let spec = this.blockCache.get(skill)?.sig === sig ? this.blockCache.get(skill).spec : null;
    if (!spec) {
      spec = neg.length ? learnBlocks(pos, neg) : {};
      this.blockCache.set(skill, { sig, spec });
    }
    const words = spec.blockWords || [];
    const hit = questionWords(task).find((w) => words.includes(w));
    if (hit) return `the question uses "${hit}", which only ever appeared in tasks this skill had to refuse`;
    const cb = spec.contextBlock;
    const t = cb && numberTokens(task).find((x) => cb.kinds.includes(x.kind) && x.ctx.some((w) => cb.words.includes(w)));
    if (t) return `"${t.ctx.find((w) => cb.words.includes(w))}" follows a ${t.kind} number, as it only ever did in tasks this skill had to refuse`;
    // Verified wording (Phase 12): once the skill has enough positives, wording none of them used is not trusted yet.
    // Skills born from verified examples (composed from chains, or learned from corroborated refusals) know their
    // verified wording from birth, so the gate applies from the first example. Measured in Phase 14: a composed
    // discount-then-split skill with 2 examples was chosen by the 3B binder for "...then 8% sales tax is added..." tasks.
    const born = /^(chain|gap):/.test(this.list('active').find((s) => s.name === skill)?.source || '');
    if (this.cfg?.skills?.verifyWording !== false && pos.length >= (born ? 1 : this.cfg?.skills?.binderMinExamples ?? 3)) {
      const novel = novelWording(pos, task);
      if (novel.length) return `unverified wording (${novel.slice(0, 4).map((w) => `"${w}"`).join(', ')}): the agent loop answers, and its answer is compared with the skill's`;
    }
    return null;
  }

  /**
   * Judge a binding against the agent loop, with no model call beyond the agent run(s). Measured in Phase 12 run 2: a
   * single agent run is a WEAKER judge than the skill (it answered 2, 4 and 900 km/h for round trips the skill got
   * right), and demoted 15 of 17 correct speed examples. So, as with the Red Queen keys: one dissent is not proof.
   *   - agreement (to the agent's own rounding: "51" agrees with 51.3) verifies the binding;
   *   - on disagreement a SECOND, different agent answers: it siding with the skill verifies the binding, it
   *     corroborating the first agent refutes it;
   *   - if the two agents also disagree with each other, a THIRD agent on a different model answers: any two of the
   *     three agents plus the skill that agree decide (2 of 3), and a three-way split teaches nothing.
   * A refutation carries the corroborated answer: a solved example of a capability the agency does not own yet.
   * Only the agent's last number that does not already appear in the task counts as its answer.
   */
  async #judge(task, out, firstFinal, answer) {
    const inTask = new Set((String(task).match(NUM) || []).map(Number));
    const last = (final) => (String(final ?? '').replace(/,(?=\d{3})/g, '').match(NUM) || []).filter((x) => !inTask.has(Number(x))).at(-1);
    const near = (tok, v) => {
      if (tok === undefined) return null;
      const n = Number(tok), dec = (tok.split('.')[1] || '').length;
      return Math.abs(n - v) <= Math.max(0.01, Math.abs(v) * 0.002) || (dec <= 2 && Math.abs(n - Number(v.toFixed(dec))) < 1e-9);
    };
    const first = last(firstFinal);
    const row = { skillOut: out, agentAnswer: first === undefined ? null : Number(first), second: null, third: null, agree: null };
    if (first === undefined) return row;
    if (near(first, out)) return { ...row, agree: true };
    const secondFinal = answer ? await answer(task, this.cfg?.skills?.secondOpinion || 'lumen').catch(() => null) : null;
    const second = last(secondFinal);
    row.second = second === undefined ? null : Number(second);
    if (second === undefined) return row;
    if (near(second, out)) return { ...row, agree: true, by: 'second opinion sided with the skill' };
    if (near(second, Number(first)) || near(first, Number(second))) return { ...row, agree: false, corroborated: Number(first), by: 'second opinion corroborated the first' };
    // Three different answers so far (skill, first, second). Measured in Phase 13: in most such splits ONE agent was
    // right (189 vs 196.4; 130.8 vs 191), so a third agent on a different model breaks the tie, 2 of 3 as with the
    // Red Queen keys. Any two that agree decide; three-way disagreement still teaches nothing.
    const thirdFinal = answer ? await answer(task, this.cfg?.skills?.thirdOpinion || 'forge_keeper').catch(() => null) : null;
    const third = last(thirdFinal);
    row.third = third === undefined ? null : Number(third);
    if (third === undefined) return row;
    if (near(third, out)) return { ...row, agree: true, by: 'third opinion sided with the skill' };
    if (near(third, Number(first)) || near(first, Number(third))) return { ...row, agree: false, corroborated: Number(first), by: 'third opinion corroborated the first' };
    if (near(third, Number(second)) || near(second, Number(third))) return { ...row, agree: false, corroborated: Number(second), by: 'third opinion corroborated the second' };
    return row;
  }

  /**
   * Shadow verdict: a task the gate declined (block words or unverified wording) was answered by the agent loop; the
   * skill's output on the binding it WOULD have used is judged against that answer. Verified: a positive (its wording
   * is now trusted). Refuted: a negative (its wording becomes block words). Inconclusive: nothing is learned.
   */
  async shadowVerdict(shadow, task, final, { agentId = null, missionId = null } = {}) {
    if (shadow?.candidates) {
      // Ambiguous structure: the candidate whose result the agent loop's answer matches is judged; none or several, nothing.
      const inTask = new Set((String(task).match(NUM) || []).map(Number));
      const tok = (String(final ?? '').replace(/,(?=d{3})/g, '').match(NUM) || []).filter((x) => !inTask.has(Number(x))).at(-1);
      const pick = tok === undefined ? [] : shadow.candidates.filter((c) => nearAnswer(c.out, Number(tok)) || nearAnswer(Number(tok), c.out));
      this.ledger.append('skill.chain_pick', { candidates: shadow.candidates.map((c) => c.signature), agentAnswer: tok ?? null, picked: pick.length === 1 ? pick[0].signature : null }, 'crystallizer');
      if (pick.length !== 1) return null;
      return this.#chainVerdict({ chain: pick[0].chain, signature: pick[0].signature, reason: shadow.reason }, task, final, { agentId, missionId });
    }
    if (shadow?.chain) return this.#chainVerdict(shadow, task, final, { agentId, missionId });
    const skill = this.list('active').find((s) => s.name === shadow?.skill);
    if (!skill || !final) return null;
    const r = await this.#run(skill.code, shadow.input, this.list('active').filter((x) => x.name !== skill.name));
    if (r.error || typeof r.out !== 'number') return null;
    const j = await this.#judge(task, r.out, final, this.agentAnswer);
    if (j.agree !== null) this.#example(skill.name, task, j.agree ? shadow.input : null, j.agree ? 'pos' : 'neg');
    if (j.agree === false && j.corroborated != null) this.#recordGap(skill.name, task, j.corroborated);
    this.ledger.append('skill.shadow', { skill: skill.name, agentId, missionId, ...j, reason: shadow.reason }, 'crystallizer');
    this.bus?.publish('skill.shadow', { skill: skill.name, agree: j.agree });
    if (j.agree) this.#maybeLearn(skill.name);
    return j;
  }

  /**
   * Re-verify positives recorded before wording was verified: those using wording rare among positives (under 25%)
   * are judged like a shadow verdict. Only a refutation corroborated by a second agent demotes one to a negative.
   * `answer(task, agentId?)` returns the agent loop's final text (skill-first off).
   */
  async auditWording(skillName, answer) {
    const pos = this.examples(skillName).filter((e) => e.label === 'pos');
    const skill = this.list('active').find((s) => s.name === skillName);
    const { kinds } = learnBlocks(pos, []).contextBlock;
    const sets = pos.map((e) => wordingOf(e.task, kinds));
    const support = new Map();
    for (const s of sets) for (const w of s) support.set(w, (support.get(w) || 0) + 1);
    const rare = (w) => support.get(w) < pos.length * 0.25;
    const rows = [];
    for (const [i, e] of pos.entries()) {
      const words_ = sets[i].filter(rare);
      if (!words_.length) continue;
      const r = await this.#run(skill.code, e.input, []);
      if (r.error || typeof r.out !== 'number') { rows.push({ task: e.task, rare: words_, agree: null }); continue; }
      const j = await this.#judge(e.task, r.out, await answer(e.task), answer);
      if (j.agree === false) { this.store.run("UPDATE skill_examples SET label = 'neg', input = NULL WHERE id = ?", e.id); if (j.corroborated != null) this.#recordGap(skillName, e.task, j.corroborated); }
      rows.push({ task: e.task, rare: words_, ...j });
    }
    this.ledger.append('binder.audit_wording', { skill: skillName, checked: rows.length, demoted: rows.filter((x) => x.agree === false).length }, 'crystallizer');
    return rows;
  }

  // ---- Skill composition: chains of owned skills (Phase 14) ---------------------------------------------------------

  /** Run a chain in the sandbox: each step's refs are replaced by earlier outputs. */
  async #runChain(steps, active) {
    const outs = [];
    for (const [i, s] of steps.entries()) {
      const sk = active.find((x) => x.name === s.skill);
      if (!sk) return { error: `step ${i + 1}: no active skill ${s.skill}` };
      const input = Object.fromEntries(Object.entries(s.input).map(([k, v]) => [k, v && typeof v === 'object' && Number.isInteger(v.ref) ? outs[v.ref - 1] : v]));
      const r = await this.#run(sk.code, input, active.filter((x) => x.name !== sk.name));
      if (r.error) return { error: `step ${i + 1} (${s.skill}): ${r.error}` };
      if (i < steps.length - 1 && typeof r.out !== 'number') return { error: `step ${i + 1} (${s.skill}) returned a non-number, which cannot feed the next step` };
      outs.push(r.out);
    }
    return { out: outs.at(-1), outs };
  }

  /** A verified composition answers: every step's skill is credited, and the route is ledgered with the chain. */
  #commitChain(steps, signature, ran, ctx) {
    for (const s of steps) this.store.run('UPDATE skills SET uses = uses + 1, updated = ? WHERE name = ? AND status = ?', nowIso(), s.skill, 'active');
    const active = this.list('active');
    const pseudo = { id: null, chain: steps, name: steps.map((s) => s.skill).join(' > '), description: `A verified composition of owned skills (${signature}).`,
      code_sha256: sha256(steps.map((s) => active.find((x) => x.name === s.skill)?.code_sha256 || s.skill).join('|')) };
    this.ledger.append('skill.chain_route', { signature, outs: ran.outs, agentId: ctx.agentId, missionId: ctx.missionId }, 'crystallizer');
    // A trusted chain route is an example of the composed skill of the same shape (if there is one): its binder learns
    // from it, so the next task of this shape needs no model call at all.
    const composed = active.find((s) => s.source === `chain:${signature}`.slice(0, 300));
    if (composed && ctx.privacy === 'normal' && ctx.task) {
      this.#example(composed.name, ctx.task, chainInput(steps, composeChainSkill(steps, active).slots), 'pos');
      this.#maybeLearn(composed.name);
    }
    return this.#commitRoute(pseudo, Object.fromEntries(steps.map((s, i) => [`step${i + 1}`, { [s.skill]: s.input }])), ran.out, ctx);
  }

  chains(signature = null) {
    return this.store.all(`SELECT * FROM skill_chains ${signature ? 'WHERE signature = ?' : ''} ORDER BY created`, ...(signature ? [signature] : [])).map((r) => ({ ...r, steps: JSON.parse(r.steps) }));
  }

  /** A judged composition: verified chains count toward trust, and enough of them become a composed skill. */
  async #chainVerdict(shadow, task, final, { agentId = null, missionId = null } = {}) {
    const ran = await this.#runChain(shadow.chain, this.list('active'));
    if (ran.error || typeof ran.out !== 'number') return null;
    const j = await this.#judge(task, ran.out, final, this.agentAnswer);
    const sig = shadow.signature || chainSignature(shadow.chain);
    if (j.agree !== null) {
      const t = String(task).slice(0, 3000);
      if (!this.store.get('SELECT id FROM skill_chains WHERE signature = ? AND task = ?', sig, t)) {
        this.store.run('INSERT INTO skill_chains (id, signature, task, steps, out, label, created) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('ch'), sig, t, JSON.stringify(shadow.chain), ran.out, j.agree ? 'verified' : 'refuted', nowIso());
      }
    }
    this.ledger.append('skill.shadow', { chain: sig, agentId, missionId, ...j, reason: shadow.reason }, 'crystallizer');
    this.bus?.publish('skill.shadow', { chain: sig, agree: j.agree });
    if (j.agree) this.#maybeCompose(sig);
    return j;
  }

  #maybeCompose(signature) {
    const cfg = this.cfg?.skills || {};
    if (cfg.composeSkills === false) return;
    const n = this.store.get("SELECT COUNT(*) AS n FROM skill_chains WHERE signature = ? AND label = 'verified' AND composed IS NULL", signature).n;
    if (n < (cfg.composeMin ?? 2)) return;
    this.composeQueue = (this.composeQueue || Promise.resolve()).then(() => this.composeChain(signature).catch((e) => this.bus?.publish('skill.reject', { name: null, reason: e.message })));
  }

  /**
   * Crystallize a verified chain shape into a composed skill, written by the agency itself: no model writes this code.
   * Admission: every verified chain of that shape is reproduced by the composed code from inputs grounded in its task
   * (the answer key, all-or-nothing, since nothing here is a model's guess). Its examples seed a learned binder.
   */
  async composeChain(signature) {
    const rows = this.chains(signature).filter((r) => r.label === 'verified').slice(-8);
    if (rows.length < 2) return { admitted: false, reason: 'fewer than 2 verified chains of this shape' };
    const active = this.list('active');
    const c = composeChainSkill(rows[0].steps, active);
    const fail = (reason, verification = {}) => {
      this.ledger.append('skill.reject', { source: `chain:${signature}`, name: c.name, reason }, 'crystallizer');
      return { admitted: false, reason, verification };
    };
    if (this.store.get('SELECT id FROM skills WHERE name = ?', c.name)) return fail(`a skill named ${c.name} already exists`);
    if (!rows[0].steps.every((s) => active.some((x) => x.name === s.skill))) return fail('a skill in the chain is no longer active');
    const keyRows = [];
    for (const r of rows) {
      const input = chainInput(r.steps, c.slots);
      const g = groundingProblem(input, c.params, r.task);
      const run = g ? null : await this.#run(c.code, input, active);
      keyRows.push({ task: r.task, input, expected: r.out, out: run?.out ?? null, ok: !g && !run.error && nearAnswer(run.out, r.out), problem: g || run?.error || null });
    }
    if (keyRows.some((x) => !x.ok)) return fail(`reproduces ${keyRows.filter((x) => x.ok).length}/${keyRows.length} verified chains`, { keyRows });
    const verification = { method: 'composed from verified skills (no model wrote this code) + answer key', answerKey: `${keyRows.length}/${keyRows.length}`, signature, steps: rows[0].steps.map((s) => s.skill),
      rows: keyRows.map((x) => ({ input: x.input, out: x.out })) };
    const id = newId('sk'), codeSha = sha256(c.code);
    this.store.run('INSERT INTO skills (id, name, description, params, code, code_sha256, status, source, verification, uses, failures, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
      id, c.name, c.description, JSON.stringify(c.params), c.code, codeSha, 'active', `chain:${signature}`.slice(0, 300), JSON.stringify(verification), nowIso(), nowIso());
    this.#register(this.list('active').find((s) => s.id === id));
    for (const [i, r] of rows.entries()) {
      this.store.run('UPDATE skill_chains SET composed = ? WHERE id = ?', c.name, r.id);
      this.#example(c.name, r.task, keyRows[i].input, 'pos');
    }
    this.ledger.append('skill.compose', { id, name: c.name, signature, chains: rows.length, codeSha256: codeSha }, 'crystallizer');
    this.bus?.publish('skill.admit', { name: c.name, inputs: rows.length });
    this.#maybeLearn(c.name);
    return { admitted: true, skill: { name: c.name, description: c.description, codeSha256: codeSha }, reason: `composed from ${rows[0].steps.length} owned skills; reproduces ${rows.length} verified chain(s)`, verification, code: c.code };
  }

  // ---- Capability gaps: refusals become skills (Phase 13) ------------------------------------------------------------

  /**
   * A task this skill refused, whose answer two different agents corroborated, is a solved example of a capability
   * the agency does not own yet. Its markers are the wording no positive of the skill used ("sales", "tax", "added").
   */
  #recordGap(skill, task, answer) {
    if (typeof answer !== 'number' || !Number.isFinite(answer)) return;
    const t = String(task).slice(0, 3000);
    if (this.store.get("SELECT id FROM skill_gaps WHERE skill = ? AND task = ?", skill, t)) return;
    const markers = novelWording(this.examples(skill).filter((e) => e.label === 'pos'), t);
    this.store.run('INSERT INTO skill_gaps (id, skill, task, answer, markers, status, created) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('gp'), skill, t, answer, JSON.stringify(markers), 'open', nowIso());
    this.ledger.append('skill.gap', { skill, answer, markers }, 'crystallizer');
    this.bus?.publish('skill.gap', { skill, markers });
    this.#maybeLearnGaps(skill);
  }

  gaps(skill = null) {
    return this.store.all(`SELECT * FROM skill_gaps ${skill ? 'WHERE skill = ?' : ''} ORDER BY created`, ...(skill ? [skill] : [])).map((g) => ({ ...g, markers: JSON.parse(g.markers || '[]') }));
  }

  /** Families of open gaps: gaps whose markers overlap (union-find), largest first. */
  gapFamilies(skill) {
    const open = this.gaps(skill).filter((g) => g.status === 'open' && g.markers.length);
    const parent = open.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) if (open[i].markers.some((w) => open[j].markers.includes(w))) parent[find(i)] = find(j);
    const fam = new Map();
    open.forEach((g, i) => { const r = find(i); fam.set(r, [...(fam.get(r) || []), g]); });
    return [...fam.values()].sort((a, b) => b.length - a.length);
  }

  #maybeLearnGaps(skill) {
    const cfg = this.cfg?.skills || {};
    if (cfg.learnGaps === false) return;
    const fam = this.gapFamilies(skill)[0];
    const min = cfg.gapMin ?? 3;
    const tried = this.store.kvGet(`gap:tried:${skill}`, 0);
    if (!fam || fam.length < min || fam.length <= tried) return;
    this.store.kvSet(`gap:tried:${skill}`, fam.length);
    this.gapQueue = (this.gapQueue || Promise.resolve()).then(() => this.learnGap(skill).catch((e) => this.bus?.publish('skill.reject', { name: null, reason: e.message })));
  }

  /**
   * Crystallize the largest family of open gaps into a NEW skill: the refused tasks and their corroborated answers are
   * the solved examples, and the new skill must reproduce those answers (the answer key) on top of differential testing.
   */
  async learnGap(skill, { signal } = {}) {
    const fam = this.gapFamilies(skill)[0];
    if (!fam || fam.length < 2) return { admitted: false, reason: 'no family of at least 2 corroborated gaps' };
    const parent = this.list('active').find((s) => s.name === skill);
    const family = fam.slice(-8);
    const markers = [...new Set(family.flatMap((g) => g.markers))];
    const solved = family.map((g, i) => `${i + 1}. ${g.task}\n   Answer: ${g.answer}`).join('\n');
    const text = `Solved tasks. Each answer was computed independently by two different agents, and they agreed:\n${solved}\n\nThe existing skill skill_${skill} (${parent?.description || ''}) does NOT answer these tasks: they also involve ${markers.slice(0, 6).map((w) => `"${w}"`).join(', ')}. Write the general function that does.`;
    const r = await this.crystallize({ kind: 'gap', ref: skill, text }, { signal, answerKey: family.map((g) => ({ task: g.task, answer: g.answer })) });
    if (r.admitted) {
      for (const g of family) this.store.run("UPDATE skill_gaps SET status = 'learned', resolved_by = ? WHERE id = ?", r.skill.name, g.id);
      this.ledger.append('skill.gap_learned', { parent: skill, skill: r.skill.name, gaps: family.length, markers, answerKey: r.verification?.answerKey }, 'crystallizer');
      this.#maybeLearn(r.skill.name);
    }
    return { ...r, family: family.length, markers };
  }

  // ---- Learned binders: the routing step, crystallized -------------------------------------------------------------

  #example(skill, task, input, label) {
    const t = String(task).slice(0, 3000);
    if (this.store.get('SELECT id FROM skill_examples WHERE skill = ? AND task = ? AND label = ?', skill, t, label)) return;
    this.store.run('INSERT INTO skill_examples (id, skill, task, input, label, created) VALUES (?, ?, ?, ?, ?, ?)', newId('se'), skill, t, input ? JSON.stringify(input) : null, label, nowIso());
  }

  examples(skill) {
    return this.store.all('SELECT * FROM skill_examples WHERE skill = ? ORDER BY created', skill).map((r) => ({ ...r, input: r.input ? JSON.parse(r.input) : null }));
  }

  binder(skill) { return this.store.get("SELECT * FROM skill_binders WHERE skill = ? AND status = 'active'", skill) || null; }
  binders() { return this.store.all('SELECT id, skill, code_sha256, status, verification, examples, uses, created FROM skill_binders ORDER BY created').map((b) => ({ ...b, verification: JSON.parse(b.verification || '{}') })); }

  async #runBinder(code, task) {
    const r = await this.sandbox(`${code}\nconst __out = bind(${JSON.stringify(String(task))});\nconsole.log(JSON.stringify({ out: __out === undefined ? null : __out }));`, { timeoutMs: 3000 });
    // Keep the message ("SyntaxError: ..."), not just the "[stdin]:1" location line. Measured: every binder failure
    // read "[stdin]:1" until this showed the real cause (double-escaped newlines).
    if (r.exitCode !== 0 || r.timedOut) return { error: (String(r.stderr).split('\n').find((l) => /Error/.test(l)) || r.stderr || 'failed').slice(0, 160) };
    try { return { out: JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1)).out }; } catch { return { error: 'no JSON output' }; }
  }

  /**
   * Examples needed before a binder is learned. A skill born from verified examples (composed from chains, or learned
   * from corroborated refusals) starts with 2 that are already verified; measured in Phase 14, waiting for a third
   * left composed skills unrouted, because the 3B binder rarely picked them among six offered skills.
   */
  #minExamples(skill) {
    const born = /^(chain|gap):/.test(this.list('active').find((s) => s.name === skill)?.source || '');
    const min = this.cfg?.skills?.binderMinExamples ?? 3;
    return born ? Math.min(2, min) : min;
  }

  /** Learn automatically once there are enough fresh positive examples (one at a time, in the background). */
  #maybeLearn(skill) {
    const cfg = this.cfg?.skills || {};
    if (cfg.learnBinders === false) return;
    const pos = this.examples(skill).filter((e) => e.label === 'pos').length;
    const min = this.#minExamples(skill);
    const current = this.binder(skill);
    const tried = this.store.kvGet(`binder:tried:${skill}`, 0);
    // First binder at `min` examples; relearn once 3 new examples exist that the active binder had not seen.
    if (pos < min || pos <= tried || (current && pos < current.examples + 3)) return;
    this.store.kvSet(`binder:tried:${skill}`, pos);
    this.binderQueue = (this.binderQueue || Promise.resolve()).then(() => this.learnBinder(skill).catch((e) => this.bus?.publish('binder.reject', { skill, reason: e.message })));
  }

  /**
   * Crystallize the routing step for one skill: a pure `function bind(task)` that returns the skill's input or null.
   * Verification, all in the sandbox:
   *   - every recorded positive except one must reproduce the model's binding (same input, or same skill output);
   *   - the held-out positive, which the writer never saw, must too: memorizing the examples does not generalize;
   *   - every negative (recorded refusals plus near-miss tasks a blind model writes) must give null or fail grounding:
   *     a false route costs correctness, so safety is all-or-nothing;
   *   - blind-written paraphrases measure coverage (at least half must bind correctly).
   */
  async learnBinder(skillName, { signal } = {}) {
    const skill = this.list('active').find((s) => s.name === skillName);
    if (!skill) throw new Error(`no active skill ${skillName}`);
    // Re-audit stored positives with today's structural gates: a binding recorded before a gate existed (measured: a
    // 3B binder routed "how much did I save" to a final-price skill) becomes a counter-example, never training data.
    let audited = 0;
    for (const e of this.examples(skillName).filter((x) => x.label === 'pos')) {
      if (bindingProblem(e.input, skill, e.task)) { this.store.run("UPDATE skill_examples SET label = 'neg', input = NULL WHERE id = ?", e.id); audited++; }
    }
    if (audited) this.ledger.append('binder.audit', { skill: skillName, demoted: audited }, 'crystallizer');
    const ex = this.examples(skillName);
    const pos = ex.filter((e) => e.label === 'pos'), neg = ex.filter((e) => e.label === 'neg');
    const min = this.#minExamples(skillName);
    const fail = (reason, verification = {}) => {
      this.ledger.append('binder.reject', { skill: skillName, reason, examples: pos.length }, 'crystallizer');
      this.bus?.publish('binder.reject', { skill: skillName, reason });
      return { admitted: false, reason, verification };
    };
    if (pos.length < min) return fail(`only ${pos.length} positive example(s); ${min} needed`);
    const sig = `${skill.name}: ${skill.description} Input schema: ${JSON.stringify(skill.params)}`;

    // 1. Induction, no model: one selector per parameter consistent with every example, checked leave-one-out.
    //    An example the rest of the evidence refuses is DISPUTED (measured: a misroute recorded as a positive was the
    //    only leave-one-out miss) and excluded; too many disputes means the examples do not agree on one rule.
    let method = null, code = null, spec = null, writer = null, train = pos, heldOut = null, disputed = [], loo = null;
    const firstLoo = leaveOneOut(pos, neg, skill);
    const misses = firstLoo.filter((x) => !x.ok && !x.novel); // novel units are kept: they widen the unit set
    if (this.cfg?.skills?.binderInduction !== false && misses.length <= Math.floor(pos.length * 0.25) && pos.length - misses.length >= min) {
      const kept = pos.filter((e) => !misses.some((m) => m.task === e.task));
      const ind = induce(kept, neg, skill);
      loo = leaveOneOut(kept, neg, skill);
      if (ind.spec && loo.every((x) => x.ok || x.novel)) { method = 'induction'; spec = ind.spec; code = compileSpec(spec); train = kept; disputed = pos.filter((e) => !kept.includes(e)); }
    }
    // 2. Fallback: a model writes the parser from all but one example, which it never sees.
    if (!code) {
      heldOut = pos.at(-1); train = pos.slice(0, -1);
      const w = await this.router.chat({
        role: 'code', privacy: 'private', json: true, temperature: 0.2, maxTokens: 1600, signal,
        messages: [
          { role: 'system', content: 'You write a pure JavaScript parser `function bind(task) { ... }` that reads a natural-language task and returns the input object for a given function, or null when the task is NOT asking for exactly what that function computes. Use regular expressions and string logic only: no I/O, network, randomness or dates. It must generalize to new wordings and numbers: never hard-code the example texts or their values. Prefer returning null over guessing. Reply with JSON only.' },
          { role: 'user', content: `Function: ${sig}\n\nTasks that SHOULD bind, with the correct input:\n${train.map((e) => `- ${JSON.stringify(e.task)} -> ${JSON.stringify(e.input)}`).join('\n')}\n\n${neg.length ? `Tasks that must return null:\n${neg.slice(-6).map((e) => `- ${JSON.stringify(e.task)}`).join('\n')}\n\n` : ''}Return {"code":"function bind(task) { ... }"}` },
        ],
      });
      code = normalizeCode(parseJson(w.text).code);
      method = 'model-written'; writer = w.model;
      if (!code.includes('function bind')) return fail(`malformed binder proposal (induction: ${misses.length ? `${misses.length} disputed example(s)` : 'no consistent rule'})`);
    }

    // Blind tests from a different role: new paraphrases with their correct input, and near-miss tasks.
    let synth = { positives: [], negatives: [] };
    try {
      const t = await this.router.chat({
        role: 'reason', privacy: 'private', json: true, temperature: 0.4, maxTokens: 1400, signal,
        messages: [
          { role: 'system', content: 'You write test cases for a task router. Reply with JSON only.' },
          { role: 'user', content: `Function: ${sig}\nExample of a task it answers: ${JSON.stringify(train[0].task)} -> ${JSON.stringify(train[0].input)}\n\nWrite 4 NEW tasks in different wordings, with different numbers, that this function answers completely, each with its correct input. Then write 3 near-miss tasks that look similar (same topic, numbers present) but ask for something this function does NOT compute.\nReturn {"positives":[{"task":"...","input":{...}}],"negatives":["..."]}` },
        ],
      });
      const p = parseJson(t.text);
      synth = { positives: (p.positives || []).filter((x) => x && typeof x.task === 'string' && x.input && typeof x.input === 'object').slice(0, 6), negatives: (p.negatives || []).filter((x) => typeof x === 'string').slice(0, 6) };
    } catch { /* blind tests are extra evidence; recorded examples still decide */ }

    const library = this.list('active').filter((x) => x.name !== skillName);
    const agrees = async (task, expected) => {
      const r = await this.#runBinder(code, task);
      if (r.error || !r.out || typeof r.out !== 'object' || bindingProblem(r.out, skill, task)) return { ok: false, got: r.out ?? null, error: r.error };
      if (sameInput(r.out, expected)) return { ok: true, got: r.out };
      const [a, b] = await Promise.all([this.#run(skill.code, r.out, library), this.#run(skill.code, expected, library)]);
      return { ok: !a.error && !b.error && sameOutput(a.out, b.out), got: r.out };
    };
    const refuses = async (task) => {
      const r = await this.#runBinder(code, task);
      return { ok: Boolean(r.error) || r.out === null || typeof r.out !== 'object' || Boolean(bindingProblem(r.out, skill, task)), got: r.out ?? null };
    };
    const check = async () => {
      const rows = { train: [], heldOut: null, negatives: [], synthPos: [] };
      for (const e of train) rows.train.push({ task: e.task, ...(await agrees(e.task, e.input)) });
      // Induction's held-out check is leave-one-out over every kept example; the model path holds out one example.
      rows.heldOut = heldOut ? { task: heldOut.task, ...(await agrees(heldOut.task, heldOut.input)) } : { task: 'leave-one-out', ok: loo.every((x) => x.ok || x.novel), loo: `${loo.filter((x) => x.ok).length}/${loo.length}${loo.some((x) => x.novel) ? ` (+${loo.filter((x) => x.novel).length} novel unit)` : ''}` };
      for (const t of [...neg.map((e) => e.task), ...synth.negatives]) rows.negatives.push({ task: t, ...(await refuses(t)) });
      for (const s of synth.positives) rows.synthPos.push({ task: s.task, ...(await agrees(s.task, s.input)) });
      return rows;
    };
    let rows = await check();
    // Unit widening (Phase 14). Measured: a composed skill's binder learned units ["friends"] from its examples and bound
    // only 1 of 4 blind paraphrases ("each of the 4 PEOPLE"). A blind paraphrase that binds to exactly its stated input
    // once a unit is allowed teaches that unit; the widened binder is then verified again from scratch (recorded
    // bindings, every negative, every paraphrase), so a unit that lets a near-miss through is never admitted.
    let widened = null;
    if (method === 'induction' && spec && synth.positives.some((_, i) => !rows.synthPos[i].ok)) {
      const add = {};
      for (const [i, sp] of synth.positives.entries()) {
        if (rows.synthPos[i].ok) continue;
        const loose = { ...spec, params: Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, { ...p, units: undefined }])) };
        const got = applySpec(loose, sp.task);
        if (!got || !sameInput(got, sp.input)) continue;
        for (const [k, p] of Object.entries(spec.params)) {
          if (!p.units) continue;
          const tok = numberTokens(sp.task).find((t) => t.kind === p.kind && Math.abs(t.v * p.scale - got[k]) < 1e-9 && t.unit);
          if (tok && !p.units.includes(tok.unit)) (add[k] ??= new Set()).add(tok.unit);
        }
      }
      if (Object.keys(add).length) {
        const wider = { ...spec, params: Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, add[k] ? { ...p, units: [...new Set([...p.units, ...add[k]])].sort() } : p])) };
        const prev = { spec, code };
        spec = wider; code = compileSpec(spec);
        const again = await check();
        if (again.train.every((x) => x.ok) && again.negatives.every((x) => x.ok)) { rows = again; widened = Object.fromEntries(Object.entries(add).map(([k, v]) => [k, [...v]])); }
        else { spec = prev.spec; code = prev.code; }
      }
    }

    const coverage = rows.synthPos.length ? rows.synthPos.filter((x) => x.ok).length / rows.synthPos.length : null;
    const verification = { train: `${rows.train.filter((x) => x.ok).length}/${rows.train.length}`, heldOut: rows.heldOut.ok,
      negatives: `${rows.negatives.filter((x) => x.ok).length}/${rows.negatives.length} refused`, coverage, widened: widened || undefined, method, writer, spec, disputed: disputed.map((e) => e.task), rows };
    if (rows.train.some((x) => !x.ok)) return fail(`does not reproduce ${rows.train.filter((x) => !x.ok).length} recorded binding(s)`, verification);
    if (!rows.heldOut.ok) return fail('fails the held-out example it never saw (memorized, not general)', verification);
    const falsePos = rows.negatives.filter((x) => !x.ok);
    if (falsePos.length) return fail(`would route ${falsePos.length} task(s) that must not bind, e.g. ${JSON.stringify(falsePos[0].task).slice(0, 120)}`, verification);
    if (coverage !== null && coverage < 0.5) return fail(`binds only ${Math.round(coverage * 100)}% of blind paraphrases`, verification);

    for (const e of disputed) this.store.run("UPDATE skill_examples SET label = 'disputed' WHERE id = ?", e.id);
    this.store.run("UPDATE skill_binders SET status = 'retired', updated = ? WHERE skill = ? AND status = 'active'", nowIso(), skillName);
    const id = newId('sb'), codeSha = sha256(code);
    this.store.run('INSERT INTO skill_binders (id, skill, code, code_sha256, status, verification, examples, uses, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      id, skillName, code, codeSha, 'active', JSON.stringify(verification), pos.length, nowIso(), nowIso());
    this.ledger.append('binder.admit', { id, skill: skillName, codeSha256: codeSha, examples: train.length, disputed: disputed.length, negatives: rows.negatives.length, coverage, method, writer }, 'crystallizer');
    this.bus?.publish('binder.admit', { skill: skillName, coverage });
    return { admitted: true, binder: { id, skill: skillName, codeSha256: codeSha }, reason: `${method === 'induction' ? `induced with no model from ${train.length} example(s), each predicted from the others${disputed.length ? ` (${disputed.length} disputed example(s) excluded)` : ''}` : `model-written; reproduces ${pos.length} recorded binding(s) incl. one held out`}, refuses ${rows.negatives.length} negative(s)${coverage !== null ? `, binds ${Math.round(coverage * 100)}% of blind paraphrases` : ''}`, verification };
  }

  /** The critic rejected a routed answer: its example becomes a counter-example, and a learned binder that made it is retired. */
  rejectRoute(skill, task, binderId = null, reason = 'critic rejected') {
    const t = String(task).slice(0, 3000);
    this.store.run("DELETE FROM skill_examples WHERE skill = ? AND task = ? AND label = 'pos'", skill, t);
    this.#example(skill, t, null, 'neg');
    const c = contested(this.examples(skill).filter((e) => e.label === 'pos'), t);
    for (const e of c.examples) this.store.run("UPDATE skill_examples SET label = 'disputed' WHERE id = ?", e.id);
    if (c.examples.length || c.tooMany) this.ledger.append('binder.contest', { skill, words: c.words, disputed: c.examples.length, tooMany: c.tooMany || 0 }, 'crystallizer');
    if (binderId) this.retireBinder(skill, reason);
    // Absorb the lesson now, not after 3 more examples: the relearned binder (and its block words, which also gate the
    // model binder) must refuse this task and others worded like it.
    if (this.cfg?.skills?.learnBinders !== false) this.binderQueue = (this.binderQueue || Promise.resolve()).then(() => this.learnBinder(skill).catch((e) => this.bus?.publish('binder.reject', { skill, reason: e.message })));
  }

  /** A learned binder whose route the critic rejected is withdrawn; the skill stays, and the model binder takes over. */
  retireBinder(skill, reason = 'operator') {
    const ok = this.store.run("UPDATE skill_binders SET status = 'retired', updated = ? WHERE skill = ? AND status = 'active'", nowIso(), skill).changes > 0;
    if (ok) this.ledger.append('binder.retire', { skill, reason }, 'crystallizer');
    return ok;
  }

  /** The final answer a routed task returns: the exact result plus its provenance. */
  static answerText(skill, input, out, privacy = 'normal') {
    const shown = typeof out === 'number' ? String(Number(out.toPrecision(12))) : typeof out === 'string' ? out : `\n\n\`\`\`json\n${JSON.stringify(out, null, 2)}\n\`\`\``;
    const inp = privacy === 'normal' ? ` on input \`${JSON.stringify(input)}\`` : '';
    if (skill.chain) return `**Answer: ${shown}**\n\nComputed exactly by a verified chain of the agency's crystallized skills: ${skill.chain.map((s) => `\`skill_${s.skill}\``).join(' → ')}${inp}. No model reasoning produced this result.`;
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
    const curve = routes.map((r, i) => { avoided += Math.max(0, (r.baselineMin ?? 1) - (r.spent ?? 1)); return { at: r.ts, routes: i + 1, avoided, skill: r.skill, zeroCall: r.spent === 0 }; });
    return { active: active.length, retired: this.list('retired').length, uses, failures: active.reduce((s, k) => s + k.failures, 0), modelCallsAvoided: uses, toolCalls: calls,
      routed: routes.length, zeroCall: routes.filter((r) => r.spent === 0).length, binders: this.binders().filter((b) => b.status === 'active').length, examples: this.store.get('SELECT COUNT(*) AS n FROM skill_examples').n, routeMisses: misses, routeRejected: rejected, bindCalls: routes.length + misses, callsAvoidedMin: avoided, curve: curve.slice(-200) };
  }
}
