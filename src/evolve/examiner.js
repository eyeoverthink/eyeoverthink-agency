// Red Queen exams: the test evolves with the agents.
//
// Phase 6 measured that many fixed benchmark items carry no signal (every genome passes, or none does), and a fixed
// exam is eventually memorized. The examiner keeps the exam at the frontier of the agent's ability:
//   propose : an examiner model invents questions, each with a JavaScript program. The model is NEVER trusted for
//             the answer: the program runs in the permission-locked sandbox and its output becomes the answer key.
//             No program, a failing program, or an ambiguous output means the question is rejected.
//   trial   : candidates run against the agent's current genome on their own seed block. Only frontier items
//             (some passes, some failures) are admitted; always-pass and never-pass items are rejected.
//   retire  : admitted items that the agent has since saturated are retired, so the exam keeps moving.
// Admitted items alternate train / held-out and are picked up by evolution automatically. Every step is ledgered.
import { newId, nowIso, sha256 } from '../core/util.js';
import { runSandboxedJs } from '../tools/builtin.js';

const MATCHES = new Set(['number', 'text', 'yesno']);

/** Deterministic checker for a computed answer. */
export function makeCheck(match, answer) {
  const a = String(answer).trim();
  if (match === 'number') {
    const want = Number(a);
    // Precision-aware: "43.98" matches a key of 43.9822971502571 (the key rounded to the answer's own decimals),
    // while integers must match exactly. Measured: an exact compare failed a correct "43.98 cm" circumference.
    return (resp) => {
      const nums = String(resp).replace(/(?<=\d),(?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?/g) || [];
      return nums.some((n) => {
        const v = Number(n), dec = (n.split('.')[1] || '').length;
        if (Math.abs(v - want) <= Math.max(1e-9, Math.abs(want) * 1e-9)) return true;
        return dec >= 2 && Math.abs(Number(want.toFixed(dec)) - v) < 10 ** -(dec + 1);
      });
    };
  }
  if (match === 'yesno') {
    const yes = /^y/i.test(a);
    return (resp) => { const s = String(resp).trim().toLowerCase(); const y = /\byes\b/.test(s), n = /\bno\b/.test(s); return yes ? y && !/^\W*no\b/.test(s) : n && !/^\W*yes\b/.test(s); };
  }
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
  return (resp) => re.test(String(resp));
}

/** Validate a program's output as an answer key of the given match type. Returns the normalized answer or null. */
export function answerKey(match, stdout) {
  const lines = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return null; // ambiguous: exactly one line of output
  const v = lines[0].trim();
  if (!v || v.length > 80) return null;
  if (match === 'number') return /^-?\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v)) ? String(Number(v)) : null;
  if (match === 'yesno') return /^(yes|no)$/i.test(v) ? v.toLowerCase() : null;
  return v.length >= 2 ? v : null;
}

const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

/** The single number every answer ends on, when they all agree on one other than the key; else null. */
export function consistentAnswer(answers, key) {
  if (answers.length < 2) return null;
  const finalNumber = (a) => { const nums = String(a).replace(/(?<=\d),(?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?/g); return nums ? Number(nums.at(-1)) : null; };
  const vals = answers.map(finalNumber);
  if (vals.some((v) => v == null)) return null;
  if (!vals.every((v) => Math.abs(v - vals[0]) < 1e-9)) return null;
  return Math.abs(vals[0] - Number(key)) < 1e-9 ? null : String(vals[0]);
}

/** Do two independently derived answer keys agree? */
export function sameAnswer(match, a, b) {
  if (match === 'number') { const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= Math.max(1e-6, Math.abs(x) * 1e-6); }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export class Examiner {
  constructor({ store, router, agents, bench, ledger, bus, sandbox = runSandboxedJs }) {
    Object.assign(this, { store, router, agents, bench, ledger, bus, sandbox });
  }

  list(agentId, status = null) {
    return this.store.all(`SELECT * FROM exam_items WHERE agent_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created`, ...(status ? [agentId, status] : [agentId]))
      .map((r) => ({ ...r, stats: JSON.parse(r.stats || '{}') }));
  }

  /** Active items as bench items, for evolution. */
  items(agentId, split) {
    return this.list(agentId, 'active').filter((r) => (split === 'holdout' ? r.split === 'holdout' : r.split !== 'holdout'))
      .map((r) => ({ id: r.id, agent: agentId, category: 'exam', task: r.task, check: makeCheck(r.match, r.answer), ...(split === 'holdout' ? { split: 'holdout' } : {}) }));
  }

  /** Ask the examiner model for questions; keep only those whose program computes a clean answer key. */
  async propose(agentId, { count = 6, signal } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    count = Math.max(1, Math.min(12, count | 0));
    const known = this.list(agentId).map((r) => r.task);
    const res = await this.router.chat({
      role: 'reason', privacy: 'private', json: true, temperature: 0.8, maxTokens: 2400, signal,
      messages: [
        { role: 'system', content: 'You are an exam designer for AI agents. You write hard but fair questions with exactly one correct short answer, and for each a small JavaScript program that computes that answer from first principles and prints ONLY the answer with console.log. Reply with JSON only.' },
        { role: 'user', content: `Design ${count} new questions for ${agent.name}, the agency's ${agent.role}: ${agent.description}\nVary difficulty so some take careful multi-step reasoning. Answers must be a number, "yes"/"no", or a short text.\nAvoid these existing questions:\n${known.slice(-20).map((t) => `- ${t.slice(0, 140)}`).join('\n') || '- (none yet)'}\n\nReturn {"items":[{"task":"<question, ending with how to give the answer>","match":"number|yesno|text","program":"<JavaScript that prints only the answer>"}]}` },
      ],
    });
    let proposed = [];
    try { proposed = JSON.parse(String(res.text).match(/\{[\s\S]*\}/)?.[0] || '{}').items || []; } catch { proposed = []; }
    const accepted = [], rejected = [];
    const seen = new Set(known.map(norm));
    for (const p of proposed.slice(0, count)) {
      const task = String(p?.task || '').trim(), match = String(p?.match || '').toLowerCase(), program = String(p?.program || '');
      if (task.length < 15 || task.length > 600 || !MATCHES.has(match) || !program.trim()) { rejected.push('malformed'); continue; }
      if (seen.has(norm(task))) { rejected.push('duplicate'); continue; }
      const run = await this.sandbox(program, { timeoutMs: 5000 });
      if (run.exitCode !== 0 || run.timedOut) { rejected.push('program failed'); continue; }
      const answer = answerKey(match, run.stdout);
      if (answer == null) { rejected.push('ambiguous output'); continue; }
      // Measured on real models: 5 of 6 examiner programs ran cleanly but answered the WRONG question (off-by-one,
      // misread ratios). Running a program proves it runs, not that it answers the question. So a second model,
      // seeing only the question, derives the answer independently; the key is accepted only if both agree.
      // Second derivation (different role, question only). On disagreement, a third blind derivation by another
      // role decides: a key is accepted only when two of three independent derivations agree.
      const keys = [{ by: `examiner:${res.model}`, answer }];
      const second = await this.#independentKey(task, match, signal, 'code');
      if (!second.error) keys.push({ by: `code:${second.model}`, answer: second.answer });
      let finalKey = null, verdict;
      if (second.error === 'ambiguous question') verdict = 'ambiguous question';
      else if (!second.error && sameAnswer(match, answer, second.answer)) { finalKey = answer; verdict = 'agreed (2/2)'; }
      else {
        const third = await this.#independentKey(task, match, signal, 'reason');
        if (third.error === 'ambiguous question') verdict = 'ambiguous question';
        else if (third.error) verdict = second.error ? 'second key failed' : 'keys disagree';
        else {
          keys.push({ by: `reason:${third.model}`, answer: third.answer });
          const agree = keys.filter((k) => sameAnswer(match, k.answer, third.answer));
          if (agree.length >= 2) { finalKey = third.answer; verdict = `majority (${agree.length}/${keys.length})`; }
          else verdict = 'keys disagree';
        }
      }
      const stats = { keyCheck: { verdict, keys } };
      if (finalKey == null) {
        rejected.push(verdict);
        // Kept for audit (never used): which derivations disagreed, and how.
        this.store.run('INSERT INTO exam_items (id, agent_id, task, answer, match, split, status, origin, program, stats, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          newId('ex'), agentId, task, String(answer), match, 'train', 'unverified', `examiner:${res.model}`, program, JSON.stringify(stats), nowIso(), nowIso());
        continue;
      }
      seen.add(norm(task));
      const id = newId('ex');
      this.store.run('INSERT INTO exam_items (id, agent_id, task, answer, match, split, status, origin, program, stats, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, agentId, task, finalKey, match, 'train', 'candidate', `examiner:${res.model}`, program, JSON.stringify(stats), nowIso(), nowIso());
      accepted.push({ id, task, answer: finalKey, match, verdict });
    }
    this.ledger.append('exam.propose', { agentId, proposed: proposed.length, accepted: accepted.length, rejected, items: accepted.map((a) => ({ id: a.id, taskSha256: sha256(a.task), answerSha256: sha256(a.answer) })) }, 'examiner');
    this.bus?.publish('exam.propose', { agentId, accepted: accepted.length, rejected: rejected.length });
    return { accepted, rejected };
  }

  /** Second, independent derivation of the answer key: a different model role, the question only, its own program. */
  async #independentKey(task, match, signal, role = 'code') {
    let res;
    try {
      res = await this.router.chat({
        role, privacy: 'private', json: true, temperature: 0.1, maxTokens: 900, signal,
        messages: [
          { role: 'system', content: 'You verify exam answer keys. Read the question carefully, then write a small JavaScript program that computes the single correct answer from first principles and prints ONLY that answer with console.log. If the question is ambiguous (more than one reasonable answer), set "ambiguous": true. Reply with JSON only: {"ambiguous": false, "program": "<JavaScript>"}' },
          { role: 'user', content: `Question: ${task}\nAnswer type: ${match === 'number' ? 'a number' : match === 'yesno' ? '"yes" or "no"' : 'a short text'}` },
        ],
      });
    } catch (e) { return { error: 'second key failed' }; }
    let parsed = {};
    try { parsed = JSON.parse(String(res.text).match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return { error: 'second key failed' }; }
    if (parsed.ambiguous === true) return { error: 'ambiguous question' };
    if (!String(parsed.program || '').trim()) return { error: 'second key failed' };
    const run = await this.sandbox(String(parsed.program), { timeoutMs: 5000 });
    if (run.exitCode !== 0 || run.timedOut) return { error: 'second key failed' };
    const answer = answerKey(match, run.stdout);
    if (answer == null) return { error: 'second key failed' };
    return { answer, model: res.model };
  }

  /**
   * Trial candidates (and re-check active items) against the agent's current genome. Frontier items are admitted,
   * alternating train / held-out; saturated active items retire. Seeds 8001+ are used by no other stage.
   */
  async trial(agentId, { repeats = 3, low = 0.2, high = 0.8, signal, onProgress } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    repeats = Math.max(2, Math.min(6, repeats | 0));
    const rows = [...this.list(agentId, 'candidate'), ...this.list(agentId, 'active')];
    const total = rows.length * repeats;
    let done = 0;
    const out = { admitted: [], rejected: [], retired: [], kept: [] };
    let holdoutTurn = this.list(agentId, 'active').filter((r) => r.split === 'holdout').length < this.list(agentId, 'active').filter((r) => r.split !== 'holdout').length;
    for (const row of rows) {
      const item = { id: row.id, agent: agentId, category: 'exam', task: row.task, check: makeCheck(row.match, row.answer) };
      let pass = 0, errors = 0;
      const answers = [];
      for (let r = 0; r < repeats; r++) {
        if (signal?.aborted) throw new Error('aborted');
        const res = await this.bench.runItem(item, { agentOverride: agent, signal, seed: 8000 + r + 1 });
        if (res.error) errors++; else if (res.pass) pass++;
        if (!res.error) answers.push(String(res.answer ?? ''));
        done++;
        onProgress?.({ agentId, generation: agent.generation || 0, phase: 'exam', done, total });
      }
      if (errors > repeats / 2) { out.kept.push({ id: row.id, reason: 'runs errored; not judged' }); continue; }
      const rate = Math.round((pass / Math.max(1, repeats - errors)) * 1000) / 1000;
      const stats = { ...row.stats, lastRate: rate, trials: (row.stats.trials || 0) + 1, lastTrial: nowIso() };
      let status = row.status, split = row.split;
      if (row.status === 'candidate') {
        if (rate > low && rate < high) { status = 'active'; split = holdoutTurn ? 'holdout' : 'train'; holdoutTurn = !holdoutTurn; out.admitted.push({ id: row.id, rate, split }); }
        else {
          // An agent that fails every repeat but keeps giving the SAME other answer is more likely right than the key
          // (measured: both wrong keys in a real cycle scored 0/3 against Tycho's correct answers). Flag, don't bury.
          const dispute = rate === 0 && row.match === 'number' ? consistentAnswer(answers, row.answer) : null;
          if (dispute != null) { status = 'disputed'; stats.agentAnswer = dispute; out.rejected.push({ id: row.id, rate, reason: `key disputed: the agent consistently answered ${dispute}` }); }
          else { status = 'rejected'; out.rejected.push({ id: row.id, rate, reason: rate >= high ? 'too easy (no signal)' : 'too hard (no signal)' }); }
        }
      } else if (rate >= 0.999 && (row.stats.lastRate ?? 0) >= 0.999) { status = 'retired'; out.retired.push({ id: row.id, reason: 'saturated twice in a row' }); }
      else out.kept.push({ id: row.id, rate });
      this.store.run('UPDATE exam_items SET status = ?, split = ?, stats = ?, updated = ? WHERE id = ?', status, split, JSON.stringify(stats), nowIso(), row.id);
    }
    this.ledger.append('exam.trial', { agentId, repeats, admitted: out.admitted, rejected: out.rejected.map((r) => ({ id: r.id, rate: r.rate })), retired: out.retired.map((r) => r.id) }, 'examiner');
    this.bus?.publish('exam.trial', { agentId, admitted: out.admitted.length, rejected: out.rejected.length, retired: out.retired.length });
    return out;
  }

  /** One Red Queen cycle: propose new questions, then trial everything. */
  async cycle(agentId, { count = 6, repeats = 3, signal, onProgress } = {}) {
    const proposed = await this.propose(agentId, { count, signal });
    const trial = await this.trial(agentId, { repeats, signal, onProgress });
    return { agentId, proposed, trial, active: this.list(agentId, 'active').length };
  }
}
