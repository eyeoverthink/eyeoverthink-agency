# Phase 26 — SVA Open Standards (`AER/1`, `VSC/1`, `EMA/1`) & Tri-Runtime Conformance

[Previous: Phase 25](PHASE-25.md) | [Phase Index](README.md)

## Problem

Internal mechanisms inside a single framework rarely become industry standards. For independent AI runtimes (Node.js agents, browser WebCrypto/WASM workers, and enterprise airgapped JVMs) to interoperate across untrusted boundaries, the wire formats must strip all proprietary encodings (no ACGT DNA wrappers, no custom hashes), rely exclusively on RFC primitives, and ship with a deterministic golden conformance suite verified by independent reference implementations.

## Design

### 1. Three Wire Specifications (`docs/specs/`)
- **[AER-1.md](../specs/AER-1.md) — Agent Execution Receipt (`aer/1`):** Ed25519 + SHA-256 + RFC 8785 JCS + RFC 6962 `0x00`/`0x01` Merkle tree with odd-node promotion + honest clock attestation (`attested | drift | unattested`) + mandatory entry completeness (`entries.length === statement.entries`) and unique `seq`.
- **[VSC-1.md](../specs/VSC-1.md) — Verifiable Skill Capsule (`vsc/1`) & Counterexample Revocation (`vsc-revoke/1`):** Plain JSON capability-free pure skill capsules (`wasm-core-1` or `js-pure-es2022`), fail-closed Ed25519 signature, WASM magic validation, and zero-rumor revocation tombstones carrying signed counterexamples.
- **[EMA-1.md](../specs/EMA-1.md) — Egress Membrane Attestation (`ema/1`):** Signed boundary crossing attestation with `outboundSha256`, keyed `HMAC-SHA256` correlation tags, digit-squeezed leak audit, and `ONLY_ON_DEVICE` airgap (`egressBytes: 0`, `networkInterfaces: 0`) attestation.

### 2. Deterministic 62-Vector Golden Conformance Suite (`conformance/v1/`)
`generate-vectors.mjs` produces `conformance/v1/vectors.json` using deterministic RFC 8032 Ed25519 seeds across 5 suites:
- `jcs` (10 vectors, including `-0`, `0.0001`, `1e-7`, `1e20`, `1e21` RFC 8785 ES6 edge cases), `merkle` (10 vectors), `aer1` (15 vectors), `vsc1` (13 vectors), `ema1` (14 vectors, including 64-bit `2^32` truncation, negative-count cancellation, and per-type tag mismatch) = **62 total vectors**.

### 3. Three Independent Zero-Dependency Reference Verifiers (`conformance/v1/runners/`)
1. **`node-verify.mjs`** — Node.js (`node:crypto`), 0 external dependencies.
2. **`webcrypto-verify.mjs`** — W3C Browser WebCrypto (`globalThis.crypto.subtle`, **0 `node:crypto` imports**).
3. **`SvaConformance.java`** — **Single-file pure Java (JDK 17–25)** with built-in RFC 8259 JSON parser, full ECMAScript/RFC 8785 JCS `formatEsNumber` serializer, 64-bit safe integer checks, native `Ed25519` / `SHA-256` / `HmacSHA256`, and 0 external dependencies (`java conformance/v1/runners/SvaConformance.java`).

## Measured Results

See [evidence-phase26-standards.json](evidence-phase26-standards.json):
- **Node.js v24.11.1 (`node:crypto`):** **62/62 PASSED**, 0 failed, **17.44 ms**
- **W3C Browser WebCrypto (`crypto.subtle`):** **62/62 PASSED**, 0 failed, **33.37 ms**
- **Java 25.0.1 LTS (`SvaConformance.java`, single-file, 0 deps):** **62/62 PASSED**, 0 failed, **243.28 ms** (includes JVM compile+run)
- Full test suite: **162/162** passing (`npm test`, including 4 new tests in `test/conformance.test.js`).

## Known Limits

- `VSC/1` conformance currently verifies wire signature, capability-free constraints, `codeSha256`, and WASM v1 binary magic header; fuel-metered WASM execution equivalence across V8 and pure Java (`FraynixGPT.java` WASM VM) is the natural Phase 27 follow-up.
- RFC 8785 JCS number serialization in `SvaConformance.java` covers standard integers and IEEE-754 decimals used in SVA payloads; extreme scientific-notation edge cases (e.g. `1e+21`) should be tested against the full RFC 8785 Appendix B corpus before freezing v1.0 final.
