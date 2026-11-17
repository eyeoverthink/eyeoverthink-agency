# Phase 6: Hardened evolution

Previous: [Phase 5](PHASE-5.md) · Next: [Phase 7](PHASE-7.md) · [Index](README.md)

## Summary
Phase 4 showed that evolution could be fooled by run-to-run noise. Phase 6 makes the promotion decision statistically sound, measures the noise floor directly, gives Helix items that can tell genomes apart, and makes long jobs survive restarts.

## What was built
1. **A winner's-curse fix in the Phase 5 guard.**
   - The sign test added in Phase 5 pooled screening cells with confirmation cells.
   - But the challenger was *selected* because it won the screening cells, so counting them again is the winner's curse.
   - The significance test now uses **fresh confirmation cells only**. A test proves that a challenger whose only wins came from screening is never promoted.
2. **Sequential confirmation** (`maxConfirmRounds`, default 3; API `maxConfirmRounds`, CLI `--confirm-rounds`):
   - each round runs both genomes on new fresh seeds (501+, never overlapping screening 1–5 or held-out 901+);
   - after each round: promote if the fresh-cell sign test reaches p ≤ `alpha / maxConfirmRounds` and the gain is at least `minGain`; stop for futility if the challenger falls behind or loses more fresh cells than it wins; otherwise continue;
   - splitting alpha across rounds (Bonferroni) keeps the overall false-promotion rate at or below `alpha` despite checking after every round;
   - a strong effect stops early (6-0 on Helix promotes after one round). Phase 4's Helix case (one fresh win) is called noise after 3 rounds;
   - every round's seeds, paired record and p-value are stored and shown in the dashboard.
3. **A/A noise calibration** (`Evolution.calibrate`; `agents calibrate <id>`; `POST /api/evolution/calibrate`; the "Measure noise floor (A/A)" button).
   - Runs the current genome **twice on identical seeds**, over every training and held-out item.
   - Any disagreement is pure noise. It reports the discordance rate with a Wilson CI, plus per-item pass rates (item difficulty).
   - The result is stored per agent and ledgered (`evolution.calibration`).
4. **Harder Helix items.** Phase 4's Helix held-out items were 100% for every genome, so they carried no signal. New items need multi-step use of the codec output: `dna-gc` and `dna-length` (training), `dna-decode-long` and `dna-gc-dna` (held-out).
5. **Persistent jobs.**
   - Jobs are written to the store at every stage change and at the end.
   - On restart, a job that was running is reported as `interrupted`, with where it stopped. Its finished generations are kept, since each generation commits atomically, so starting the agent again continues from there.
   - `GET /api/evolution/jobs` lists recent jobs.

## Measured: the noise floor (real models, RTX 3070)
Current genomes, 2 seeds per item, each cell run twice ([evidence](evidence-phase6-calibration.json)):

| Agent | Cells | Disagreed with itself | Noise rate (95% CI) | Hardest items (pass rate) |
|---|---|---|---|---|
| Tycho | 22 | 2 | **9.1%** [2.5%, 27.8%] | `de-morgan` 0/4, `sum-sevens` (held-out) 0/4, `prime-count` 2/4 |
| Lumen | 18 | 2 | **11.1%** [3.1%, 32.8%] | `csv-exact` 0/4, `extract-inject` (held-out) 2/4, `word-limit` 3/4 |
| Helix | 20 | 2 | **10.0%** [2.8%, 30.1%] | `dna-gc` 3/4, `dna-go` (held-out) 3/4 |

**About one cell in ten flips with nothing changed.**
- Any claimed improvement smaller than that is invisible. That is why promotions need sequential fresh-seed evidence.
- Items at 0/4 or 4/4 can't tell genomes apart. The useful items are the ones in between.
- Helix's new items are no longer all at the ceiling.

## Measured: hardened evolution run
Tycho and Lumen, 2 generations each, population 4, repeats 2, alpha 0.1, up to 3 confirmation rounds. *Results are added below when the run finishes.*

## Files changed
- **Source:** `src/evolve/evolution.js` (fresh-only sequential confirmation, `calibrate`, persisted jobs, calibration jobs), `src/telemetry/bench.js` (4 Helix items), `src/server/server.js` (calibrate, calibration, jobs endpoints; `maxConfirmRounds`), `src/cli/cli.js` (`agents calibrate`, `--confirm-rounds`, `preflight`).
- **Dashboard:** `web/src/main.ts` (confirmation rounds with p-values, noise-floor button and table).
- **Tests:** `test/evolution-runs.test.js`, 58 tests in total:
  - screening wins never count;
  - the Helix case is noise;
  - a real effect stops early;
  - configurable alpha and round cap;
  - calibration;
  - persistence and interruption.

## Patterns used
- Only evidence gathered *after* selection counts toward the selection.
- Group-sequential testing with an alpha split across looks.
- An A/A test to measure the noise floor before trusting A/B differences.
- Item difficulty as a selection criterion for test suites (keep items that discriminate).
- Atomic per-generation commits, so an interrupted job loses at most the generation in progress.

## Running counts
| Metric | Phase 5 | Phase 6 |
|---|---|---|
| Tests | 53 | 58 |
| Noise floor measured | no | yes: about 10% for all three agents |
| Helix items | 4 training + 2 held-out | 6 + 4 |
| Promotion evidence | pooled cells (biased) | fresh cells only, sequential, alpha split across looks |
