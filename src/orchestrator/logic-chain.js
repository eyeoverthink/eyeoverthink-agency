// Logic Chain (port of FRAYMUS-Logic-Chain): a relay of 8 design roles over a typed delta ledger.
// Each stage sees the unchanged objective plus a bounded view of the ledger and returns a JSON delta.
// contradictions/unsupported_claims are PROTECTED: never evicted, always shown first.
// Review ("JEV"): models that did not author a warning vote decide|settled|noise; >=2 votes and >=0.8
// agreement dismisses or confirms it. Every stage is recorded on the signed agency ledger.
import { extractJson, sha256, canonical, errorMessage } from '../core/util.js';

export const ROLES = [
  { name: 'Architect', role: 'plan', brief: 'Define the overall structure, components and their responsibilities.' },
  { name: 'Algorithm', role: 'reason', brief: 'Specify the core algorithms, their complexity and edge cases.' },
  { name: 'Data Model', role: 'reason', brief: 'Define data structures, schemas, invariants and storage.' },
  { name: 'Implementation', role: 'code', brief: 'Turn the design into concrete implementation steps.' },
  { name: 'Critic', role: 'critic', brief: 'Attack the design: find contradictions, gaps and unsupported claims.' },
  { name: 'Test Designer', role: 'code', brief: 'Design tests that would prove or falsify the design.' },
  { name: 'Optimizer', role: 'reason', brief: 'Improve performance, simplicity and cost without breaking guarantees.' },
  { name: 'Integrator', role: 'plan', brief: 'Reconcile everything into one coherent, buildable whole.' },
];
export const FIELDS = ['new_logic', 'improved_logic', 'contradictions', 'implementation_steps', 'test_cases', 'unsupported_claims', 'remaining_dependencies'];
export const PROTECTED = ['contradictions', 'unsupported_claims'];
const MAX_ITEMS = 250;

const norm = (s) => String(s).split(/\s+/).join(' ').toLowerCase().trim();

export function emptyLedger() { return Object.fromEntries(FIELDS.map((f) => [f, []])); }

/** Merge a stage delta into the ledger. Returns number of items dropped by the cap. */
export function mergeDelta(ledger, delta, stage) {
  let dropped = 0;
  for (const f of FIELDS) {
    const items = Array.isArray(delta?.[f]) ? delta[f] : [];
    const seen = new Set(ledger[f].map((x) => norm(x.text)));
    for (const raw of items) {
      const text = String(typeof raw === 'string' ? raw : raw?.text ?? JSON.stringify(raw)).trim().slice(0, 600);
      if (!text || seen.has(norm(text))) continue;
      seen.add(norm(text));
      ledger[f].push({ id: `${f.slice(0, 3)}${ledger[f].length + 1}`, text, stage });
    }
    if (!PROTECTED.includes(f) && ledger[f].length > MAX_ITEMS) { dropped += ledger[f].length - MAX_ITEMS; ledger[f] = ledger[f].slice(-MAX_ITEMS); }
  }
  return dropped;
}

/** Bounded ledger view: protected fields first and complete; other fields share the remaining budget, earliest+newest spread. */
export function boundedLedger(ledger, maxChars = 6000) {
  const out = {};
  let used = 0;
  for (const f of PROTECTED) { out[f] = ledger[f].map((x) => `${x.id}: ${x.text}`); used += JSON.stringify(out[f]).length; }
  const rest = FIELDS.filter((f) => !PROTECTED.includes(f));
  const per = Math.max(300, Math.floor((maxChars - used) / rest.length));
  for (const f of rest) {
    const items = ledger[f];
    const picked = [];
    let size = 0;
    let lo = 0, hi = items.length - 1, front = true;
    while (lo <= hi) {
      const x = front ? items[lo++] : items[hi--];
      front = !front;
      const s = `${x.id}: ${x.text}`;
      if (size + s.length > per) break;
      picked.push(s);
      size += s.length;
    }
    out[f] = picked;
  }
  return out;
}

function stagePrompt(objective, role, ledgerView) {
  return [
    { role: 'system', content: `You are the ${role.name} stage in a design relay. ${role.brief} Reply with a JSON object only.` },
    { role: 'user', content: `Objective (unchanged):\n${objective}\n\nCurrent design ledger:\n${JSON.stringify(ledgerView, null, 1)}\n\nAdd your contribution as a delta. Return {${FIELDS.map((f) => `"${f}": [strings]`).join(', ')}}. Only include NEW items. Put anything you doubt into unsupported_claims and any conflict into contradictions.` },
  ];
}

export class LogicChain {
  constructor({ router, ledger, bus, auditor = null }) { Object.assign(this, { router, ledger, bus, auditor }); }

  async run(objective, { passes = 1, span = null, signal, privacy = 'normal', missionId = null } = {}) {
    const ledger = emptyLedger();
    const stages = [];
    let dropped = 0;
    for (let p = 0; p < passes; p++) {
      for (const role of ROLES) {
        if (signal?.aborted) throw new Error('aborted');
        const stageName = `${role.name}#${p + 1}`;
        const s = span?.child(`stage ${stageName}`, { kind: 'stage' });
        let delta = null, model = null, error = null;
        for (let attempt = 0; attempt < 2 && !delta; attempt++) {
          try {
            const msgs = stagePrompt(objective, role, boundedLedger(ledger));
            if (attempt) msgs.push({ role: 'user', content: 'REPAIR: your previous reply was not a valid JSON delta. Return only the JSON object with the seven arrays.' });
            const res = await this.router.chat({ role: role.role, messages: msgs, json: true, temperature: 0.3, maxTokens: 1500, privacy, span: s, signal });
            model = res.model;
            const parsed = extractJson(res.text);
            if (parsed && FIELDS.some((f) => Array.isArray(parsed[f]))) delta = parsed;
          } catch (e) {
            if (signal?.aborted) throw e;
            error = errorMessage(e);
          }
        }
        const ok = Boolean(delta);
        if (ok) dropped += mergeDelta(ledger, delta, stageName);
        const record = { stage: stageName, model, ok, error, bodySha: ok ? sha256(canonical(delta)) : null };
        stages.push(record);
        this.ledger.append('logic_chain.stage', { missionId, ...record }, 'genesis');
        this.bus?.publish('logic_chain.stage', { missionId, ...record, counts: Object.fromEntries(FIELDS.map((f) => [f, ledger[f].length])) });
        s?.end(ok ? 'ok' : 'error', { model, error });
      }
    }
    const review = await this.review(ledger, stages, { span, signal, privacy });
    let brief = await this.synthesize(objective, ledger, review, { span, signal, privacy });
    const audit = this.auditor ? this.auditor.auditLogicChain(ledger, review, brief, { missionId }) : null;
    const okRatio = stages.filter((s) => s.ok).length / stages.length;
    const warnings = review.items.length || 1;
    let score = Math.round((okRatio * 0.7 + (review.dismissed.length / warnings) * 0.3) * 1000) / 1000;
    if (audit && audit.unacknowledged > 0) {
      score = Math.min(score, 0.55);
      const list = audit.findings.map((f) => `- [${f.id || f.kind}] ${f.text}`).join('\n');
      brief = `${brief}\n\n## Unacknowledged Open Warnings (Auditor)\n${list}`;
    }
    return { ledger, stages, review, brief, dropped, score, ...(audit ? { audit } : {}) };
  }

  /** JEV-style review of protected warnings by non-author models. */
  async review(ledger, stages, { span, signal, privacy }) {
    const stageModel = new Map(stages.map((s) => [s.stage, s.model]));
    const items = [...ledger.contradictions, ...ledger.unsupported_claims].slice(0, 40)
      .map((x) => ({ ...x, author: stageModel.get(x.stage) }));
    const voterRoles = ['critic', 'reason', 'code', 'fast', 'continuity'];
    const voters = [];
    for (const role of voterRoles) {
      const c = (await this.router.candidates({ role, privacy }))[0];
      if (c && !voters.some((v) => v.model === c.model)) voters.push({ role, model: c.model });
      if (voters.length >= 5) break;
    }
    const votes = new Map(items.map((x) => [x.id, []]));
    if (items.length && voters.length >= 2) {
      for (const v of voters) {
        const mine = items.filter((x) => x.author !== v.model);
        if (!mine.length) continue;
        const order = mine.map((x) => `${x.id}: ${x.text}`).sort(() => 0.5 - Math.random()).join('\n');
        try {
          const res = await this.router.chat({ role: v.role, model: v.model, json: true, temperature: 0.1, maxTokens: 900, privacy, signal, span: span?.child(`review ${v.model}`, { kind: 'review' }),
            messages: [
              { role: 'system', content: 'You review warnings raised during a design relay. Reply with JSON only.' },
              { role: 'user', content: `For each warning decide: "decide" (real issue the owner must resolve), "settled" (already resolved by the design), or "noise" (not a real issue).\n${order}\n\nReturn {"votes": [{"id": "<warning id>", "verdict": "decide|settled|noise"}]}` },
            ] });
          const parsed = extractJson(res.text);
          for (const vote of parsed?.votes || []) {
            if (votes.has(vote.id) && ['decide', 'settled', 'noise'].includes(vote.verdict)) votes.get(vote.id).push({ model: v.model, verdict: vote.verdict });
          }
        } catch (e) { if (signal?.aborted) throw e; }
      }
    }
    const open = [], dismissed = [], undecided = [];
    for (const x of items) {
      const vs = votes.get(x.id);
      const n = vs.length;
      const decide = vs.filter((v) => v.verdict === 'decide').length;
      const dismiss = n - decide;
      const entry = { id: x.id, text: x.text, votes: vs };
      if (n >= 2 && dismiss / n >= 0.8) dismissed.push(entry);
      else if (n >= 2 && decide / n >= 0.8) open.push({ ...entry, confirmed: true });
      else { undecided.push(entry); open.push(entry); }
    }
    return { voters, items, open, dismissed, undecided, semantics: 'stability-signal-not-correctness', insufficientVoters: voters.length < 2 };
  }

  async synthesize(objective, ledger, review, { span, signal, privacy }) {
    const view = boundedLedger(ledger, 9000);
    try {
      const res = await this.router.chat({ role: 'reason', temperature: 0.3, maxTokens: 2500, privacy, signal, span: span?.child('brief', { kind: 'synthesis' }),
        messages: [
          { role: 'system', content: 'Write a design brief in Markdown using ONLY the ledger content. No new claims.' },
          { role: 'user', content: `Objective: ${objective}\n\nLedger:\n${JSON.stringify(view, null, 1)}\n\nOpen issues after review:\n${review.open.map((o) => `- ${o.id}: ${o.text}`).join('\n') || '(none)'}\n\nSections: Summary, Architecture, Algorithms & Data, Implementation Plan, Tests, Open Issues, Dependencies.` },
        ] });
      return res.text.trim();
    } catch (e) {
      if (signal?.aborted) throw e;
      return `# Design brief (deterministic fallback — synthesis model unavailable)\n\n${FIELDS.map((f) => `## ${f}\n${ledger[f].map((x) => `- ${x.text}`).join('\n') || '- (none)'}`).join('\n\n')}`;
    }
  }
}

export const ledgerSummary = (ledger) => Object.fromEntries(FIELDS.map((f) => [f, ledger[f].length]));
