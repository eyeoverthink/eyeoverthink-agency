// Phase 22: Deterministic Claim-and-Evidence Auditor.
// Replaces prose-only verification blind spots with deterministic checks:
//   1. Code-block sandbox execution (catches syntax/runtime/assertion/timeout bugs).
//   2. Numeric provenance checking (catches fabricated synthesis numbers absent from sources).
//   3. Logic-chain open-warning accountability (catches silently dropped protected warnings).
//   4. 100% local private-reply auditing (privacy: 'private', remoteCalls === 0, hashes/counts only in ledger).
import { sha256, extractJson } from '../core/util.js';
import { runSandboxedJs } from '../tools/builtin.js';

const JS_LANGS = new Set(['js', 'javascript', 'mjs']);
const FENCE_RE = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const ESM_RE = /(?:^|\n)\s*(?:import\s+[\s\S]*?\bfrom\b|import\s+['"]|export\s+(?:default\b|const\b|let\b|var\b|function\b|async\b|class\b|\{))/m;
const EXTERNAL_ENV_RE = /\b(?:require\s*\(|fetch\s*\(|document\.|window\.|process\.env\b)/;
const PLACEHOLDER_RE = /(?:^\s*\.\.\.\s*$|\/\*\s*\.\.\.\s*\*\/|\/\/\s*\.\.\.|;\s*\.\.\.(?!\s*[\w$[{])|\{\s*\.\.\.\s*\}|\/\/\s*your code\b|\/\/\s*TODO\b)/im;

const ASSERT_SHIM = ';(() => { const _a = console.assert.bind(console); console.assert = (c, ...r) => { if (!c) throw new Error("AssertionError: " + (r.length ? r.map((x) => { if (typeof x === "string") return x; try { return JSON.stringify(x); } catch { return String(x); } }).join(" ") : "console.assert failed")); return _a(c, ...r); }; })();';

const STOP = new Set(
  'the a an and or of to in on for with is are was were be been being it this that these those as at by from into about over under not no yes you your we our they their i me my he she his her them can will would should could do does did done has have had than then so if but what which who whom how when where why all any each some such only own same too very just also more most other must may might'.split(' ')
);

const LABEL_PREFIX_RE = /\b(?:step|phase|section|item|part|stage|attempt|task|block|chapter|figure|table|level|tier|version|v|option|choice|rule|law|point|note|line|row|col|column|quarter|q)\s*#?\s*$/i;
const NUM_CLAIM_RE = /(?<![A-Za-z0-9_.])(?:(?<!\d)-)?([\$€£])?(?:(?<!\d)-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%?)/g;
const RAW_NUM_RE = /(?<![\w.])-?\d+(?:\.\d+)?/g;

/**
 * Extract fenced JavaScript blocks (js, javascript, mjs) from Markdown.
 * Non-JS languages (python, bash, json, etc.) are excluded.
 * Blocks containing ESM syntax, external I/O/DOM/env calls, or pseudocode placeholders are marked runnable: false.
 */
export function extractCodeBlocks(markdown) {
  const src = String(markdown ?? '');
  const blocks = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(src)) !== null) {
    const lang = String(m[1] || '').toLowerCase();
    if (!JS_LANGS.has(lang)) continue;
    const code = m[2];
    let runnable = true;
    let reason = null;
    if (!code.trim()) { runnable = false; reason = 'empty'; }
    else if (ESM_RE.test(code)) { runnable = false; reason = 'esm'; }
    else if (EXTERNAL_ENV_RE.test(code)) { runnable = false; reason = 'external_env'; }
    else if (PLACEHOLDER_RE.test(code)) { runnable = false; reason = 'placeholder'; }
    blocks.push({ index: blocks.length, lang, code, runnable, reason });
  }
  return blocks;
}

function summarizeSandboxError(run, timeoutMs) {
  if (run.timedOut) return `execution timed out after ${timeoutMs}ms`;
  const stderr = String(run.stderr || '').trim();
  if (stderr) {
    const errLine = stderr.match(/(?:SyntaxError|ReferenceError|TypeError|RangeError|URIError|EvalError|AssertionError|Error)\b[^\r\n]*/);
    if (errLine) return errLine[0].trim().slice(0, 240);
    const firstLine = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (firstLine) return firstLine.slice(0, 240);
  }
  return `exited with code ${run.exitCode}`;
}

/**
 * Execute every runnable fenced JS block in the permission-locked sandbox.
 * Intercepts console.assert failures so failed assertions fail the block.
 */
export async function auditCodeBlocks(markdown, { sandbox = runSandboxedJs, timeoutMs = 4000 } = {}) {
  const blocks = extractCodeBlocks(markdown);
  let checked = 0, passed = 0, failed = 0, skipped = 0;
  const findings = [];
  for (const b of blocks) {
    if (!b.runnable) {
      skipped++;
      continue;
    }
    checked++;
    const wrapped = `${ASSERT_SHIM}\n${b.code}`;
    const run = await sandbox(wrapped, { timeoutMs });
    if (run.timedOut || run.exitCode !== 0) {
      failed++;
      findings.push({
        blockIndex: b.index,
        error: summarizeSandboxError(run, timeoutMs),
        snippet: b.code.trim().slice(0, 200),
      });
    } else {
      passed++;
    }
  }
  return { checked, passed, failed, skipped, findings };
}

function maskNonClaims(text, { stripFences = false } = {}) {
  let s = String(text ?? '');
  const blank = (m) => ' '.repeat(m.length);
  if (stripFences) s = s.replace(/```[\s\S]*?```/g, blank);
  s = s.replace(/https?:\/\/\S+/g, blank);
  s = s.replace(/\b[0-9a-f]{12,}\b/gi, blank);
  s = s.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, blank);
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, blank);
  s = s.replace(/\b\d+\.\d+\.\d+(?:\.\d+)?\b/g, blank);
  return s;
}

function extractNumericTokens(text, { stripFences = false, ignoreBenign = false } = {}) {
  const original = String(text ?? '');
  const masked = maskNonClaims(original, { stripFences });
  const items = [];
  NUM_CLAIM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_CLAIM_RE.exec(masked)) !== null) {
    const raw = m[0];
    const hasCurrency = Boolean(m[1]);
    const intPart = m[2];
    const decPart = m[3];
    const isPercent = Boolean(m[4]);
    const hasDecimal = decPart !== undefined;
    const hasComma = intPart.includes(',');
    const negative = raw.startsWith('-') || raw.includes('$-') || raw.includes('€-') || raw.includes('£-');
    const numericStr = `${negative ? '-' : ''}${intPart.replace(/,/g, '')}${hasDecimal ? `.${decPart}` : ''}`;
    const value = Number(numericStr);
    if (!Number.isFinite(value)) continue;

    const start = m.index;
    const end = start + raw.length;
    const after = masked.slice(end, end + 8);
    // Skip dotted numbers like 1.2.3 that slipped past masking.
    if (after.startsWith('.') && /\d/.test(after[1] || '')) continue;

    if (ignoreBenign) {
      const plainInt = !hasCurrency && !isPercent && !hasDecimal && Number.isInteger(value);
      // Ordinals: 1st, 2nd, 3rd, 4th...
      if (plainInt && /^(?:st|nd|rd|th)\b/i.test(after)) continue;
      // Numbered list index at line start: "1. ", "(2) ", "14) "
      const lineStart = masked.lastIndexOf('\n', start - 1) + 1;
      const linePrefix = masked.slice(lineStart, start);
      if (plainInt && /^\s*\(?$/.test(linePrefix) && /^(?:\.|\))\s/.test(after)) continue;
      // Explicit structural label: "Step 3", "Phase 22", "Block #14"
      const before = masked.slice(Math.max(0, start - 32), start);
      if (plainInt && LABEL_PREFIX_RE.test(before)) continue;
      // Calendar years 1900..2100
      if (plainInt && !hasComma && value >= 1900 && value <= 2100) continue;
      // Small trivial counts 0..12
      if (plainInt && value >= 0 && value <= 12) continue;
    }

    const ctxStart = Math.max(0, start - 28);
    const ctxEnd = Math.min(original.length, end + 28);
    const context = original.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
    items.push({ value, raw, isPercent, hasCurrency, hasDecimal, context });
  }
  return items;
}

function isGroundedNumber(claim, sourceNums, pairSums) {
  const { value: v, isPercent } = claim;
  for (const s of sourceNums) {
    if (Math.abs(v - s) <= Math.max(0.01, Math.abs(s) * 0.005)) return true;
    // Fraction <-> percent equivalence (e.g. 0.675 <-> 67.5%)
    if (s !== 0 && (isPercent || Math.abs(s) <= 1.5) && Math.abs(v - s * 100) <= Math.max(0.01, Math.abs(s * 100) * 0.005)) return true;
    if (s !== 0 && Math.abs(v) <= 1.5 && Math.abs(v * 100 - s) <= Math.max(0.01, Math.abs(s) * 0.005)) return true;
    // Rounded to 0/1/2 decimals when |v| >= 10 and within 1%
    if (Math.abs(v) >= 10 && Math.abs(v - s) <= Math.abs(s) * 0.01) {
      if (Math.abs(v - Math.round(s)) < 1e-9 || Math.abs(v - Number(s.toFixed(1))) < 1e-9 || Math.abs(v - Number(s.toFixed(2))) < 1e-9) {
        return true;
      }
    }
  }
  for (const ps of pairSums) {
    if (Math.abs(v - ps) <= 1e-6) return true;
  }
  return false;
}

/**
 * Check quantitative claims in a synthesis against upstream sources (goal + task outputs + tool evidence).
 * Ignores benign numbers (0..12, calendar years, list indices, ordinals, structural labels) and allows
 * formatted numbers, percent/fraction forms, rounding within 1%, and exact pair sums.
 */
export function auditNumericProvenance(synthesis, sources = []) {
  const srcList = Array.isArray(sources) ? sources : [sources];
  const seen = new Set();
  const sourceNums = [];
  for (const src of srcList) {
    for (const tok of extractNumericTokens(src, { stripFences: false, ignoreBenign: false })) {
      if (!seen.has(tok.value)) {
        seen.add(tok.value);
        sourceNums.push(tok.value);
      }
    }
  }
  const capped = sourceNums.slice(0, 80);
  const pairSums = [];
  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      pairSums.push(capped[i] + capped[j]);
    }
  }

  const claims = extractNumericTokens(synthesis, { stripFences: true, ignoreBenign: true });
  let grounded = 0, ungrounded = 0;
  const findings = [];
  for (const c of claims) {
    if (isGroundedNumber(c, sourceNums, pairSums)) {
      grounded++;
    } else {
      ungrounded++;
      findings.push({ value: c.value, raw: c.raw, context: c.context });
    }
  }
  return { totalClaims: claims.length, grounded, ungrounded, findings };
}

function contentTokens(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verify that every open protected warning from a LogicChain review (contradictions & unsupported_claims)
 * is acknowledged in the final design brief (by warning ID or >=2 non-stopword content tokens).
 */
export function auditLogicChain(ledgerObj, review, brief) {
  const open = Array.isArray(review?.open) ? review.open : [];
  const briefStr = String(brief ?? '');
  const briefLower = briefStr.toLowerCase();
  const briefWords = new Set(briefLower.match(/[a-z0-9]{3,}/g) || []);
  const contradictionIds = new Set((ledgerObj?.contradictions || []).map((c) => c.id));

  let acknowledged = 0, unacknowledged = 0;
  const findings = [];

  for (const w of open) {
    const id = String(w?.id || '');
    const text = String(w?.text || '');
    const kind = contradictionIds.has(id) || id.startsWith('con') ? 'contradiction' : 'unsupported_claim';

    let matched = false;
    if (id && new RegExp(`\\b${escapeRegExp(id)}\\b`, 'i').test(briefStr)) {
      matched = true;
    } else {
      const tokens = contentTokens(text);
      const needed = Math.min(2, tokens.length);
      if (needed > 0) {
        let hits = 0;
        for (const tok of tokens) {
          if (briefWords.has(tok) || (tok.length >= 4 && briefLower.includes(tok))) hits++;
          if (hits >= needed) { matched = true; break; }
        }
      }
    }

    if (matched) acknowledged++;
    else {
      unacknowledged++;
      findings.push({ id, kind, text });
    }
  }

  return { openWarnings: open.length, acknowledged, unacknowledged, findings };
}

function extractAnswerNumber(task, text) {
  const s = String(text ?? '').replace(/```[\s\S]*?```/g, ' ');
  // Explicit FINAL or **Answer:** markers override inTask filtering.
  const explicitMatches = [
    ...s.matchAll(/\bFINAL\s*:?\s*\$?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/gi),
    ...s.matchAll(/\*\*Answer:\s*\$?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\*\*/gi),
  ];
  if (explicitMatches.length) {
    const n = Number(explicitMatches.at(-1)[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  const inTask = new Set((String(task ?? '').replace(/,(?=\d{3})/g, '').match(RAW_NUM_RE) || []).map(Number));
  const nums = (s.replace(/,(?=\d{3})/g, '').match(RAW_NUM_RE) || []).map(Number).filter((n) => Number.isFinite(n) && !inTask.has(n));
  return nums.length ? nums.at(-1) : null;
}

function numbersAgree(a, b, task = '') {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const close = (x, y) => Math.abs(x - y) <= Math.max(0.01, Math.abs(y) * 0.002);
  if (close(a, b) || close(b, a)) return true;
  const decA = Math.min(4, (String(a).split('.')[1] || '').length);
  const decB = Math.min(4, (String(b).split('.')[1] || '').length);
  if (decA <= 2 && Math.abs(Number(b.toFixed(decA)) - a) < 1e-9) return true;
  if (decB <= 2 && Math.abs(Number(a.toFixed(decB)) - b) < 1e-9) return true;
  const pctTask = /\b(fraction|percent|percentage|proportion)\b|%\s*of the original/i.test(String(task));
  if (pctTask && b !== 0 && (close(a, b * 100) || close(a * 100, b))) return true;
  return false;
}

export class ClaimAuditor {
  constructor({ router = null, sandbox = runSandboxedJs, ledger = null, bus = null, cfg = {} } = {}) {
    Object.assign(this, { router, sandbox, ledger, bus, cfg });
  }

  /**
   * Audit a single mission task output before/alongside the prose critic.
   * Runs runnable JS blocks in the sandbox and checks for unresolved tool-failure contradictions.
   */
  async auditTask(task, result, { signal } = {}) {
    if (signal?.aborted) throw new Error('aborted');
    const finalText = String(result?.final ?? '');
    const timeoutMs = this.cfg?.auditor?.codeTimeoutMs ?? 4000;
    const codeAudit = await auditCodeBlocks(finalText, { sandbox: this.sandbox, timeoutMs });
    const defects = [];
    let ok = true;
    let scoreCap = 1;

    if (codeAudit.failed > 0) {
      ok = false;
      scoreCap = Math.min(scoreCap, 0.45);
      for (const f of codeAudit.findings) {
        defects.push(`Code block #${f.blockIndex + 1} failed sandbox execution: ${f.error}`);
      }
    }

    const steps = Array.isArray(result?.steps) ? result.steps : [];
    const failedTools = steps.filter((s) => s.tool && s.ok === false);
    const unresolvedFailures = failedTools.filter((ft) => !steps.some((s) => s.tool === ft.tool && s.ok === true));
    if (unresolvedFailures.length > 0) {
      const claimsSuccess = /\b(tool (succeeded|returned|confirmed|verified)|successfully (ran|executed|fetched|retrieved|verified)|verified (via|with|using) \w+)\b/i.test(finalText);
      const acksFailure = /\b(fail|failed|failure|error|unable|could not|couldn't|cannot|unavailable|denied|blocked|timeout|timed out|limitation|unverified)\b/i.test(finalText);
      if (claimsSuccess && !acksFailure) {
        ok = false;
        scoreCap = Math.min(scoreCap, 0.5);
        defects.push(`Answer claims tool success despite unresolved tool failure(s): ${[...new Set(unresolvedFailures.map((s) => s.tool))].join(', ')}`);
      }
    }

    const meta = {
      missionId: task?.mission_id || null,
      taskId: task?.id || null,
      ok,
      codeChecked: codeAudit.checked,
      codeFailed: codeAudit.failed,
      defectsCount: defects.length,
    };
    this.ledger?.append('audit.task', meta, 'auditor');
    this.bus?.publish('audit.task', meta);
    return { ok, scoreCap, defects, codeAudit };
  }

  /**
   * Audit a mission's final synthesized deliverable against its goal and upstream source tasks.
   * Deterministic code execution + numeric provenance; optional local-only critic note when configured.
   */
  async auditDeliverable(goal, deliverable, sourceTasks = [], { missionId = null, privacy = 'normal', signal } = {}) {
    if (signal?.aborted) throw new Error('aborted');
    const text = String(deliverable ?? '');
    const timeoutMs = this.cfg?.auditor?.codeTimeoutMs ?? 4000;
    const codeAudit = await auditCodeBlocks(text, { sandbox: this.sandbox, timeoutMs });
    const sources = [
      String(goal ?? ''),
      ...(sourceTasks || []).map((t) => [
        t?.output || '',
        ...((t?.evidence || []).map((e) => e?.preview || '')),
      ].join('\n')),
    ].filter(Boolean);
    const provenanceAudit = auditNumericProvenance(text, sources);

    const findings = [];
    let ok = true;
    let scoreCap = 1;

    if (codeAudit.failed > 0) {
      ok = false;
      scoreCap = Math.min(scoreCap, 0.45);
      for (const f of codeAudit.findings) {
        findings.push({ kind: 'code', message: `Code block #${f.blockIndex + 1} failed sandbox execution: ${f.error}`, detail: f });
      }
    }

    let claimCheck = null;
    if (provenanceAudit.ungrounded > 0) {
      ok = false;
      scoreCap = Math.min(scoreCap, 0.55);
      for (const f of provenanceAudit.findings) {
        findings.push({ kind: 'provenance', message: `Ungrounded numeric claim ${f.raw} ("${f.context}")`, detail: f });
      }
      if (this.router && this.cfg?.auditor?.verifyClaims === true) {
        try {
          const res = await this.router.chat({
            role: 'critic',
            privacy: 'private',
            json: true,
            temperature: 0.1,
            maxTokens: 300,
            signal,
            messages: [
              { role: 'system', content: 'You verify whether flagged numbers in a synthesis come from the given sources. Reply with JSON only: {"unsupported": ["<raw>"], "note": "<short explanation>"}' },
              { role: 'user', content: `Flagged numbers:\n${provenanceAudit.findings.slice(0, 8).map((f) => `- ${f.raw}: ${f.context}`).join('\n')}\n\nSources:\n${sources.join('\n---\n').slice(0, 3000)}` },
            ],
          });
          claimCheck = extractJson(res.text) || { note: String(res.text || '').slice(0, 200) };
        } catch (e) {
          if (signal?.aborted) throw e;
        }
      }
    }

    const meta = {
      missionId,
      privacy,
      ok,
      codeChecked: codeAudit.checked,
      codeFailed: codeAudit.failed,
      ungroundedNumbers: provenanceAudit.ungrounded,
      scoreCap,
    };
    this.ledger?.append('audit.deliverable', meta, 'auditor');
    this.bus?.publish('audit.deliverable', meta);
    return { ok, scoreCap, codeAudit, provenanceAudit, findings, ...(claimCheck ? { claimCheck } : {}) };
  }

  /**
   * Audit a LogicChain design brief against open protected warnings and ledger the counts.
   */
  auditLogicChain(ledgerObj, review, brief, { missionId = null } = {}) {
    const res = auditLogicChain(ledgerObj, review, brief);
    const meta = {
      missionId,
      openWarnings: res.openWarnings,
      acknowledged: res.acknowledged,
      unacknowledged: res.unacknowledged,
      ok: res.unacknowledged === 0,
    };
    this.ledger?.append('audit.logic_chain', meta, 'auditor');
    this.bus?.publish('audit.logic_chain', meta);
    return res;
  }

  /**
   * Audit a private or sealed direct reply 100% locally.
   * Privacy invariant: every model call is pinned to privacy: 'private' (remoteCalls === 0),
   * and the ledger records ONLY hashes, counts, and booleans — NEVER raw task/reply text or PII.
   */
  async auditPrivateReply(task, final, { agentId = null, privacy = 'private', signal } = {}) {
    if (signal?.aborted) throw new Error('aborted');
    const timeoutMs = this.cfg?.auditor?.codeTimeoutMs ?? 4000;
    const codeAudit = await auditCodeBlocks(final, { sandbox: this.sandbox, timeoutMs });
    const findings = [];
    let ok = true;
    let checked = codeAudit.checked > 0;
    let numericCheck = null;

    if (codeAudit.failed > 0) {
      ok = false;
      for (const f of codeAudit.findings) {
        findings.push({ kind: 'code', message: `Code block #${f.blockIndex + 1} failed local sandbox execution: ${f.error}`, detail: f });
      }
    }

    const isQuantitative = (String(task ?? '').match(/\d+(?:\.\d+)?/g) || []).length >= 2;
    const allowNumeric = this.cfg?.auditor?.privateNumericCheck !== false;
    if (isQuantitative && allowNumeric && this.router) {
      const replyNum = extractAnswerNumber(task, final);
      if (replyNum !== null) {
        try {
          const res = await this.router.chat({
            role: agentId === 'forge_keeper' ? 'reason' : 'code',
            privacy: 'private',
            temperature: 0.1,
            maxTokens: 500,
            signal,
            messages: [
              { role: 'system', content: 'You are an independent local numeric checker. Solve the problem concisely from first principles without rounding intermediate values. End with one line: FINAL <number>' },
              { role: 'user', content: String(task ?? '').slice(0, 3000) },
            ],
          });
          const checkNum = extractAnswerNumber(task, res?.text);
          if (checkNum !== null) {
            checked = true;
            const agree = numbersAgree(replyNum, checkNum, task);
            numericCheck = { replyNum, checkNum, agree };
            if (!agree) {
              ok = false;
              findings.push({
                kind: 'numeric',
                message: `Independent local numeric check got ${checkNum} (reply stated ${replyNum}).`,
                detail: numericCheck,
              });
            }
          }
        } catch (e) {
          if (signal?.aborted) throw e;
        }
      }
    }

    const note = !ok && findings.length
      ? `**Local audit note:** ${findings.map((f) => f.message).join(' ')}`
      : null;

    // Privacy invariant: NEVER write raw task, reply, error text, or PII to the ledger.
    const meta = {
      agentId,
      privacy,
      taskSha256: sha256(String(task ?? '')),
      ok,
      codeChecked: codeAudit.checked,
      codeFailed: codeAudit.failed,
      numericChecked: numericCheck !== null,
      numericAgree: numericCheck ? numericCheck.agree : null,
      remoteCalls: 0,
    };
    this.ledger?.append('audit.private', meta, 'auditor');
    this.bus?.publish('audit.private', meta);
    return { ok, checked, codeAudit, numericCheck, findings, note };
  }
}
