# Phase 24 — Adversarial Audit Hardening & RFC 6962 / RFC 8785 Cryptography

[Previous: Phase 20](PHASE-20.md) | [Phase Index](README.md) | [Next: Phase 25](PHASE-25.md)

## Problem

An independent adversarial audit of `phase-20-program-judge` (`docs/review/AUDIT.md`, PR #2) surfaced **5 Critical** security/privacy vulnerabilities and several High/Medium gaps that had to be closed before inviting public red-team challenges:
- **C1:** `runSandboxedJs` ran `node --permission`, which blocks FS/child-process/worker access but **not** network APIs (`fetch`, `WebSocket`, `http`, `net`, `dns`, `process.getBuiltinModule`), allowing a malicious skill plasmid or `code_run` call to exfiltrate private data.
- **C2:** `openPlasmid(plasmid, verify)` skipped signature checks when `plasmid.sig` was omitted/null, and `Continuity.restore` interpolated `Object.keys(ag)` directly into SQL `INSERT`.
- **C3:** `verifyReceipt` did not enforce `receipt.entries.length === statement.entries`, unique `seq` values, exact Merkle proof depth/parity, or malformed-input guards; the Merkle tree also used odd-leaf duplication (vulnerable to CVE-2012-2459) without RFC 6962 `0x00`/`0x01` domain separation.
- **C4:** `serveStatic` used `!file.startsWith(base)` without trailing `path.sep` (sibling-prefix traversal) and threw uncaught `URIError` (HTTP 500) on malformed percent-encoding.
- **C5:** Default `httpAllowlist` included `localhost` and `127.0.0.1` (bypassing SSRF checks), and `isPrivateIp` missed `::` and IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
- **H4 / H5 / H6 / H9 / M1:** Sentinel zero-width injection bypass (`< 3` chars), unreachable `GET /api/agents/pick` route shadowing, `Ledger.append` calling `bus.emit` instead of `bus.publish` (dropping SSE events), workspace symlink escape in `resolveInWorkspace`, and unpinned `r.signer` in `Ledger.verify()`.

## Design

- **C1 (`src/tools/builtin.js`):** Prepended an immutable, non-configurable sandbox lockdown inside the `--permission` child process blocking `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `Module._load`, ESM `Module.registerHooks`, `process.getBuiltinModule`, `process.binding`, `process._linkedBinding`, and `process.dlopen` for all network and privileged modules; attached `error` handlers on `child` and `child.stdin` (no unhandled `EPIPE`).
- **C2 (`src/core/dna.js`, `src/continuity/continuity.js`):** `openPlasmid` fails closed whenever `verify` is provided and `sig`/`signer` is missing, uses a null-prototype `parts` map, and rejects prototype-pollution names; `Continuity.restore` allowlists exact `agents` table columns.
- **C3 + RFC 6962 + RFC 8785 (`src/core/util.js`, `src/core/ledger.js`, `src/core/receipt.js`, `src/core/receipt-verify.js`):** Upgraded `canonical()` for full RFC 8785 JCS edge cases (`-0 → 0`, non-finite → `null`, `Date.toJSON()`); implemented RFC 6962 `0x00` leaf / `0x01` internal node hashing with lone odd-node promotion (no CVE-2012-2459 collision); upgraded `issueReceipt` to `version: 2` (`merkle: "rfc6962-sha256"`) while preserving v1 backward verification; enforced `entries.length === st.entries`, unique in-range `seq`, exact `expectedMerkleSteps(seq, size)`, and early malformed-input returns.
- **C4 + H5 (`src/server/server.js`):** Extracted `resolveStaticFile` with `try/catch` URI decoding (HTTP 400), null-byte rejection, and `base + path.sep` prefix check; registered `GET /api/agents/pick` before `GET /api/agents/:id`.
- **C5 + H9 (`src/core/config.js`, `src/tools/builtin.js`):** Removed `localhost`/`127.0.0.1` from default `httpAllowlist` (opt-in `allowLoopback: false`); expanded `isPrivateIp` to parse full 8-group IPv6, IPv4-mapped IPv6 (dotted-quad and hex), NAT64, `::`, and multicast; hardened `resolveInWorkspace` with `lstatSync` + `realpathSync` ancestor walks.
- **H4 + H6 + M1 (`src/guard/sentinel.js`, `src/core/ledger.js`):** `scanInjection` evaluates patterns on both raw and `stripHidden()` text (flagging `hidden-unicode-evasion` even on 1–2 chars); `Ledger.append` calls `bus.publish('ledger', full)`; `Ledger.verify()` pins `r.signer` to the agency's own keyring public key.

## Measured Results

See [evidence-phase24-hardening.json](evidence-phase24-hardening.json):
- **13/13** sandbox network/module/prototype-tampering escape probes blocked (`fetch`, `WebSocket`, `require('http')`, `require('node:net')`, `require('dns/promises')`, `process.getBuiltinModule`, `process.binding`, `import('node:https')`, `Set.prototype.has = () => false`, `String.prototype.replace = () => ""`, legacy `_http_client`, legacy `_tls_wrap`, and `Function.prototype.call` override) using a strict pure-compute allowlist with bound exotic primordials, while pure computation passes cleanly.
- **23/23** private/IPv4-mapped IPv6/IPv4-translated/NAT64/6to4/site-local/loopback SSRF vectors blocked; **5/5** public IPs allowed.
- **5/5** receipt completeness/uniqueness/Merkle/malformed-input attacks blocked; CVE-2012-2459 3-leaf vs 4-leaf duplicated-root collision eliminated; v1 Merkle downgrade root-as-leaf forgery rejected by default.
- Dangling symlink workspace escape (`lstatSync`), BOM/nested `</untrusted>` breakout, and `Continuity.restore` SQL-column injection all blocked.
- Full test suite: **164/164** passing (`npm test`, 6 new security regression suites in `test/hardening.test.js`).

## Known Limits

- Node's JS-level sandbox lockdown runs inside `--permission` without OS network namespaces (`unshare -n` on Linux / Job Objects on Windows); an attacker with a zero-day V8 engine bug could theoretically bypass JS-level hooks. OS-level container/network-namespace isolation remains recommended for hostile multi-tenant workloads.
- Remaining non-critical High/Medium findings in `docs/review/AUDIT.md` (e.g., `Dreamer.cycle` privacy tagging H1, `Bench.run` isolation H19) are tracked separately.
