// Human-in-the-loop approvals with signed single-use writs.
// When an agent wants an approval-class tool, the call is parked as a pending approval.
// A human approves -> the agency mints a writ bound to (tool, sha256(args)), valid 10 minutes, usable once.
// The tool executor refuses approval-class calls without a valid, unconsumed writ.
import { newId, nowIso, sha256, canonical } from '../core/util.js';

const WRIT_TTL_MS = 10 * 60 * 1000;

export class Approvals {
  constructor({ store, keyring, ledger, bus }) {
    this.store = store;
    this.keyring = keyring;
    this.ledger = ledger;
    this.bus = bus;
    this.waiters = new Map(); // approvalId -> [resolve]
  }

  request({ missionId = null, taskId = null, agentId = null, tool, args, reason = '' }) {
    const id = newId('ap');
    this.store.run('INSERT INTO approvals (id, mission_id, task_id, agent_id, tool, args, reason, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, missionId, taskId, agentId, tool, args, String(reason).slice(0, 1000), 'pending', nowIso());
    this.ledger.append('approval.request', { id, tool, agentId, missionId, argsHash: sha256(canonical(args)) }, agentId || 'agency');
    this.bus?.publish('approval.request', { id, tool, agentId, missionId, args, reason });
    return id;
  }

  get(id) {
    const r = this.store.get('SELECT * FROM approvals WHERE id = ?', id);
    return r ? { ...r, args: JSON.parse(r.args) } : null;
  }

  list(status = 'pending', limit = 100) {
    return this.store.all(`SELECT * FROM approvals WHERE (? IS NULL OR status = ?) ORDER BY created DESC LIMIT ${Math.min(500, limit | 0)}`, status, status)
      .map((r) => ({ ...r, args: JSON.parse(r.args) }));
  }

  /** Decide an approval. Approving returns a signed writ. */
  decide(id, approve, by = 'operator') {
    const ap = this.get(id);
    if (!ap) throw new Error(`approval ${id} not found`);
    if (ap.status !== 'pending') throw new Error(`approval ${id} already ${ap.status}`);
    const status = approve ? 'approved' : 'denied';
    this.store.run('UPDATE approvals SET status = ?, decided = ?, decided_by = ? WHERE id = ?', status, nowIso(), by, id);
    let writ = null;
    if (approve) writ = this.mintWrit(ap);
    this.ledger.append('approval.decide', { id, status, by, writ: writ?.id ?? null }, by);
    this.bus?.publish('approval.decide', { id, status });
    for (const resolve of this.waiters.get(id) || []) resolve({ status, writ });
    this.waiters.delete(id);
    return { status, writ };
  }

  /** Resolve when the approval is decided (used by agents that park mid-task). */
  wait(id, timeoutMs = 0) {
    const ap = this.get(id);
    if (ap && ap.status !== 'pending') {
      return Promise.resolve({ status: ap.status, writ: ap.status === 'approved' ? this.#writFor(id) : null });
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(id) || [];
      list.push(resolve);
      this.waiters.set(id, list);
      if (timeoutMs > 0) setTimeout(() => resolve({ status: 'timeout', writ: null }), timeoutMs);
    });
  }

  mintWrit(ap) {
    const writ = {
      id: newId('writ'), approvalId: ap.id, tool: ap.tool, argsHash: sha256(canonical(ap.args)),
      issued: Date.now(), expires: Date.now() + WRIT_TTL_MS, nonce: newId(),
    };
    writ.sig = this.keyring.get('agency').sign(writ);
    this.store.kvSet(`writ:${ap.id}`, writ);
    return writ;
  }

  #writFor(approvalId) { return this.store.kvGet(`writ:${approvalId}`); }

  /** Verify and consume a writ for an exact tool call. Returns { ok, reason }. */
  consume(writ, tool, args) {
    if (!writ) return { ok: false, reason: 'no writ' };
    const { sig, ...body } = writ;
    if (!this.keyring.get('agency').verify(body, sig)) return { ok: false, reason: 'writ signature invalid' };
    if (Date.now() > writ.expires) return { ok: false, reason: 'writ expired' };
    if (writ.tool !== tool) return { ok: false, reason: 'writ is for a different tool' };
    if (writ.argsHash !== sha256(canonical(args))) return { ok: false, reason: 'arguments differ from what was approved' };
    const usedKey = `writ-used:${writ.id}`;
    if (this.store.kvGet(usedKey)) return { ok: false, reason: 'writ already used' };
    this.store.kvSet(usedKey, { at: nowIso() });
    this.store.run("UPDATE approvals SET status = 'consumed' WHERE id = ?", writ.approvalId);
    this.ledger.append('writ.consume', { writ: writ.id, tool }, 'agency');
    return { ok: true };
  }
}
