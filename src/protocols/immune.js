// Cross-Agency Immune System (Phase 23): verified skill revocation and peer reputation.
//
// Security invariant: NEVER revoke on rumor. Every inbound `skill.advisory` already passed Ed25519
// signature, clock-window, nonce-replay and known/trusted-peer checks in Mesh.receive(), and MUST
// still reproduce locally before quarantining:
//   - crash        : runs the local skill in the permission-locked sandbox (0 GPU calls).
//   - wrong_output : checks grounding against the task first (0 GPU calls to reject trap inputs),
//                    runs the local skill in the sandbox, then verifies independently via local
//                    `programVoice` (strictly privacy:'private').
// Confirmed advisories quarantine the skill + retire its binder + increment sender `rep_confirmed`
// + gossip up to `ttl` hops (loop-safe). False flags leave the skill untouched, increment
// `rep_false_flags`, and auto-demote a `trusted` peer to `known` once the threshold is reached.
// Privacy invariant: `emitAdvisory` passes the task through the Privacy Membrane detector and
// refuses to broadcast any advisory containing PII/secrets.
import { nowIso, sha256, canonical, truncate, errorMessage } from '../core/util.js';
import { detect } from '../guard/membrane.js';
import { runSandboxedJs } from '../tools/builtin.js';
import { groundingProblem } from '../evolve/crystallizer.js';
import { programVoice, programsAgree } from '../evolve/program-voice.js';

const HEX64 = /^[0-9a-f]{64}$/i;

/** Check required keys and JSON types declared in a skill's input schema (guards crash advisories against malformed traps). */
function schemaProblem(input, schema) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const k of schema?.required || []) if (!(k in input)) return `required input ${k} is missing`;
  for (const [k, p] of Object.entries(schema?.properties || {})) {
    if (!(k in input) || !p?.type) continue;
    const v = input[k];
    const ok = p.type === 'number' || p.type === 'integer'
      ? typeof v === 'number' && Number.isFinite(v)
      : p.type === 'array' ? Array.isArray(v)
      : p.type === 'string' ? typeof v === 'string'
      : p.type === 'boolean' ? typeof v === 'boolean'
      : p.type === 'object' ? Boolean(v && typeof v === 'object' && !Array.isArray(v))
      : true;
    if (!ok) return `${k} should be ${p.type}`;
  }
  return null;
}

/** Collect string leaves of an input object so privacy checks cover string inputs too. */
function stringLeaves(val, out = []) {
  if (typeof val === 'string') { if (val.trim()) out.push(val); }
  else if (Array.isArray(val)) for (const x of val) stringLeaves(x, out);
  else if (val && typeof val === 'object') for (const x of Object.values(val)) stringLeaves(x, out);
  return out;
}

export class ImmuneSystem {
  constructor({ store, mesh, crystallizer, router, ledger, bus, cfg = null, membrane = null, sandbox = runSandboxedJs, verifyOutput = null }) {
    Object.assign(this, { store, mesh, crystallizer, router, ledger, bus, cfg, membrane, sandbox });
    this.verifyOutput = verifyOutput || ((task) => programVoice(task, { router: this.router, sandbox: this.sandbox }));
  }

  #program(code, input, library) {
    const lib = library.map((s) => `const skill_${s.name} = (() => { ${s.code}\n return main; })();`).join('\n');
    return `${lib}\n${code}\nconst __out = main(${JSON.stringify(input)});\nconsole.log(JSON.stringify({ out: __out === undefined ? null : __out }));`;
  }

  async #runSkill(code, input, library) {
    const r = await this.sandbox(this.#program(code, input, library), { timeoutMs: 5000 });
    if (r.timedOut) return { error: 'timed out' };
    if (r.exitCode !== 0) return { error: (r.stderr || 'failed').split('\n')[0].slice(0, 160) };
    const line = String(r.stdout).trim().split(/\r?\n/).at(-1);
    try { return { out: JSON.parse(line).out }; } catch { return { error: 'no JSON output' }; }
  }

  /**
   * Broadcast a signed `skill.advisory` to all non-blocked peers (`trusted` and `known`).
   * Refuses to send if the Privacy Membrane detects any PII/secret in the task or string inputs.
   */
  async emitAdvisory({ skill, kind, input, task = null, expectedAnswer = null, error = null, ttl = 1 } = {}) {
    if (!skill?.code_sha256 || !skill?.name) throw new Error('emitAdvisory requires skill with name and code_sha256');
    if (kind !== 'crash' && kind !== 'wrong_output') throw new Error('advisory kind must be crash or wrong_output');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('emitAdvisory requires an object input');

    const terms = this.membrane?.terms?.() || [];
    const spans = [];
    if (task) spans.push(...detect(String(task), { terms }));
    for (const s of stringLeaves(input)) spans.push(...detect(s, { terms }));
    if (spans.length) {
      this.ledger.append('immune.advisory_blocked', {
        codeSha256: skill.code_sha256,
        skillName: skill.name,
        kind,
        reason: 'privacy',
        types: [...new Set(spans.map((x) => x.type))],
      }, 'immune');
      return { sent: 0, blocked: true, reason: 'privacy' };
    }

    const body = {
      codeSha256: String(skill.code_sha256).toLowerCase(),
      skillName: String(skill.name),
      kind,
      input,
      task: task ?? null,
      expectedAnswer: expectedAnswer ?? null,
      error: error ? truncate(String(error), 200) : null,
      ttl: Math.max(0, Math.min(3, Number.isFinite(Number(ttl)) ? Number(ttl) : 1)),
    };

    const peers = this.mesh.peers().filter((p) => p.trust === 'trusted' || p.trust === 'known');
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
   * Process an inbound signed `skill.advisory` from a known/trusted peer.
   * Always reproduces locally before quarantining; never revokes on rumor.
   */
  async handleAdvisory(peer, body) {
    if (!peer?.public_key) throw new Error('advisory requires a known peer');
    if (!body || typeof body.codeSha256 !== 'string' || !HEX64.test(body.codeSha256)) throw new Error('invalid advisory codeSha256');
    if (body.kind !== 'crash' && body.kind !== 'wrong_output') throw new Error('invalid advisory kind');
    if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw new Error('invalid advisory input');

    const codeSha256 = body.codeSha256.toLowerCase();
    const skillName = String(body.skillName || 'unknown').slice(0, 60);
    const inputSha = sha256(canonical(body.input));
    const advisoryId = `adv_${sha256(canonical([codeSha256, peer.public_key, body.kind, inputSha])).slice(0, 24)}`;

    // Exact dedup per (codeSha256, sender, kind, input).
    if (this.store.get('SELECT id FROM skill_advisories WHERE id = ?', advisoryId)) {
      return { ok: true, duplicate: true };
    }

    const matching = this.store.all(
      "SELECT * FROM skills WHERE code_sha256 = ? AND status IN ('active', 'probation')",
      codeSha256,
    ).map((r) => ({ ...r, params: JSON.parse(r.params), verification: JSON.parse(r.verification || '{}') }));

    if (!matching.length) {
      // Loop-safe short-circuit if this exact skill hash is already quarantined locally.
      if (this.isQuarantinedHash(codeSha256) || this.store.get("SELECT id FROM skills WHERE code_sha256 = ? AND status = 'quarantined' LIMIT 1", codeSha256)) {
        return { ok: true, duplicate: true, verdict: 'already_quarantined', skill: skillName, demoted: false };
      }
      this.store.run(
        'INSERT INTO skill_advisories (id, code_sha256, skill_name, sender_key, kind, counterexample, verdict, detail, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        advisoryId, codeSha256, skillName, peer.public_key, body.kind,
        JSON.stringify({ input: body.input, task: body.task ? truncate(String(body.task), 500) : null, expectedAnswer: body.expectedAnswer ?? null }),
        'not_installed', JSON.stringify({ note: 'skill hash not installed locally' }), nowIso(),
      );
      return { ok: true, verdict: 'not_installed', skill: null, demoted: false };
    }

    const skill = matching[0];
    const library = this.crystallizer.list('active').filter((x) => x.name !== skill.name);
    let verdict = 'inconclusive';
    let detail = {};

    if (body.kind === 'crash') {
      const sp = schemaProblem(body.input, skill.params);
      if (sp) {
        verdict = 'false_flag';
        detail = { reason: `input violates skill schema: ${sp}` };
      } else {
        const run = await this.#runSkill(skill.code, body.input, library);
        if (run.error) {
          verdict = 'confirmed';
          detail = { error: run.error };
        } else {
          verdict = 'false_flag';
          detail = { localOut: run.out, reason: 'skill executed cleanly without crashing' };
        }
      }
    } else {
      // kind === 'wrong_output'
      const taskText = typeof body.task === 'string' ? body.task.trim() : '';
      const gp = !taskText ? 'missing task' : groundingProblem(body.input, skill.params, taskText);
      if (gp !== null) {
        verdict = 'false_flag';
        detail = { reason: `ungrounded counterexample: ${gp}` };
      } else {
        const run = await this.#runSkill(skill.code, body.input, library);
        if (run.error) {
          verdict = 'confirmed';
          detail = { error: run.error, note: 'skill crashed during wrong_output reproduction' };
        } else if (typeof run.out !== 'number') {
          verdict = 'inconclusive';
          detail = { localOut: run.out, reason: 'non-numeric skill output' };
        } else {
          let v = null;
          try { v = await this.verifyOutput(taskText); } catch (e) { v = { answer: null, verdict: errorMessage(e), votes: [] }; }
          if (v?.answer == null) {
            verdict = 'inconclusive';
            detail = { localOut: run.out, verifyVerdict: v?.verdict || 'no verification answer' };
          } else if (programsAgree(run.out, v.answer)) {
            verdict = 'false_flag';
            detail = { localOut: run.out, verifiedAnswer: v.answer, verifyVerdict: v.verdict || null, reason: 'local skill agrees with independent verification' };
          } else {
            verdict = 'confirmed';
            detail = { localOut: run.out, verifiedAnswer: v.answer, verifyVerdict: v.verdict || null };
          }
        }
      }
    }

    this.store.run(
      'INSERT INTO skill_advisories (id, code_sha256, skill_name, sender_key, kind, counterexample, verdict, detail, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      advisoryId, codeSha256, skill.name, peer.public_key, body.kind,
      JSON.stringify({ input: body.input, task: body.task ? truncate(String(body.task), 500) : null, expectedAnswer: body.expectedAnswer ?? null }),
      verdict, JSON.stringify(detail), nowIso(),
    );

    let demoted = false;
    let relayed = 0;

    if (verdict === 'confirmed') {
      for (const s of matching) {
        this.crystallizer.quarantine(s.name, `immune advisory from ${peer.name}: ${body.kind}`, { advisoryId, senderKey: peer.public_key });
      }
      this.store.run('UPDATE peers SET rep_confirmed = rep_confirmed + 1 WHERE id = ?', peer.id);
      this.ledger.append('immune.quarantine', {
        advisoryId, codeSha256, skill: skill.name, kind: body.kind,
        peerId: peer.id, peerName: peer.name, senderKey: peer.public_key,
      }, 'immune');
      this.bus?.publish('immune.quarantine', { advisoryId, codeSha256, skill: skill.name, kind: body.kind, peer: peer.name });

      // Gossip relay to other trusted peers (excluding sender), decrementing TTL.
      const ttl = Number(body.ttl ?? 0);
      if (ttl > 0) {
        const forward = { ...body, ttl: ttl - 1 };
        const targets = this.mesh.peers().filter((p) => p.trust === 'trusted' && p.id !== peer.id && p.public_key !== peer.public_key);
        for (const target of targets) {
          try {
            await this.mesh.send(target.id, 'skill.advisory', forward);
            relayed++;
          } catch { /* peer offline or rejected */ }
        }
      }
    } else if (verdict === 'false_flag') {
      this.store.run('UPDATE peers SET rep_false_flags = rep_false_flags + 1 WHERE id = ?', peer.id);
      this.ledger.append('immune.false_flag', {
        advisoryId, codeSha256, skill: skill.name, kind: body.kind,
        peerId: peer.id, peerName: peer.name, reason: detail.reason || 'verification disagreed',
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
        peerId: peer.id, peerName: peer.name,
      }, 'immune');
    }

    return { ok: true, verdict, skill: skill.name, demoted, ...(relayed ? { relayed } : {}) };
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
