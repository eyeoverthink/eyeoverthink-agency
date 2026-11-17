// Privacy Membrane: lets private work use cloud capacity without the cloud seeing the private parts.
//
//   seal    : detect sensitive spans (deterministic detectors + owner terms + optional LOCAL-model NER) and replace
//             each with a typed placeholder (⟦EMAIL_1⟧). The same value always maps to the same placeholder.
//   audit   : before anything leaves the machine, check that no original value (or a digit-normalized form of it)
//             survives in the outbound payload. A leak throws, and the caller must not send.
//   unseal  : restore originals in the reply, tolerating the ways models mangle placeholders.
//   crossing: every sealed egress is ledgered with counts per type and keyed hashes (HMAC) of the values,
//             never the values themselves, so the record proves what was withheld without revealing it.
import crypto from 'node:crypto';

const OPEN = '⟦', CLOSE = '⟧';

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Deterministic detectors. Each returns spans { start, end, type, value }. Order = priority on overlap ties. */
const DETECTORS = [
  ['SECRET', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['SECRET', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b/g],
  ['SECRET', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g], // JWT
  ['SECRET', /(?<=\b(?:password|passwd|passcode|pin|secret|api[_-]?key|token)\s*(?:is|[:=])\s*["']?)[^\s"',;]{4,}/gi],
  ['URL', /\bhttps?:\/\/[^\s<>"')]+[?&](?:token|key|sig|signature|auth|access_token|password)=[^\s<>"')]+/gi],
  ['EMAIL', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['IBAN', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g],
  ['CARD', /\b(?:\d[ -]?){12,18}\d\b/g],
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['PHONE', /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\b\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/g],
  ['IP', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
];

const VALIDATE = {
  CARD: (v) => { const d = v.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); },
  PHONE: (v) => { const d = v.replace(/\D/g, ''); return d.length >= 10 && d.length <= 15; },
  IBAN: (v) => v.replace(/\s/g, '').length >= 15,
};

/** Find sensitive spans with deterministic detectors and owner-defined terms. Overlaps keep the longer span. */
export function detect(text, { terms = [] } = {}) {
  const s = String(text ?? '');
  const spans = [];
  for (const [type, re] of DETECTORS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      // Trim sentence punctuation a greedy pattern can swallow ("Tr0ub4dor&3." -> "Tr0ub4dor&3").
      let value = m[0].trim();
      if (type === 'SECRET' || type === 'URL' || type === 'EMAIL') value = value.replace(/[.,;:!?)]+$/, '');
      if (!value || (VALIDATE[type] && !VALIDATE[type](value))) continue;
      const start = m.index + m[0].indexOf(value);
      spans.push({ start, end: start + value.length, type, value });
    }
  }
  for (const term of terms) {
    const t = String(term || '').trim();
    if (t.length < 2) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of s.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, type: 'TERM', value: m[0] });
  }
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  for (const sp of spans) {
    const last = out.at(-1);
    if (last && sp.start < last.end) {
      if (sp.end - sp.start > last.end - last.start) out[out.length - 1] = sp;
      continue;
    }
    out.push(sp);
  }
  return out;
}

const digitsOnly = (v) => v.replace(/\D/g, '');
// Join digit groups split by spaces, dots or dashes so "4111 1111" and "4111-1111" compare equal.
const squeezeDigits = (s) => s.replace(/(?<=\d)[\s.\-()]+(?=\d)/g, '');

/** A session holds the value <-> placeholder map for one crossing. It never leaves this process. */
export class SealSession {
  constructor() { this.byValue = new Map(); this.byPlaceholder = new Map(); this.counts = {}; }

  placeholder(type, value) {
    const key = value.toLowerCase();
    if (this.byValue.has(key)) return this.byValue.get(key);
    this.counts[type] = (this.counts[type] || 0) + 1;
    const ph = `${OPEN}${type}_${this.counts[type]}${CLOSE}`;
    this.byValue.set(key, ph);
    this.byPlaceholder.set(ph, { type, value });
    return ph;
  }

  /** Replace spans (from detect) in text with placeholders. */
  apply(text, spans) {
    let out = '', i = 0;
    for (const sp of spans) { out += text.slice(i, sp.start) + this.placeholder(sp.type, sp.value); i = sp.end; }
    return out + text.slice(i);
  }

  get size() { return this.byPlaceholder.size; }
  values() { return [...this.byPlaceholder.values()]; }

  /** Restore originals. Models sometimes drop the brackets or swap them for [ ] « » < >, so all are accepted. */
  unseal(text, { json = false } = {}) {
    let s = String(text ?? '');
    for (const [ph, { type, value }] of this.byPlaceholder) {
      const n = ph.slice(OPEN.length + type.length + 1, -CLOSE.length);
      // Brackets are optional and consumed only when directly adjacent, so surrounding spaces survive.
      const re = new RegExp(`(?:${OPEN}|\\[\\[?|«|<)?\\b${type}_${n}\\b(?:${CLOSE}|\\]\\]?|»|>)?`, 'g');
      const rep = json ? JSON.stringify(value).slice(1, -1) : value;
      s = s.replace(re, () => rep);
    }
    return s;
  }

  /** Hard egress check: no original value may appear in what is about to leave the machine. */
  audit(payload) {
    const p = String(payload ?? '');
    const lower = p.toLowerCase();
    const squeezed = squeezeDigits(p);
    const leaks = [];
    for (const { type, value } of this.values()) {
      if (lower.includes(value.toLowerCase())) { leaks.push(type); continue; }
      const d = digitsOnly(value);
      // Digit-heavy values also leak without separators or without a country code (compare the last 10 digits).
      if (d.length >= 7 && (squeezed.includes(d) || (d.length > 10 && squeezed.includes(d.slice(-10))))) leaks.push(type);
    }
    return { clean: leaks.length === 0, leaks };
  }
}

export class MembraneLeak extends Error {
  constructor(leaks, message = null) { super(message || `membrane blocked egress: ${leaks.length} sensitive value(s) would have left the machine (${[...new Set(leaks)].join(', ')})`); this.leaks = leaks; }
}

export const MEMBRANE_NOTE = `Some values in this conversation were replaced by placeholders such as ${OPEN}EMAIL_1${CLOSE} or ${OPEN}PERSON_2${CLOSE} to protect privacy. Treat each placeholder as the real value it stands for, keep placeholders EXACTLY as written (same brackets, type and number) wherever the value belongs in your answer, and never try to guess what they hide.`;

export class Membrane {
  /**
   * store: for the HMAC key and owner terms. ner: optional async (text) => [{ text, type }] that MUST run locally
   * (the agency passes a router call pinned to privacy 'private'). ledger: crossing records.
   */
  constructor({ store = null, ledger = null, bus = null, ner = null } = {}) {
    Object.assign(this, { store, ledger, bus, ner });
    let key = store?.kvGet('membrane:hmac');
    if (!key) { key = crypto.randomBytes(32).toString('hex'); store?.kvSet('membrane:hmac', key); }
    this.key = key;
  }

  terms() { return this.store?.kvGet('membrane:terms', []) || []; }
  setTerms(list) {
    const clean = [...new Set((list || []).map((t) => String(t).trim()).filter((t) => t.length >= 2))].slice(0, 500);
    this.store?.kvSet('membrane:terms', clean);
    this.ledger?.append('membrane.terms', { count: clean.length }, 'operator');
    return clean;
  }

  /** Keyed tag of a value: lets the ledger show "the same email was withheld again" without revealing it. */
  tag(value) { return crypto.createHmac('sha256', this.key).update(String(value).toLowerCase()).digest('hex').slice(0, 16); }

  /** All spans for a text: deterministic + owner terms + (optional) local NER, NER names verified to occur in the text. */
  async spans(text, { useNer = true, status = null } = {}) {
    const base = detect(text, { terms: this.terms() });
    if (!useNer || !this.ner) { if (status && !this.ner) status.ner = 'off'; return base; }
    let found = [];
    // A failed name finder must never look like "no names found": record it so the caller can refuse to cross.
    try { found = (await this.ner(text)) || []; if (status && status.ner !== 'unavailable') status.ner = 'ok'; } catch (e) { found = []; if (status) { status.ner = 'unavailable'; status.nerError = String(e?.message || e).slice(0, 160); } }
    const extra = [];
    for (const e of found) {
      const v = String(e?.text || '').trim();
      const type = String(e?.type || 'NAME').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12) || 'NAME';
      if (v.length < 2 || v.length > 120) continue;
      let from = 0, idx;
      // Only spans that literally occur: the model cannot invent what to hide.
      while ((idx = text.indexOf(v, from)) !== -1) { extra.push({ start: idx, end: idx + v.length, type, value: v }); from = idx + v.length; }
    }
    const all = [...base, ...extra].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const out = [];
    for (const sp of all) {
      const last = out.at(-1);
      if (last && sp.start < last.end) { if (sp.end - sp.start > last.end - last.start) out[out.length - 1] = sp; continue; }
      out.push(sp);
    }
    return out;
  }

  /** Seal a chat message list. Returns { messages, session, payload } where payload is exactly what would be sent. */
  /**
   * strict (default): refuse to produce an outbound payload if the configured local name finder could not run,
   * because then names would cross unprotected. Previews pass strict: false and show the status instead.
   */
  async sealMessages(messages, { useNer = true, strict = true } = {}) {
    const session = new SealSession();
    const status = { ner: useNer && this.ner ? 'pending' : 'off' };
    const out = [];
    for (const m of messages) {
      const text = String(m.content ?? '');
      const spans = await this.spans(text, { useNer: useNer && m.role !== 'system', status });
      out.push({ ...m, content: session.apply(text, spans) });
    }
    if (session.size) out.unshift({ role: 'system', content: MEMBRANE_NOTE });
    // A second pass over the sealed text catches values that only appear in another message (consistency).
    for (const m of out) m.content = this.#reapply(m.content, session);
    const payload = JSON.stringify(out);
    const audit = session.audit(payload);
    if (!audit.clean) throw new MembraneLeak(audit.leaks);
    if (status.ner === 'pending') status.ner = 'ok';
    if (strict && status.ner === 'unavailable') throw new MembraneLeak(['NAMES_UNCHECKED'], `membrane refused to seal: the local name finder is unavailable (${status.nerError}), so names could cross unprotected`);
    return { messages: out, session, payload, ner: status.ner };
  }

  #reapply(text, session) {
    let s = text;
    for (const { type, value } of session.values()) {
      if (value.length < 3) continue;
      const ph = session.placeholder(type, value);
      s = s.split(value).join(ph);
    }
    return s;
  }

  /** Ledger the crossing: what kind of provider, how many values of each type were withheld, keyed tags. */
  record({ session, payload, provider, model, origin, missionId = null, ok = true, error = null }) {
    const entry = {
      origin, provider, model, ok, ...(missionId ? { missionId } : {}), ...(error ? { error: String(error).slice(0, 200) } : {}),
      withheld: { ...session.counts }, total: session.size,
      tags: session.values().map((v) => ({ type: v.type, tag: this.tag(v.value) })),
      outboundSha256: crypto.createHash('sha256').update(payload).digest('hex'),
      audit: 'clean',
    };
    this.bus?.publish('membrane.crossing', { provider, model, total: entry.total, withheld: entry.withheld, ok });
    return this.ledger ? this.ledger.append('membrane.crossing', entry, 'membrane') : entry;
  }
}
