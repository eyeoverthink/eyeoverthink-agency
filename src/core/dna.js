// Carbon-X DNA layer.
//   nucleotide : 2 bits, MSB first, A=00 C=01 G=10 T=11 (byte-compatible with FRAYMUS .dna files)
//   codon      : 3 nucleotides = 6 bits (64 codons)
//   gene       : START codon (ATG) is implicit; each trait gene = 2 codons = 12 bits (4096 levels)
//   genome     : "ATG" + ordered trait genes + "TAA" — decodes to an agent's behavioral traits
//   plasmid    : a signed, DNA-encoded bundle of named payloads (each with its own sha256)
//   organism   : an agent's manifest + genome + playbook carried as a plasmid between agencies
import crypto from 'node:crypto';
import { sha256 } from './util.js';

const BASES = ['A', 'C', 'G', 'T'];
const BASE_VAL = { A: 0, C: 1, G: 2, T: 3 };
export const START = 'ATG';
export const STOP = 'TAA';

export function encodeDna(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  let out = '';
  for (const b of bytes) out += BASES[(b >> 6) & 3] + BASES[(b >> 4) & 3] + BASES[(b >> 2) & 3] + BASES[b & 3];
  return out;
}

export function decodeDna(strand) {
  const s = String(strand).replace(/[^ACGT]/g, '');
  if (s.length % 4 !== 0) throw new Error(`DNA strand length ${s.length} is not a multiple of 4`);
  const out = Buffer.alloc(s.length / 4);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = (BASE_VAL[s[j]] << 6) | (BASE_VAL[s[j + 1]] << 4) | (BASE_VAL[s[j + 2]] << 2) | BASE_VAL[s[j + 3]];
  }
  return out;
}

export function gcContent(strand) {
  const s = String(strand);
  if (!s.length) return 0;
  let gc = 0;
  for (const c of s) if (c === 'G' || c === 'C') gc++;
  return gc / s.length;
}

export const codonToInt = (codon) => (BASE_VAL[codon[0]] << 4) | (BASE_VAL[codon[1]] << 2) | BASE_VAL[codon[2]];
export const intToCodon = (n) => BASES[(n >> 4) & 3] + BASES[(n >> 2) & 3] + BASES[n & 3];

// ---- Carbon X codon codec (byte-compatible with chandra-fraymus encoding/codon.js) ----
// Sense codons: all 64 triplets in ACGT lexicographic order minus stops (TAA TAG TGA) and START (ATG).
export const SENSE_CODONS = (() => {
  const out = [];
  for (const a of BASES) for (const b of BASES) for (const c of BASES) {
    const t = a + b + c;
    if (!['TAA', 'TAG', 'TGA', 'ATG'].includes(t)) out.push(t);
  }
  return out;
})();
const SENSE_INDEX = new Map(SENSE_CODONS.slice(0, 16).map((c, i) => [c, i]));

function fnv1a32(buf) {
  let h = 0x811c9dc5;
  for (const b of buf) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Frame: ATG | len(4B BE) | data | FNV-1a32(data) (4B) | TAA, each byte as two nibble codons. */
export function encodeCodon(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const frame = Buffer.alloc(4 + data.length + 4);
  frame.writeUInt32BE(data.length, 0);
  data.copy(frame, 4);
  frame.writeUInt32BE(fnv1a32(data), 4 + data.length);
  let s = START;
  for (const b of frame) s += SENSE_CODONS[(b >> 4) & 0xf] + SENSE_CODONS[b & 0xf];
  return s + STOP;
}

export function decodeCodon(strand) {
  const s = String(strand).replace(/[^ACGT]/g, '');
  const start = s.indexOf(START);
  if (start < 0) throw new Error('codon strand has no ATG start');
  const body = s.slice(start + 3);
  const bytes = [];
  for (let i = 0; i + 6 <= body.length; i += 6) {
    const hi = SENSE_INDEX.get(body.slice(i, i + 3));
    const lo = SENSE_INDEX.get(body.slice(i + 3, i + 6));
    if (hi === undefined || lo === undefined) break; // reached TAA or foreign codon
    bytes.push((hi << 4) | lo);
  }
  const frame = Buffer.from(bytes);
  if (frame.length < 8) throw new Error('codon frame too short');
  const len = frame.readUInt32BE(0);
  if (frame.length < 8 + len) throw new Error('codon frame truncated');
  const data = frame.subarray(4, 4 + len);
  if (frame.readUInt32BE(4 + len) !== fnv1a32(data)) throw new Error('codon checksum mismatch');
  return Buffer.from(data);
}

/** Ordered trait genes. Each maps 12 bits onto [min, max] (or onto an enum). */
export const GENE_SPEC = [
  { key: 'temperature', min: 0.05, max: 1.3 },
  { key: 'topP', min: 0.5, max: 1.0 },
  { key: 'maxSteps', min: 2, max: 14, int: true },
  { key: 'reflection', min: 0, max: 3, int: true }, // self-critique rounds before answering
  { key: 'criticStrictness', min: 0.4, max: 0.9 },
  { key: 'exploration', min: 0, max: 1 }, // tool-use breadth vs answering directly
  { key: 'verbosity', min: 0, max: 1 },
  { key: 'memoryDepth', min: 2, max: 12, int: true }, // recalled memories injected per step
  { key: 'curiosity', min: 0, max: 1 },
  { key: 'caution', min: 0, max: 1 },
  { key: 'rigor', min: 0, max: 1 },
  { key: 'creativity', min: 0, max: 1 },
];
const GENE_LEN = 6; // nucleotides per gene (2 codons)

function quantize(spec, value) {
  const v = Math.min(spec.max, Math.max(spec.min, Number(value)));
  return Math.round(((v - spec.min) / (spec.max - spec.min)) * 4095);
}
function dequantize(spec, q) {
  const v = spec.min + (q / 4095) * (spec.max - spec.min);
  return spec.int ? Math.round(v) : Math.round(v * 1000) / 1000;
}

export const DEFAULT_TRAITS = Object.freeze({
  temperature: 0.4, topP: 0.9, maxSteps: 6, reflection: 1, criticStrictness: 0.6, exploration: 0.5,
  verbosity: 0.4, memoryDepth: 5, curiosity: 0.5, caution: 0.5, rigor: 0.6, creativity: 0.4,
});

export function traitsToGenome(traits = {}) {
  let g = START;
  for (const spec of GENE_SPEC) {
    const q = quantize(spec, traits[spec.key] ?? DEFAULT_TRAITS[spec.key]);
    g += intToCodon(q >> 6) + intToCodon(q & 63);
  }
  return g + STOP;
}

export function genomeToTraits(genome) {
  const g = String(genome);
  if (!g.startsWith(START) || !g.endsWith(STOP)) throw new Error('Genome must start with ATG and end with TAA');
  const body = g.slice(3, -3);
  if (body.length !== GENE_SPEC.length * GENE_LEN) throw new Error(`Genome body length ${body.length} != ${GENE_SPEC.length * GENE_LEN}`);
  const traits = {};
  GENE_SPEC.forEach((spec, i) => {
    const gene = body.slice(i * GENE_LEN, (i + 1) * GENE_LEN);
    traits[spec.key] = dequantize(spec, (codonToInt(gene.slice(0, 3)) << 6) | codonToInt(gene.slice(3, 6)));
  });
  return traits;
}

export function validateGenome(genome) {
  try { genomeToTraits(genome); return /^[ACGT]+$/.test(genome); } catch { return false; }
}

/** Point mutation: each body nucleotide flips to a random different base with probability `rate`. */
export function mutate(genome, rate = 0.03, rng = Math.random) {
  const body = genome.slice(3, -3).split('');
  let changes = 0;
  for (let i = 0; i < body.length; i++) {
    if (rng() < rate) {
      const choices = BASES.filter((b) => b !== body[i]);
      body[i] = choices[Math.floor(rng() * choices.length)];
      changes++;
    }
  }
  return { genome: START + body.join('') + STOP, changes };
}

/** Uniform gene-level crossover (genes are swapped whole, so traits stay coherent). */
export function crossover(a, b, rng = Math.random) {
  const ba = a.slice(3, -3), bb = b.slice(3, -3);
  let child = '';
  for (let i = 0; i < GENE_SPEC.length; i++) {
    const src = rng() < 0.5 ? ba : bb;
    child += src.slice(i * GENE_LEN, (i + 1) * GENE_LEN);
  }
  return START + child + STOP;
}

/** Hamming distance between genome bodies, normalized to [0,1]. */
export function geneticDistance(a, b) {
  const x = a.slice(3, -3), y = b.slice(3, -3);
  const n = Math.min(x.length, y.length);
  let d = Math.abs(x.length - y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) d++;
  return d / Math.max(x.length, y.length, 1);
}

export function toFasta(id, strand, meta = {}) {
  const header = `>${id}` + Object.entries(meta).map(([k, v]) => ` ${k}=${v}`).join('');
  const lines = String(strand).match(/.{1,60}/g) || [];
  return [header, ...lines].join('\n') + '\n';
}

export function fromFasta(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (!lines[0]?.startsWith('>')) throw new Error('FASTA must start with a > header line');
  const [id, ...metaParts] = lines[0].slice(1).trim().split(/\s+/);
  const meta = Object.fromEntries(metaParts.map((p) => p.split('=')).filter((p) => p.length === 2));
  return { id, meta, strand: lines.slice(1).join('').replace(/\s/g, '') };
}

/**
 * Plasmid: a self-verifying DNA bundle. Payload text format before encoding:
 *   FRAYPLASMID|v2|<label>|<created>\n
 *   >>>PART <name> bytes=<n> sha256=<hex>\n<base64>\n   (repeated)
 * The strand's sha256 is signed by the issuing identity.
 */
export function buildPlasmid(label, parts, identity) {
  let payload = `FRAYPLASMID|v2|${String(label).replace(/[|\n]/g, ' ')}|${new Date().toISOString()}\n`;
  for (const [name, content] of Object.entries(parts)) {
    if (!/^[\w.\-/]{1,120}$/.test(name) || name.includes('..')) throw new Error(`Invalid plasmid part name: ${name}`);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    payload += `>>>PART ${name} bytes=${buf.length} sha256=${sha256(buf)}\n${buf.toString('base64')}\n`;
  }
  const strand = encodeDna(payload);
  const strandSha = sha256(strand);
  return {
    format: 'fraymus-plasmid/2', label, strand, strandSha,
    signer: identity?.publicHex ?? null, sig: identity ? identity.sign(strandSha) : null,
    gc: Math.round(gcContent(strand) * 1000) / 1000,
  };
}

/** Decode and verify a plasmid. Throws on any integrity failure. Returns { label, parts: {name: Buffer} }. */
export function openPlasmid(plasmid, verify) {
  if (!plasmid || typeof plasmid !== 'object' || typeof plasmid.strand !== 'string') throw new Error('Malformed plasmid');
  if (sha256(plasmid.strand) !== plasmid.strandSha) throw new Error('Plasmid strand hash mismatch');
  if (verify) {
    if (!plasmid.sig || !plasmid.signer) throw new Error('Plasmid missing required signature or signer');
    if (!verify(plasmid.signer, plasmid.strandSha, plasmid.sig)) throw new Error('Plasmid signature invalid');
  }
  const text = decodeDna(plasmid.strand).toString('utf8');
  const lines = text.split('\n');
  const head = lines[0].split('|');
  if (head[0] !== 'FRAYPLASMID') throw new Error('Not a plasmid payload');
  const parts = Object.create(null);
  const FORBIDDEN_PARTS = new Set(['__proto__', 'constructor', 'prototype']);
  for (let i = 1; i < lines.length - 1; i += 2) {
    const m = lines[i].match(/^>>>PART (\S+) bytes=(\d+) sha256=([0-9a-f]{64})$/);
    if (!m) throw new Error(`Malformed plasmid part header at line ${i + 1}`);
    const partName = m[1];
    if (!/^[\w.\-/]{1,120}$/.test(partName) || partName.includes('..') || FORBIDDEN_PARTS.has(partName)) {
      throw new Error(`Invalid plasmid part name: ${partName}`);
    }
    const buf = Buffer.from(lines[i + 1], 'base64');
    if (buf.length !== Number(m[2]) || sha256(buf) !== m[3]) throw new Error(`Plasmid part ${partName} failed integrity check`);
    parts[partName] = buf;
  }
  return { label: head[2], created: head[3], parts };
}

/** 2048-bit DNA hypervector fingerprint for fast similarity between artifacts (SimHash over 4-mers). */
export function dnaHypervector(strand, bits = 2048) {
  const acc = new Int32Array(bits);
  const s = String(strand);
  for (let i = 0; i + 4 <= s.length; i++) {
    const h = crypto.createHash('sha1').update(s.slice(i, i + 4) + ':' + (i % 97)).digest();
    for (let k = 0; k < 4; k++) {
      const idx = h.readUInt16LE(k * 2) % bits;
      acc[idx] += (h[8 + k] & 1) ? 1 : -1;
    }
  }
  const out = Buffer.alloc(bits / 8);
  for (let i = 0; i < bits; i++) if (acc[i] > 0) out[i >> 3] |= 1 << (i & 7);
  return out.toString('hex');
}

export function hypervectorSimilarity(hexA, hexB) {
  const a = Buffer.from(hexA, 'hex'), b = Buffer.from(hexB, 'hex');
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    let x = ~(a[i] ^ b[i]) & 0xff;
    while (x) { same += x & 1; x >>= 1; }
  }
  return same / (a.length * 8);
}
