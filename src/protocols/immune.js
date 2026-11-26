// Cross-Agency Immune System (Phase 23): verified skill revocation and peer reputation.
//
// Security invariant: NEVER revoke on rumor. Every inbound `skill.advisory` already passed Ed25519
// signature, clock-window, nonce-replay and trusted-peer checks in Mesh.receive(), and MUST
// still reproduce locally before quarantining:
//   - crash        : strictly validates input bounds & recursive JSON schema, runs local skill
//                    (with active + probation library when on probation) in sandbox (0 GPU calls).
//                    Timeouts are treated as inconclusive (never DoS-quarantine).
//   - wrong_output : rejects prompt injection, domain/binding mismatch, relevance mismatch,
//                    learned-block/binder disagreement at 0 GPU calls; runs local skill in sandbox;
//                    then verifies independently via local `programVoice` (strictly privacy:'private').
// Confirmed advisories quarantine the skill + retire its binder + increment sender `rep_confirmed`
// + relay sanitized allowlisted payload up to clamped `ttl` hops (loop-safe). False flags leave the
// skill untouched, increment `rep_false_flags`, and auto-demote `trusted -> known` (blocking further
// advisories) once the threshold is reached.
// Privacy invariant: `emitAdvisory` scans task, error, skillName, expectedAnswer, and all input
// keys & values through the Privacy Membrane detector (and optional local NER) and refuses to
// broadcast any advisory containing PII/secrets; relays only to `trusted` peers.
import { nowIso, sha256, canonical, truncate, errorMessage } from '../core/util.js';
import { detect } from '../guard/membrane.js';
import { scanInjection } from '../guard/sentinel.js';
import { runSandboxedJs } from '../tools/builtin.js';
import { groundingProblem, bindingProblem, relevance, sameInput } from '../evolve/crystallizer.js';
import { learnBlocks } from '../evolve/binder-induction.js';
import { programVoice, programsAgree } from '../evolve/program-voice.js';

const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_INPUT_BYTES = 4096;
const MAX_INPUT_DEPTH = 6;
const MAX_ARRAY_LEN = 100;
const MAX_TTL = 3;

// Opposing-domain keyword guards when a skill's own metadata doesn't mention those terms
// (prevents domain-mismatch wrong_output attacks like sending a tax/tip task against a discount skill).
const OPPOSING_TERMS = ['tax', 'tip', 'gratuity', 'shipping', 'surcharge', 'interest', 'commission'];

/** Validate JSON input depth, array lengths, and serialized size BEFORE calling canonical() or sandbox. */
function inputBoundsProblem(val, depth = 0, seen = new Set()) {
  if (depth > MAX_INPUT_DEPTH) return 'input exceeds max nesting depth';
  if (val === null || typeof val !== 'object') return null;
  if (seen.has(val)) return 'circular input';
  seen.add(val);
  try {
    if (Array.isArray(val)) {
      if (val.length > MAX_ARRAY_LEN) return 'input array exceeds max length';
      for (const x of val) {
        const err = inputBoundsProblem(x, depth + 1, seen);
        if (err) return err;
      }
    } else {
      const keys = Object.keys(val);
      if (keys.length > MAX_ARRAY_LEN) return 'input object exceeds max keys';
      for (const k of keys) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return 'forbidden prototype key';
        const err = inputBoundsProblem(val[k], depth + 1, seen);
        if (err) return err;
      }
    }
    if (depth === 0) {
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(val), 'utf8'); } catch { return 'input is not JSON-serializable'; }
      if (bytes > MAX_INPUT_BYTES) return 'input exceeds max byte size';
    }
    return null;
  } finally {
    seen.delete(val);
  }
}

/** Recursive JSON schema check (guards crash advisories against malformed/out-of-schema trap inputs). */
function schemaProblem(val, schema, pathName = 'input', depth = 0) {
  if (depth > MAX_INPUT_DEPTH) return `${pathName} too deep`;
  if (!schema || typeof schema !== 'object') return null;
  const type = schema.type;
  if (type === 'object') {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return `${pathName} must be an object`;
    for (const k of schema.required || []) {
      if (!Object.hasOwn(val, k)) return `required ${pathName}.${k} is missing`;
    }
    for (const [k, p] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(val, k)) continue;
      const err = schemaProblem(val[k], p, `${pathName}.${k}`, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (type === 'array') {
    if (!Array.isArray(val)) return `${pathName} should be array`;
    if (typeof schema.minItems === 'number' && val.length < schema.minItems) return `${pathName} too short`;
    if (typeof schema.maxItems === 'number' && val.length > schema.maxItems) return `${pathName} too long`;
    if (schema.items) {
      for (let i = 0; i < val.length; i++) {
        const err = schemaProblem(val[i], schema.items, `${pathName}[${i}]`, depth + 1);
        if (err) return err;
      }
    }
    return null;
  }
  if (type === 'integer') {
    if (typeof val !== 'number' || !Number.isInteger(val)) return `${pathName} should be integer`;
  } else if (type === 'number') {
    if (typeof val !== 'number' || !Number.isFinite(val)) return `${pathName} should be number`;
  } else if (type === 'string') {
    if (typeof val !== 'string') return `${pathName} should be string`;
  } else if (type === 'boolean') {
    if (typeof val !== 'boolean') return `${pathName} should be boolean`;
  }
  if (typeof val === 'number') {
    if (typeof schema.minimum === 'number' && val < schema.minimum) return `${pathName} below minimum`;
    if (typeof schema.maximum === 'number' && val > schema.maximum) return `${pathName} above maximum`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(val)) return `${pathName} not in enum`;
  return null;
}

/** Collect all strings (both keys and values) with depth & cycle guards for privacy scanning. */
function collectStrings(val, out = [], depth = 0, seen = new Set()) {
  if (depth > MAX_INPUT_DEPTH || val == null) return out;
  if (typeof val === 'string') { if (val.trim()) out.push(val); return out; }
  if (typeof val !== 'object' || seen.has(val)) return out;
  seen.add(val);
  try {
    if (Array.isArray(val)) {
      for (const x of val) collectStrings(x, out, depth + 1, seen);
    } else {
      for (const [k, v] of Object.entries(val)) {
        if (k.trim()) out.push(k);
        collectStrings(v, out, depth + 1, seen);
      }
    }
  } finally {
    seen.delete(val);
  }
  return out;
}

/** Check whether a task contains opposing domain terms absent from the skill's name/description/params. */
function opposingDomainTerm(skill, task) {
  const skillMeta = `${skill.name || ''} ${skill.description || ''} ${JSON.stringify(skill.params || {})}`.toLowerCase();
  const lower = String(task).toLowerCase();
  for (const term of OPPOSING_TERMS) {
    const re = new RegExp(`\\b${term}(?:es|s)?\\b`, 'i');
    if (re.test(lower) && !re.test(skillMeta)) return term;
  }
  return null;
}

export class ImmuneSystem {
  constructor({ store, mesh, crystallizer, router, ledger, bus, cfg = null, membrane = null, sandbox = runSandboxedJs, verifyOutput = null }) {
    Object.assign(this, { store, mesh, crystallizer, router, ledger, bus, cfg, membrane, sandbox });
    this.verifyOutput = verifyOutput || ((task) => programVoice(task, { router: this.router, sandbox: this.sandbox }));
    this.inFlight = new Set();
    this.peerHits = new Map(); // peerId -> [timestamps]
  }

  #program(code, input, library) {
    const lib = library.map((s) => `const skill_${s.name} = (() => { ${s.code}\n return main; })();`).join('\n');
    return `${lib}\n${code}\nconst __out = main(${JSON.stringify(input)});\nconsole.log(JSON.stringify({ out: __out === undefined ? null : __out }));`;
  }

  async #runSkill(code, input, library) {
    const r = await this.sandbox(this.#program(code, input, library), { timeoutMs: 5000 });
    if (r.timedOut) return { timedOut: true, error: 'timed out' };
    if (r.exitCode !== 0) return { error: (r.stderr || 'failed').split('\n')[0].slice(0, 160) };
    const line = String(r.stdout).trim().split(/\r?\n/).at(-1);
    try { return { out: JSON.parse(line).out }; } catch { return { error: 'no JSON output' }; }
  }

  async #runBinder(code, task) {
    const src = `${code}\nconst __out = bind(${JSON.stringify(String(task))});\nconsole.log(JSON.stringify({ out: __out === undefined ? null : __out }));`;
    const r = await this.sandbox(src, { timeoutMs: 3000 });
    if (r.timedOut || r.exitCode !== 0) return { error: r.timedOut ? 'timed out' : 'binder failed' };
    const line = String(r.stdout).trim().split(/\r?\n/).at(-1);
    try { return { out: JSON.parse(line).out }; } catch { return { error: 'no JSON output' }; }
  }

  async #privacySpans({ task, error, skillName, expectedAnswer, input }) {
    const terms = this.membrane?.terms?.() || [];
    const spans = [];
    const texts = [];
    if (task) texts.push(String(task));
    if (error) texts.push(String(error));
    if (skillName) texts.push(String(skillName));
    if (expectedAnswer != null && typeof expectedAnswer !== 'number') texts.push(String(expectedAnswer));
    collectStrings(input, texts);
    for (const s of texts) spans.push(...detect(s, { terms }));
    // Optional local NER on task text when enabled; fails closed if NER is enabled and unavailable.
    if (task && this.membrane?.spans && this.cfg?.mesh?.advisoryUseNer === true) {
      const status = { ner: 'pending' };
      const nerSpans = await this.membrane.spans(String(task), { useNer: true, status });
      spans.push(...nerSpans);
      if (status.ner === 'unavailable') spans.push({ type: 'NER_UNAVAILABLE' });
    }
    return spans;
  }

  #checkRateLimit(peerId) {
    const limit = this.cfg?.mesh?.advisoryRateLimitPerMin ?? 12;
    const now = Date.now();
    const list = (this.peerHits.get(peerId) || []).filter((t) => now - t < 60000);
    if (list.length >= limit) return false;
    list.push(now);
    this.peerHits.set(peerId, list);
    return true;
  }

  /**
   * Broadcast a signed `skill.advisory` to `trusted` peers.
   * Refuses to send if the Privacy Membrane detects any PII/secret in task, error, skillName, or input.
   */
  async emitAdvisory({ skill, kind, input, task = null, expectedAnswer = null, error = null, ttl = 1 } = {}) {
    if (!skill?.code_sha256 || !skill?.name) throw new Error('emitAdvisory requires skill with name and code_sha256');
    if (kind !== 'crash' && kind !== 'wrong_output') throw new Error('advisory kind must be crash or wrong_output');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('emitAdvisory requires an object input');
    const boundsErr = inputBoundsProblem(input);
    if (boundsErr) throw new Error(`emitAdvisory invalid input: ${boundsErr}`);
    if (expectedAnswer !== null && (typeof expectedAnswer !== 'number' || !Number.isFinite(expectedAnswer))) {
      throw new Error('emitAdvisory expectedAnswer must be a finite number or null');
    }

    const spans = await this.#privacySpans({ task, error, skillName: skill.name, expectedAnswer, input });
    if (spans.length) {
      this.ledger.append('immune.advisory_blocked', {
        codeSha256: String(skill.code_sha256).toLowerCase(),
        skillName: String(skill.name),
        kind,
        reason: 'privacy',
        types: [...new Set(spans.map((x) => x.type))],
      }, 'immune');
      return { sent: 0, blocked: true, reason: 'privacy' };
    }

    const body = {
      codeSha256: String(skill.code_sha256).toLowerCase(),
      skillName: String(skill.name).slice(0, 60),
      kind,
      input,
      task: task ? truncate(String(task), 1000) : null,
      expectedAnswer: expectedAnswer ?? null,
      error: error ? truncate(String(error), 200) : null,
      ttl: Math.max(0, Math.min(MAX_TTL, Number.isInteger(Number(ttl)) ? Number(ttl) : 1)),
    };

    const peers = this.mesh.peers().filter((p) => p.trust === 'trusted');
    const results = [];
    let sent = 0;
    for (const peer of peers) {
      try {
        const reply = await this.mesh.send(peer.id, 'skill.advisory', body);
        results.push({ peerId: peer.id, peer: peer.name, ok: true, reply });
        sent++;
      } catch (e) {
        results.push({ peerId: peer.id, peer: peer.name, ok: false, error: errorMessage(e) });
      }
    }

    this.ledger.append('immune.advisory_out', {
      codeSha256: body.codeSha256,
      skillName: body.skillName,
      kind,
      sent,
      peers: peers.length,
      ttl: body.ttl,
    }, 'immune');
    return { sent, results };
  }

  /**
   * Process an inbound signed `skill.advisory` from a trusted peer.
   * Always reproduces locally before quarantining; never revokes on rumor.
   */
  async handleAdvisory(peer, body) {
    if (!peer?.public_key) throw new Error('advisory requires a known peer');
    if (peer.trust !== 'trusted') throw new Error('skill.advisory requires a trusted peer');
    if (!this.#checkRateLimit(peer.id)) throw new Error('advisory rate limit exceeded for peer');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid advisory body');
    if (typeof body.codeSha256 !== 'string' || !HEX64.test(body.codeSha256)) throw new Error('invalid advisory codeSha256');
    if (body.kind !== 'crash' && body.kind !== 'wrong_output') throw new Error('invalid advisory kind');
    if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw new Error('invalid advisory input');

    // Enforce depth/byte bounds BEFORE canonical() or sandbox (guards H4/C4 stack/DoS).
    const boundsErr = inputBoundsProblem(body.input);
    if (boundsErr) throw new Error(`invalid advisory input: ${boundsErr}`);

    const codeSha256 = body.codeSha256.toLowerCase();
    const skillName = String(body.skillName || 'unknown').slice(0, 60);
    const inputSha = sha256(canonical(body.input));
    const advisoryId = `adv_${sha256(canonical([codeSha256, peer.public_key, body.kind, inputSha])).slice(0, 24)}`;

    if (this.inFlight.has(advisoryId)) return { ok: true, duplicate: true };
    const existing = this.store.get('SELECT id, verdict FROM skill_advisories WHERE id = ?', advisoryId);
    if (existing && existing.verdict !== 'not_installed') {
      return { ok: true, duplicate: true };
    }

    this.inFlight.add(advisoryId);
    try {
      const matching = this.store.all(
        "SELECT * FROM skills WHERE code_sha256 = ? AND status IN ('active', 'probation')",
        codeSha256,
      ).map((r) => ({ ...r, params: JSON.parse(r.params), verification: JSON.parse(r.verification || '{}') }));

      const expectedAnswer = typeof body.expectedAnswer === 'number' && Number.isFinite(body.expectedAnswer) ? body.expectedAnswer : null;
      const storedCounterexample = JSON.stringify({
        input: body.input,
        task: body.task ? truncate(String(body.task), 500) : null,
        expectedAnswer,
      });

      if (!matching.length) {
        if (this.isQuarantinedHash(codeSha256) || this.store.get("SELECT id FROM skills WHERE code_sha256 = ? AND status = 'quarantined' LIMIT 1", codeSha256)) {
          return { ok: true, duplicate: true, verdict: 'already_quarantined', skill: skillName, demoted: false };
        }
        if (!existing) {
          this.store.run(
            'INSERT OR IGNORE INTO skill_advisories (id, code_sha256, skill_name, sender_key, kind, counterexample, verdict, detail, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            advisoryId, codeSha256, skillName, peer.public_key, body.kind,
            storedCounterexample, 'not_installed', JSON.stringify({ note: 'skill hash not installed locally' }), nowIso(),
          );
        }
        return { ok: true, verdict: 'not_installed', skill: null, demoted: false };
      }

      const skill = matching[0];
      // Include probation dependencies when evaluating a probation skill (fixes C3).
      const pool = skill.status === 'probation'
        ? [...this.crystallizer.list('active'), ...this.crystallizer.list('probation')]
        : this.crystallizer.list('active');
      const library = pool.filter((x) => x.name !== skill.name);

      let verdict = 'inconclusive';
      let reasonCode = 'inconclusive';
      let detail = {};

      if (body.kind === 'crash') {
        const sp = schemaProblem(body.input, skill.params);
        if (sp) {
          verdict = 'false_flag';
          reasonCode = 'schema_violation';
          detail = { reason: sp };
        } else {
          const run = await this.#runSkill(skill.code, body.input, library);
          if (run.timedOut) {
            verdict = 'inconclusive';
            reasonCode = 'sandbox_timeout';
            detail = { reason: 'sandbox execution timed out' };
          } else if (run.error) {
            verdict = 'confirmed';
            reasonCode = 'crash_reproduced';
            detail = { error: run.error };
          } else {
            verdict = 'false_flag';
            reasonCode = 'no_crash_reproduced';
            detail = { localOut: run.out, reason: 'skill executed cleanly without crashing' };
          }
        }
      } else {
        // kind === 'wrong_output'
        const taskText = typeof body.task === 'string' ? body.task.trim().slice(0, 1000) : '';
        const sp = schemaProblem(body.input, skill.params);
        const inj = taskText ? scanInjection(taskText) : { suspicious: false };
        const gp = !taskText ? 'missing task' : groundingProblem(body.input, skill.params, taskText);
        const bp = !taskText || gp ? null : bindingProblem(body.input, skill, taskText);
        const rel = taskText ? relevance(skill, taskText, 1) : { ok: false };
        const opp = taskText ? opposingDomainTerm(skill, taskText) : null;

        if (!taskText) {
          verdict = 'false_flag'; reasonCode = 'missing_task'; detail = { reason: 'missing task' };
        } else if (sp) {
          verdict = 'false_flag'; reasonCode = 'schema_violation'; detail = { reason: sp };
        } else if (inj.suspicious) {
          verdict = 'false_flag'; reasonCode = 'prompt_injection'; detail = { reason: 'prompt injection detected in advisory task' };
        } else if (gp !== null) {
          verdict = 'false_flag'; reasonCode = 'ungrounded_counterexample'; detail = { reason: 'ungrounded counterexample' };
        } else if (bp !== null) {
          verdict = 'false_flag'; reasonCode = 'binding_mismatch'; detail = { reason: bp };
        } else if (!rel.ok) {
          verdict = 'false_flag'; reasonCode = 'domain_mismatch'; detail = { reason: 'task not relevant to skill contract' };
        } else if (opp) {
          verdict = 'false_flag'; reasonCode = 'opposing_domain'; detail = { reason: `opposing domain term: ${opp}` };
        } else {
          // If the skill has learned block words or an active learned binder, verify the binder agrees with body.input.
          let binderMismatch = null;
          const ex = this.crystallizer.examples ? this.crystallizer.examples(skill.name) : [];
          const pos = ex.filter((e) => e.label === 'pos' && e.input);
          const neg = ex.filter((e) => e.label === 'neg');
          if (pos.length && neg.length) {
            const blocks = learnBlocks(pos, neg);
            const lower = taskText.toLowerCase();
            if (blocks.blockWords?.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower))) {
              binderMismatch = 'task matches learned block word';
            }
          }
          const activeBinder = !binderMismatch && this.crystallizer.binder ? this.crystallizer.binder(skill.name) : null;
          if (!binderMismatch && activeBinder?.code) {
            const br = await this.#runBinder(activeBinder.code, taskText);
            if (!br.error && (br.out == null || !sameInput(br.out, body.input))) {
              binderMismatch = 'active binder disagrees with advisory input';
            }
          }

          if (binderMismatch) {
            verdict = 'false_flag';
            reasonCode = 'binder_mismatch';
            detail = { reason: binderMismatch };
          } else {
            const run = await this.#runSkill(skill.code, body.input, library);
            if (run.timedOut) {
              verdict = 'inconclusive';
              reasonCode = 'sandbox_timeout';
              detail = { reason: 'sandbox execution timed out' };
            } else if (run.error) {
              verdict = 'confirmed';
              reasonCode = 'crash_reproduced';
              detail = { error: run.error, note: 'skill crashed during wrong_output reproduction' };
            } else if (typeof run.out !== 'number') {
              verdict = 'inconclusive';
              reasonCode = 'non_numeric_output';
              detail = { localOut: run.out, reason: 'non-numeric skill output' };
            } else {
              let v = null;
              try { v = await this.verifyOutput(taskText); } catch (e) { v = { answer: null, verdict: errorMessage(e), votes: [] }; }
              if (v?.answer == null) {
                verdict = 'inconclusive';
                reasonCode = 'verifier_silent';
                detail = { localOut: run.out, verifyVerdict: v?.verdict || 'no verification answer' };
              } else if (programsAgree(run.out, v.answer)) {
                verdict = 'false_flag';
                reasonCode = 'verified_agree';
                detail = { localOut: run.out, verifiedAnswer: v.answer, verifyVerdict: v.verdict || null, reason: 'local skill agrees with independent verification' };
              } else {
                verdict = 'confirmed';
                reasonCode = 'verified_disagree';
                detail = { localOut: run.out, verifiedAnswer: v.answer, verifyVerdict: v.verdict || null };
              }
            }
          }
        }
      }

      if (existing && existing.verdict === 'not_installed') {
        this.store.run(
          'UPDATE skill_advisories SET skill_name = ?, counterexample = ?, verdict = ?, detail = ?, created = ? WHERE id = ?',
          skill.name, storedCounterexample, verdict, JSON.stringify(detail), nowIso(), advisoryId,
        );
      } else {
        const ins = this.store.run(
          'INSERT OR IGNORE INTO skill_advisories (id, code_sha256, skill_name, sender_key, kind, counterexample, verdict, detail, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          advisoryId, codeSha256, skill.name, peer.public_key, body.kind,
          storedCounterexample, verdict, JSON.stringify(detail), nowIso(),
        );
        if (ins.changes === 0) return { ok: true, duplicate: true };
      }

      let demoted = false;
      let relayed = 0;

      if (verdict === 'confirmed') {
        let quarantinedCount = 0;
        for (const s of matching) {
          if (this.crystallizer.quarantine(s.name, `immune advisory from ${peer.name}: ${body.kind}`, { advisoryId, senderKey: peer.public_key })) {
            quarantinedCount++;
          }
        }
        if (quarantinedCount > 0) {
          this.store.run('UPDATE peers SET rep_confirmed = rep_confirmed + 1 WHERE id = ?', peer.id);
          this.ledger.append('immune.quarantine', {
            advisoryId, codeSha256, skill: skill.name, kind: body.kind,
            peerId: peer.id, peerName: peer.name, senderKey: peer.public_key,
          }, 'immune');
          this.bus?.publish('immune.quarantine', { advisoryId, codeSha256, skill: skill.name, kind: body.kind, peer: peer.name });

          // Clamp TTL strictly [0..MAX_TTL], construct allowlisted payload, re-check privacy before relay.
          const ttl = Math.max(0, Math.min(MAX_TTL, Number.isInteger(body.ttl) ? body.ttl : 0));
          if (ttl > 0) {
            const forward = {
              codeSha256,
              skillName: skill.name,
              kind: body.kind,
              input: body.input,
              task: body.task ? truncate(String(body.task), 1000) : null,
              expectedAnswer,
              error: body.error ? truncate(String(body.error), 200) : null,
              ttl: ttl - 1,
            };
            const relaySpans = await this.#privacySpans(forward);
            if (!relaySpans.length) {
              const targets = this.mesh.peers().filter((p) => p.trust === 'trusted' && p.id !== peer.id && p.public_key !== peer.public_key);
              for (const target of targets) {
                try {
                  await this.mesh.send(target.id, 'skill.advisory', forward);
                  relayed++;
                } catch { /* peer offline or rejected */ }
              }
            }
          }
        }
      } else if (verdict === 'false_flag') {
        this.store.run('UPDATE peers SET rep_false_flags = rep_false_flags + 1 WHERE id = ?', peer.id);
        this.ledger.append('immune.false_flag', {
          advisoryId, codeSha256, skill: skill.name, kind: body.kind,
          peerId: peer.id, peerName: peer.name, reason: reasonCode,
        }, 'immune');
        const updated = this.store.get('SELECT trust, rep_false_flags FROM peers WHERE id = ?', peer.id);
        const threshold = this.cfg?.mesh?.falseFlagDemoteAt ?? 2;
        if (updated && updated.rep_false_flags >= threshold && updated.trust === 'trusted') {
          this.mesh.setTrust(peer.id, 'known');
          demoted = true;
          this.ledger.append('immune.peer_demoted', {
            peerId: peer.id, peerName: peer.name, from: 'trusted', to: 'known',
            repFalseFlags: updated.rep_false_flags, threshold,
          }, 'immune');
          this.bus?.publish('immune.peer_demoted', { peerId: peer.id, peer: peer.name, repFalseFlags: updated.rep_false_flags });
        }
      } else {
        this.ledger.append('immune.inconclusive', {
          advisoryId, codeSha256, skill: skill.name, kind: body.kind,
          peerId: peer.id, peerName: peer.name, reason: reasonCode,
        }, 'immune');
      }

      return { ok: true, verdict, skill: skill.name, demoted, ...(relayed ? { relayed } : {}) };
    } finally {
      this.inFlight.delete(advisoryId);
    }
  }

  /** True if this exact skill code hash has already been confirmed bad by a local reproduction. */
  isQuarantinedHash(codeSha256) {
    if (!codeSha256) return false;
    return Boolean(this.store.get("SELECT 1 AS hit FROM skill_advisories WHERE code_sha256 = ? AND verdict = 'confirmed' LIMIT 1", String(codeSha256).toLowerCase()));
  }

  status() {
    const advisories = this.store.all('SELECT * FROM skill_advisories ORDER BY created DESC LIMIT 100')
      .map((r) => ({ ...r, counterexample: JSON.parse(r.counterexample || '{}'), detail: JSON.parse(r.detail || '{}') }));
    const quarantinedSkills = this.crystallizer.list('quarantined')
      .map((s) => ({ name: s.name, codeSha256: s.code_sha256, updated: s.updated }));
    const peers = this.mesh.peers()
      .map((p) => ({ id: p.id, name: p.name, trust: p.trust, rep_confirmed: p.rep_confirmed ?? 0, rep_false_flags: p.rep_false_flags ?? 0 }));
    return { advisories, quarantinedSkills, peers };
  }
}
