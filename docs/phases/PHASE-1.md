# Phase 1: Foundation

Next: [Phase 2](PHASE-2.md) · [Index](README.md)

## Summary
Consolidated the FRAYMUS ecosystem into one platform: a zero-dependency Node core, a single agent runtime, critic-verified missions with self-healing and crash resume, signed memory and ledger, DNA genomes with fitness-gated evolution, workflows, mesh, MCP, continuity exports, and a dashboard with the Firebase AI Logic edge tier.

## What was built
- **Core:** config, util, Ed25519 keyring, signed hash-chain ledger with Merkle proofs, SQLite schema (WAL, FTS5), event bus, tracer.
- **Model router:** Ollama, OpenAI-compatible and Gemini providers, edge hub, role resolution, circuit breakers, GPU gate, triage, Ollama diagnosis.
- **DNA:** 2-bit codec, Carbon X codon codec, genomes, mutation and crossover, FASTA, plasmids, organisms, hypervectors.
- **Memory:** signed tiered memory, hybrid recall, entity graph. **Guard:** Sentinel, approvals and writs. **Tools:** registry with 20 built-ins.
- **Agents:** roster of 10 core agents, manifest import, runtime harness laws, Forge.
- **Orchestration:** missions, Logic Chain, Consensus (Kuramoto).
- **Also:** workflows with deploy-as-API, Dreamer, benchmark, Evolution, Mesh, MCP server and client, Continuity, autonomy.
- **Interfaces:** HTTP API with SSE, CLI, dashboard.

## Files changed
New repository: `src/**` (31 modules), `bin/agency.js`, `web/**`, `test/**`, `README.md`, `LICENSE`, `.gitignore`, `docs/screenshots/*`.

## Patterns used
- Evidence-sealed tool results.
- Narration guard.
- Deterministic compaction.
- Signed single-use writs.
- Critic-in-the-loop with retry-with-critique.
- Checkpoint and resume.
- Fitness gating (promote only on measured improvement).
- Quarantine of untrusted content.
- Zero-dependency core.

## Running counts
| Metric | Count |
|---|---|
| Source modules | 31 |
| Tests | 27 (all passing) |
| Built-in tools | 20 |
| Core agents | 10 |
| Seeded workflows | 5 |
| Workflow node types | 12 |
| Self-test checks | 11 (ALL_CLEAR) |
| Benchmark items | 8 |
