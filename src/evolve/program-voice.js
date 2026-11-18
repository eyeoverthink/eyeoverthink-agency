// Program-verified judge voice (Phase 20).
//
// The judge's other voices are agents: they reason in prose, and on hard arithmetic they can all be wrong (Phase 12:
// on "what fraction of the original price is left" every agent erred, so nothing could be corrected). A program can
// be exact, but a single program is not proof: measured in Phase 8, 5 of 6 examiner programs ran cleanly and answered
// the WRONG question. So this voice is N-version programming:
//   - two different local models (roles 'code' and 'reason') each write a program from the task alone;
//   - each runs in the permission-locked sandbox and must print exactly one number;
//   - if the two agree, that number is the voice's answer; if not, a third program (role 'plan') decides 2 of 3;
//   - otherwise the voice gives no answer (it never guesses).
// Everything runs locally; no task text leaves the machine.
import { answerKey } from './examiner.js';

/** Two numbers agree: within a relative 1e-6, or equal when rounded to the coarser one's decimals (46.67 vs 46.6667). */
export function programsAgree(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-6)) return true;
  const dec = Math.min((String(a).split('.')[1] || '').length, (String(b).split('.')[1] || '').length);
  return dec >= 2 && dec <= 4 && Number(x.toFixed(dec)) === Number(y.toFixed(dec)); // 1 decimal is too loose: 0.55 would "agree" with 0.6
}

const SYSTEM = 'You compute the answer to a quantitative question. Read it carefully, then write a small JavaScript program that computes the single correct numeric answer from first principles and prints ONLY that number with console.log: no units, no words, full precision. A percentage answer is printed as a percent number (25 for 25%). If the question is ambiguous (more than one reasonable answer), set "ambiguous": true. Reply with JSON only: {"ambiguous": false, "program": "<JavaScript>"}';

/** One independent program for the task, by one model role. Returns { role, model, answer } or { role, error }. */
async function writeAndRun(task, role, { router, sandbox, signal }) {
  let res;
  try {
    res = await router.chat({ role, privacy: 'private', json: true, temperature: 0.1, maxTokens: 900, signal,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Question: ${String(task).slice(0, 3000)}` }] });
  } catch { return { role, error: 'model unavailable' }; }
  let p = {};
  try { p = JSON.parse(String(res.text).match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return { role, model: res.model, error: 'no JSON' }; }
  if (p.ambiguous === true) return { role, model: res.model, error: 'ambiguous' };
  if (!String(p.program || '').trim()) return { role, model: res.model, error: 'no program' };
  const run = await sandbox(String(p.program), { timeoutMs: 5000 });
  if (run.exitCode !== 0 || run.timedOut) return { role, model: res.model, error: 'program failed' };
  const answer = answerKey('number', run.stdout);
  return answer == null ? { role, model: res.model, error: 'not exactly one number' } : { role, model: res.model, answer: Number(Number(answer).toPrecision(12)) }; // 0.8*0.75 prints 0.6000000000000001
}

/**
 * The program voice's answer for a task: { answer, verdict, votes }. answer is null unless at least two independent
 * programs agree.
 */
export async function programVoice(task, { router, sandbox, roles = ['code', 'reason', 'plan'], signal } = {}) {
  const votes = [];
  for (const role of roles.slice(0, 2)) votes.push(await writeAndRun(task, role, { router, sandbox, signal }));
  const ok = () => votes.filter((v) => v.answer != null);
  const pair = () => { const o = ok(); for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) if (programsAgree(o[i].answer, o[j].answer)) return o[i]; return null; };
  let hit = pair();
  if (hit) return { answer: hit.answer, verdict: 'two programs agree', votes };
  if (roles[2]) { votes.push(await writeAndRun(task, roles[2], { router, sandbox, signal })); hit = pair(); }
  if (hit) return { answer: hit.answer, verdict: `two of ${votes.length} programs agree`, votes };
  return { answer: null, verdict: ok().length ? 'programs disagree' : 'no program produced one number', votes };
}
