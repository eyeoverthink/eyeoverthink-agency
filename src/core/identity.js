// Ed25519 sovereign identity: one keypair for the agency and one per agent.
// Private keys live only in AGENCY_HOME/keys (mode 0600) and never leave the machine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256 } from './util.js';

export class Identity {
  constructor(id, publicKey, privateKey = null) {
    this.id = id;
    this.publicKey = publicKey; // KeyObject
    this.privateKey = privateKey; // KeyObject | null
    this.publicHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
    this.fingerprint = sha256(Buffer.from(this.publicHex, 'hex')).slice(0, 16);
  }

  /** Sign any JSON-able value (canonicalized) or a Buffer/string. Returns hex signature. */
  sign(payload) {
    if (!this.privateKey) throw new Error(`Identity ${this.id} has no private key`);
    return crypto.sign(null, toBytes(payload), this.privateKey).toString('hex');
  }

  verify(payload, sigHex) {
    return verifyWith(this.publicHex, payload, sigHex);
  }

  toPublic() { return { id: this.id, publicKey: this.publicHex, fingerprint: this.fingerprint }; }
}

function toBytes(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  return Buffer.from(canonical(payload), 'utf8');
}

export function publicKeyFromHex(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('Ed25519 public key must be 64 hex chars');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') }, format: 'jwk' });
}

export function verifyWith(publicHex, payload, sigHex) {
  try {
    if (!/^[0-9a-f]{128}$/i.test(sigHex || '')) return false;
    return crypto.verify(null, toBytes(payload), publicKeyFromHex(publicHex), Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

/** File-backed keyring. Keys are created on first use. */
export class Keyring {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
  }

  #file(id) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id)) throw new Error(`Invalid identity id: ${id}`);
    return path.join(this.dir, `${id}.key.json`);
  }

  has(id) { return this.cache.has(id) || fs.existsSync(this.#file(id)); }

  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const file = this.#file(id);
    let identity;
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const privateKey = crypto.createPrivateKey({ key: raw.privateJwk, format: 'jwk' });
      identity = new Identity(id, crypto.createPublicKey(privateKey), privateKey);
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      identity = new Identity(id, publicKey, privateKey);
      fs.writeFileSync(file, JSON.stringify({
        id, created: new Date().toISOString(), publicKey: identity.publicHex,
        privateJwk: privateKey.export({ format: 'jwk' }),
      }, null, 2), { mode: 0o600 });
    }
    this.cache.set(id, identity);
    return identity;
  }

  /** Signed file sidecar (<file>.sig) in the same 128-hex format the FRAYMUS dream/remembered corpus uses. */
  signFile(id, filePath) {
    const sig = this.get(id).sign(fs.readFileSync(filePath));
    fs.writeFileSync(`${filePath}.sig`, sig);
    return sig;
  }

  verifyFile(publicHex, filePath) {
    const sigPath = `${filePath}.sig`;
    if (!fs.existsSync(sigPath)) return false;
    return verifyWith(publicHex, fs.readFileSync(filePath), fs.readFileSync(sigPath, 'utf8').trim());
  }
}
