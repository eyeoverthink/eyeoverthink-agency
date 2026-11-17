// Binder induction: learn how to bind a skill from its own recorded bindings, with no model at all.
//
// Measured in Phase 11: a 7B code model asked to write a regex parser from examples produced parsers that returned
// null on 6-7 of 7 recorded bindings (one was not even valid JavaScript). But the examples themselves already say how
// binding works ("original_price is the number after $, discount1 is the first percentage / 100"). Induction finds,
// for every parameter, ONE selector (number kind x position x scale) consistent with every example, records the
// task "shape" (how many numbers of each kind), and learns question words that only ever appeared in tasks the skill
// must refuse. Leave-one-out: each example must be predicted by the spec induced from all the others.
// The spec compiles to a self-contained `function bind(task)` so it runs, hashes and verifies like any binder.

const KINDS = ['currency', 'percent', 'plain'];
const round = (x) => Math.round(x * 1e9) / 1e9;

/** Numbers in a task, each tagged by kind: "$40" currency, "25%" percent, anything else plain. */
export function numberTokens(task) {
  const out = [];
  const re = /(\$\s?)?(?<![\w.])(-?\d+(?:\.\d+)?)(\s*%|\s?percent\b)?(?:\s?([a-z]+(?:\/[a-z]+)?))?/gi;
  let m;
  while ((m = re.exec(String(task)))) out.push({ v: Number(m[2]), kind: m[1] ? 'currency' : m[3] ? 'percent' : 'plain', unit: !m[1] && !m[3] && m[4] ? m[4].toLowerCase() : null });
  return out;
}

export const shapeOf = (toks) => KINDS.map((k) => toks.filter((t) => t.kind === k).length).join(',');

/** Content words of the question sentence (the last sentence with a "?", else the last sentence). Self-contained. */
export function questionWords(task) {
  const STOPW = ['the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'much', 'many', 'does', 'did', 'was', 'are', 'its', 'their', 'your', 'you', 'now', 'then', 'after', 'from', 'into', 'over', 'whole', 'all'];
  const parts = String(task).split(/(?<=[.!?])\s+/);
  const q = [...parts].reverse().find((x) => x.includes('?')) || parts[parts.length - 1] || '';
  return (q.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOPW.includes(w));
}

const declaresDecimal = (p) => /\b(decimal|fraction)\b/i.test(`${p?.description || ''} ${p?.items?.description || ''}`);
const eq = (a, b) => (Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i])) : typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9));

function pick(toks, s) {
  const list = toks.filter((t) => s.kind === 'any' || t.kind === s.kind);
  if (s.all) return list.map((t) => round(t.v * s.scale));
  const t = s.k >= 0 ? list[s.k] : list[list.length + s.k];
  if (t === undefined || (s.units && !s.units.includes(t.unit))) return undefined;
  return round(t.v * s.scale);
}

/** Induce a binding spec from positive examples; null-safe. Returns { spec } or { error }. */
export function induce(pos, neg, skill) {
  if (!pos.length) return { error: 'no positive examples' };
  const props = skill.params?.properties || {};
  const keys = Object.keys(pos[0].input || {}).filter((k) => pos.every((e) => e.input && k in e.input));
  if (!keys.length) return { error: 'examples share no input keys' };
  const toks = pos.map((e) => numberTokens(e.task));
  const shapes = [...new Set(toks.map(shapeOf))];
  if (shapes.length > 2) return { error: `examples have ${shapes.length} different number shapes` };
  const maxN = Math.max(...toks.map((t) => t.length));
  const params = {};
  for (const key of keys) {
    const p = props[key] || {};
    const scales = declaresDecimal(p) ? [0.01, 1] : [1];
    const cands = [];
    for (const kind of [...KINDS, 'any']) for (const scale of scales) {
      if (p.type === 'array' || Array.isArray(pos[0].input[key])) cands.push({ kind, all: true, scale });
      else for (let k = 0; k < maxN; k++) cands.push({ kind, k, scale }, { kind, k: -(k + 1), scale });
    }
    const hit = cands.find((s) => pos.every((e, i) => eq(pick(toks[i], s), e.input[key])));
    if (!hit) return { error: `no single rule finds ${key} in every example` };
    // Plain numbers carry their units: measured, positions alone could not tell "40 mph ... 60 mph" from
    // "120 miles in 2 hours", so the speed binder was (correctly) refused until units were learned.
    if (hit.kind === 'plain' || hit.kind === 'any') {
      const units = toks.map((t) => { const l = t.filter((x) => hit.kind === 'any' || x.kind === hit.kind); return (hit.k >= 0 ? l[hit.k] : l[l.length + hit.k])?.unit; });
      if (units.every(Boolean)) hit.units = [...new Set(units)].sort();
    }
    params[key] = hit;
  }
  // A block word must never occur anywhere in a positive task: measured, a single counter-example otherwise taught
  // the binder to refuse every task containing 'off'.
  const posQ = new Set(pos.flatMap((e) => String(e.task).toLowerCase().match(/[a-z]{3,}/g) || []));
  const blockWords = [...new Set(neg.flatMap((e) => questionWords(e.task)))].filter((w) => !posQ.has(w)).sort();
  return { spec: { shapes, params, blockWords } };
}

/** Apply a spec to a task (the same logic the compiled binder runs). */
export function applySpec(spec, task) {
  const toks = numberTokens(task);
  if (!spec.shapes.includes(shapeOf(toks))) return null;
  const q = questionWords(task);
  if (spec.blockWords.some((w) => q.includes(w))) return null;
  const out = {};
  for (const [k, s] of Object.entries(spec.params)) { const v = pick(toks, s); if (v === undefined) return null; out[k] = v; }
  return out;
}

/** Leave-one-out: every example must be predicted by the spec induced from all the others. */
export function leaveOneOut(pos, neg, skill) {
  return pos.map((e, i) => {
    const rest = pos.filter((_, j) => j !== i);
    const r = induce(rest, neg, skill);
    const got = r.spec ? applySpec(r.spec, e.task) : null;
    const ok = Boolean(got) && Object.keys(e.input).every((k) => eq(got[k], e.input[k]));
    // A miss only because the held-out example has a unit no other example has ("knots") is novelty, not contradiction.
    let novel = false;
    if (!ok && r.spec) {
      const loose = { ...r.spec, params: Object.fromEntries(Object.entries(r.spec.params).map(([k, p]) => [k, { ...p, units: undefined }])) };
      const g2 = applySpec(loose, e.task);
      novel = Boolean(g2) && Object.keys(e.input).every((k) => eq(g2[k], e.input[k]));
    }
    return { task: e.task, ok, novel, got, error: r.error };
  });
}

/** Compile a spec into a self-contained, sandbox-runnable `function bind(task)`. */
export function compileSpec(spec) {
  return [
    'function bind(task) {',
    `  const SPEC = ${JSON.stringify(spec)};`,
    `  const KINDS = ${JSON.stringify(KINDS)};`,
    `  const round = ${round.toString()};`,
    `  ${numberTokens.toString()}`,
    `  ${questionWords.toString()}`,
    `  const shapeOf = ${shapeOf.toString()};`,
    `  ${pick.toString()}`,
    `  ${applySpec.toString()}`,
    '  return applySpec(SPEC, task);',
    '}',
  ].join('\n');
}
