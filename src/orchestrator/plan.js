// Planning helpers: plan prompt, plan validation (agent mapping, dependency repair, cycle breaking).
import { extractJson, slug } from '../core/util.js';

export function planPrompt(goal, agents, { maxTasks, context = '', previous = null } = {}) {
  const roster = agents.filter((a) => !['genesis', 'dreamer'].includes(a.id))
    .map((a) => `- ${a.id} (${a.role}): ${a.description} Tools: ${a.tools.join(', ') || 'none'}`).join('\n');
  return [
    { role: 'system', content: 'You are Genesis, director of an AI agency. You decompose goals into a small dependency graph of tasks for specialist agents. Reply with JSON only.' },
    {
      role: 'user', content: [
        `Goal:\n${goal}`,
        context ? `\nRelevant context from memory:\n${context}` : '',
        previous ? `\nThe previous plan ran into trouble. State so far:\n${previous}\nProduce a revised plan for the REMAINING work only.` : '',
        `\nAvailable specialists:\n${roster}`,
        `\nReturn: {"summary": "<one sentence>", "tasks": [{"id": "t1", "title": "...", "agent": "<specialist id>", "instructions": "<precise, self-contained instructions with the expected output>", "deps": ["<task ids this needs>"], "privacy": "normal|private"}]}`,
        `Rules: at most ${maxTasks} tasks; use the fewest tasks that fully achieve the goal; every task must name exactly one specialist from the list;`,
        'deps only reference earlier task ids; independent tasks have no deps so they run in parallel;',
        'mark "privacy":"private" for tasks handling personal or confidential data (they stay on local/on-device models);',
        'the last task should produce the final deliverable (usually lumen) and depend on what it needs.',
      ].join('\n'),
    },
  ];
}

function nearestAgent(name, agents) {
  const n = String(name || '').toLowerCase();
  const exact = agents.find((a) => a.id === n || a.name.toLowerCase() === n);
  if (exact) return exact.id;
  const keywords = [
    [/research|search|scout|web|source/, 'spearhead'], [/code|engineer|program|build|script|implement/, 'forge_keeper'],
    [/analy|math|number|calculat|quant|data/, 'tycho'], [/write|draft|doc|report|summar|scribe|brief/, 'lumen'],
    [/review|critic|verify|check|judge/, 'solon'], [/memory|archiv|record|remember/, 'helix'],
    [/secur|risk|privacy|safety/, 'sentinel'], [/context|history|recall/, 'ariadne'],
  ];
  for (const [re, id] of keywords) if (re.test(n) && agents.some((a) => a.id === id)) return id;
  return agents.some((a) => a.id === 'lumen') ? 'lumen' : agents[0]?.id;
}

/** Validate and repair a model-produced plan into an executable DAG. */
export function normalizePlan(raw, agents, { maxTasks = 8, idPrefix = '' } = {}) {
  const obj = typeof raw === 'string' ? extractJson(raw) : raw;
  const list = Array.isArray(obj) ? obj : obj?.tasks;
  if (!Array.isArray(list) || list.length === 0) return null;
  const usable = agents.filter((a) => a.id !== 'genesis');
  const tasks = [];
  const idMap = new Map();
  for (const [i, t] of list.slice(0, maxTasks).entries()) {
    const origId = String(t?.id ?? `t${i + 1}`);
    const id = `${idPrefix}${slug(origId, 20) || `t${i + 1}`}`;
    if (idMap.has(origId)) continue;
    idMap.set(origId, id);
    tasks.push({
      id, title: String(t?.title || `Task ${i + 1}`).slice(0, 160),
      agent: nearestAgent(t?.agent, usable),
      instructions: String(t?.instructions || t?.title || '').slice(0, 4000),
      deps: Array.isArray(t?.deps) ? t.deps.map(String) : [],
      privacy: t?.privacy === 'private' ? 'private' : 'normal',
    });
  }
  // Map deps to new ids; drop unknown and self deps; only allow references to earlier tasks (breaks cycles).
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  for (const t of tasks) {
    t.deps = [...new Set(t.deps.map((d) => idMap.get(d)).filter((d) => d && d !== t.id && order.get(d) < order.get(t.id)))];
  }
  return { summary: String(obj?.summary || '').slice(0, 400), tasks };
}

/** Kahn topological check; returns true when the graph is acyclic. */
export function isAcyclic(tasks) {
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) for (const d of t.deps) if (indeg.has(d)) indeg.set(t.id, indeg.get(t.id) + 1);
  const q = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (q.length) {
    const id = q.shift();
    seen++;
    for (const t of tasks) if (t.deps.includes(id)) { indeg.set(t.id, indeg.get(t.id) - 1); if (indeg.get(t.id) === 0) q.push(t.id); }
  }
  return seen === tasks.length;
}

export function criticPrompt(task, output, evidence) {
  return [
    { role: 'system', content: 'You are Solon, a strict but fair critic. You judge whether work satisfies its task. Reply with JSON only.' },
    {
      role: 'user', content: [
        `Task: ${task.title}\nInstructions: ${task.instructions}`,
        `\nWork submitted:\n${output}`,
        evidence ? `\nTool evidence recorded by the harness (trust this over claims in the work):\n${evidence}` : '\nNo tools were run for this work.',
        '\nScore it. Return {"score": <0..1>, "pass": <bool>, "defects": ["<specific defect>", ...], "fix": "<what to change to pass>"}.',
        'Score 0.9+ only if complete and correct; 0.6-0.9 usable with minor issues; below 0.6 wrong, incomplete, or making claims that the evidence does not support.',
      ].join('\n'),
    },
  ];
}
