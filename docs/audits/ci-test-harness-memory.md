# CI — the 5 GB test suite

**Owner:** Aaron
**Date:** 2026-09-16
**Scope:** The `test (server/routes)` CI job, the PGlite test harness (`server/testUtils/pgliteDb.ts`), and the batch runner (`scripts/testRunner/`).
**Status:** **Fixed, 17 Sep 2026** — see [Resolution](#resolution--17-sep-2026) at the end. The cost was not in the harness; it was ts-jest's per-process type-checker, and the fix is one compiler option. The diagnosis below is kept as written, including the parts the resolution overturns.
**Hosted version:** https://claude.ai/code/artifact/481d4b5a-e134-432b-afbf-40fd2421470d

`test (server/routes)` has failed in five of the last six CI runs. It never reports a failing test — it dies ~12 minutes in with `The runner has received a shutdown signal`, roughly 21 suites into 33. A single database-backed Jest suite consumes about 70% of a standard runner. This has been true for two months; it became visible last week.

## The measurement

Each suite run in isolation, peak resident set size of the Jest process, attributed by command line (so these are not contaminated by unrelated node processes).

| Suite | Shape | Peak RSS |
|---|---|---|
| `services/marketabilityBeta1.test.ts` | pure logic, no DB | **1,513 MB** |
| `routes/profile.test.ts` | PGlite + Express app | **4,935 MB** |
| `lib/auth.membership.test.ts` | PGlite, **no** app | **5,152 MB** |
| `server/routes#1` (16 suites) | half the batch | **8,277 MB** |
| `server/routes` (33 suites) | full batch | **10,538 MB and still climbing** |

A standard `ubuntu-latest` runner has **7,168 MB**.

**The finding:** Jest's own baseline is ~1.5 GB. Booting a WASM Postgres and creating 69 tables adds **~3.6 GB per suite**, and the repo has ~130 database-backed suites. It is not cumulative, not the Express app's module graph (the suite with no app is the most expensive), and not schema generation.

## Why it fails silently instead of loudly

`npm test` sets `--max-old-space-size=8192`. The runner has 7 GB. V8 is therefore permitted more heap than the machine physically has, so it never reaches its own ceiling and never raises a diagnosable error naming the offending suite. The host kills the process first and the runner agent dies with it, surfacing as a generic shutdown message with no attribution.

Relevant precedent: `.github/workflows/ci-checks.yml` already uses `4096` for its typecheck job, added in **#368** — *"raise tsc heap to 4096 — typecheck OOMing at ~2GB runner ceiling."* Same class of problem, seven days earlier, solved by raising a ceiling. That option has now run out of room.

## What it is NOT

Five hypotheses were tested and disproved. Recorded so the investigation doesn't repeat them.

| Hypothesis | Disproved by |
|---|---|
| Too many suites per process → split the batch | `routes#1` with **16** suites peaked **8,277 MB** — higher than the full batch's early readings |
| V8 coasting toward an 8 GB ceiling → lower the ceiling | A 4 GB ceiling died after **one** suite: `FATAL ERROR: Ineffective mark-compacts near heap limit` |
| PGlite's WASM memory sits outside the JS heap | V8 diagnosed the failure itself as a **JS heap** OOM |
| Cumulative accumulation — a teardown leak | One suite alone is **4,935 MB**; all 32 routes suites call `closeTestDb()` correctly |
| Per-suite `generateMigration` over 69 tables | Measured in isolation: **8 MB, 52 ms**. The whole pipeline including imports is 413 MB |

### ⚠️ A correlation that will mislead you

Failure rate does track the number of DB-backed suites per job:

| Area | DB-backed suites per process | Outcome |
|---|---|---|
| `server/routes` | 32 | dies every run |
| `server/voice` | 21 | died once in six — marginal |
| `server/services`, `server/skills` | ≤18 | never dies |
| `server/lib` | 4 (of 35 total suites) | never dies |

This is real correlation but **not** causation. The count affects how fast a process allocates, not what the binding constraint is. A partitioning rule built on it looks principled and fixes nothing — that was tried (a `DEFAULT_DB_SUITE_CAP` change) and discarded once `routes#1` was measured.

## How it came to be

| When | What |
|---|---|
| **8 Jul** | #72 introduces the PGlite harness — one in-process WASM Postgres per suite, schema pushed via drizzle-kit. Schema is **18 tables**. Per-suite cost is real but small. |
| **Jul–Sep** | Phase A grows the schema **18 → 69 tables**. Each suite's setup gets steadily heavier. Nothing surfaces, because most suites aren't running in CI. |
| **8 Sep** | #368 raises the typecheck heap to 4096 after it OOMs at the runner ceiling — same pressure in a different job, treated as a one-off. |
| **15 Sep** | #469 replaces three hand-enumerated lists of test paths with filesystem discovery. Anything not on those lists had **never run in CI**. `server/routes` becomes a real 33-suite batch for the first time, and starts dying. |

Nothing broke. A latent cost compounding for two months became visible the moment CI stopped under-reporting what it ran. **#469 is not the regression** — it is the change that made an existing one observable.

## Where to look

### 1. Stop paying the cost per suite
The harness rebuilds an identical database ~130 times. Sharing one PGlite instance per process and truncating tables between suites would turn *33 × 5 GB* into *1 × 5 GB* plus cheap resets. The obstacle: Jest gives each test file its own module registry **and** its own VM context, which is why the existing `ready ??=` memo in `pgliteDb.ts` never takes effect across files. Worth evaluating `globalSetup` with a shared handle, or a single external Postgres for CI.

### 2. Find out where the 3.6 GB actually goes
**Answered — see Resolution.** It was not inside PGlite at all.

This audit establishes *that* a DB-backed suite costs ~5 GB and rules out the obvious candidates, but not *what* inside PGlite holds it. A heap snapshot of one suite (`--inspect-brk`, snapshot after `initTestDb()`) would settle it — and may surface something far cheaper than the redesign above: PGlite instance sizing, the 295 DDL statements, or retained per-instance buffers.

### 3. Make failures diagnosable regardless
Independent of the fix, `--max-old-space-size` should sit **below** physical RAM so an over-budget batch fails with a JS heap error naming the suite rather than silently killing the runner. Note `4096` is demonstrably too tight today — this only becomes safe once the per-suite cost comes down, so it is a follow-up, not a first move.

### 4. The cheap escape hatch
A larger runner would make the symptom disappear without addressing the cost. A legitimate short-term trade if the redesign is expensive, but it should be a deliberate decision with a note attached, not a silent upgrade — the underlying cost keeps growing with the schema.

## Reproducing it

```bash
# One DB-backed suite in isolation — expect ~5 GB peak RSS
npm test -- --filter "lib/auth.membership.test"

# A pure suite for comparison — expect ~1.5 GB (Jest's baseline)
npm test -- --filter "services/marketabilityBeta1.test"

# The failing job, as CI runs it
npm test -- --batch "server/routes"
```

```powershell
# Sample the Jest process while any of the above runs
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*jest*' } |
  Select-Object ProcessId, @{n='MB';e={[int]($_.WorkingSetSize/1MB)}}
```

On a dev machine with more than 7 GB the batch will not die — it keeps climbing, which is itself the confirmation. Peak observed locally: **10,538 MB**.

## Already done — and explicitly not part of this

- **#476** (merged) — `studio/composite.test.ts` was failing *deterministically* on main because an assertion titled *"changes NOTHING outside"* passed an empty region list and therefore compared the whole frame, including the region deliberately edited. Scoped to the region; tolerance outside stays at zero; the ±1 feather rounding inside is now bounded per channel rather than ignored. This was initially misread as a flake — it was not. The success/failure mix on a single commit was *different workflows* (EAS Update and Deploy pass; CI checks fails).
- **#474** — unrelated feature work, merged with `test (server/routes)` red on the evidence in this audit. Its own suites pass.

## Why this matters beyond one red job

`server/routes` has been red on main for days, so **every PR inherits a red matrix** and a genuinely new failure is indistinguishable from the standing one. The cost isn't the job — it's that CI cannot currently be used as a gate.

## Resolution — 17 Sep 2026

**The 3.6 GB was not PGlite. It was ts-jest.**

`jest.config.cjs` ran ts-jest in its default mode, which builds a full TypeScript language service inside every Jest process to type-check each file it transforms. For this repo that program — the schema's import graph, with drizzle's generics over 69 tables — is the same one `tsc` needed a 4 GB heap for in #368. A pure-logic suite that never touches PGlite paid for it too: on the machine below `marketabilityBeta1` measured 4.3 GB, not 1.5. The "DB-backed suites cost more" signal was real but indirect — a DB-backed suite imports `shared/schema`, and *that* is what pulls the expensive types into the program. It also explains the 20–30 s per suite CI was spending in `beforeAll`, which `jest.config.cjs` had attributed to PGlite boot.

The fix is one compiler option. `tsconfig.jest.json` sets `isolatedModules: true`, which switches ts-jest to per-file `transpileModule`: no program, no type information, no language service. Type errors in tests are still caught — by a `tsc --noEmit -p tsconfig.jest.json` step in `ci-checks.yml` (2.9 GB peak, 16 s, zero errors across the whole repo including all 338 test files), once per run instead of once per Jest process.

Measured on one machine, same commit, cold Jest cache, peak RSS of the Jest process:

| Run | Before | After |
|---|---|---|
| `lib/auth.membership.test.ts` (PGlite, no app) | 4,462 MB / 31 s | **1,129 MB / 3 s** |
| `services/marketabilityBeta1.test.ts` (pure logic) | 4,282 MB / 21 s | **194 MB / <1 s** |
| `server/routes` — all 33 suites, one process, as CI runs it | 10,538 MB and climbing (above) | **3,810 MB / 52 s**, 440/440 pass |

What remains per DB-backed suite (~1.1 GB) is PGlite plus the `drizzle-kit/api` import — and retention: each suite's WASM memory outlives its Jest module registry, so a long-lived process still grows per file. On macOS that is ~80 MB per suite. **On the Linux runner it is 170–230 MB**, and the first CI run of the fix showed it: with ts-jest fixed but all 33 routes suites still in one process, the runner's own peak-RSS line read **6,649 MB** for `server/routes` and **6,029 MB** for `server/voice` — green, but within 500 MB of the 7,168 MB limit. It is not JS heap (the batch survives a 3 GB `--max-old-space-size`; Jest's `workerIdleMemoryLimit`, which watches `heapUsed`, never fires), so no heap flag can bound it.

The runner now bounds it structurally. A batch is still one CI job, but `scripts/run-tests.ts` runs its files in chunks of `DEFAULT_CHUNK_SIZE` (8) suites, each chunk a fresh jest process, so any one process is ~1 GB + 8 × retention no matter how large an area grows (`--chunk-size 0` restores one process per batch). Cost: one extra jest boot per chunk, ~2–4 s with a warm transform cache; the 33-suite routes batch is 5 processes and actually finishes faster (46.7 s vs 62.1 s locally). Option 1 above — one shared PGlite per process — is therefore not needed and not worth its cross-realm risk; it stays a follow-up for the day a *chunk* approaches 6 GB.

Measured on the runner itself (Linux `VmHWM`, from the runner's own peak-RSS line), the two CI runs of the fix — ts-jest transpile-only in both, one process per batch in the first, ≤8-suite chunks in the second:

| Batch | Suites | One process per batch | ≤8-suite chunks (largest chunk) |
|---|---|---|---|
| `server/routes` | 33 | 6,649 MB / 226 s | **2,851 MB / 159 s** |
| `server/voice` | 29 | 6,029 MB / 129 s | **2,616 MB / 130 s** |
| `server/services#1` | 40 | 3,719 MB / 99 s | **1,879 MB / 76 s** |
| `server/studio#1` | 40 | 2,793 MB / 121 s | **1,560 MB / 125 s** |

The whole matrix now finishes in about five minutes, gated by `npm ci`, and the largest process anywhere in it sits at 40% of the runner.

Also done, from "Where to look": `--max-old-space-size` is now **4096** in both `package.json` and `scripts/run-tests.ts` — below the 7,168 MB runner, so an over-budget batch fails as a V8 heap error under the last `PASS` line instead of as a runner shutdown (option 3). No larger runner (option 4).

Disproved along the way, for the record: Node's `vm` compilation-cache leak — `--no-compilation-cache` changed nothing (4,340 MB).

---

*Figures above the Resolution are peak RSS of the Jest process, sampled at 3–10s intervals, measured 15–16 Sep 2026 against `nomila-v2` at `40e6b20`.*
*Resolution figures: peak RSS via `ru_maxrss` / a 500 ms process-tree sampler, 17 Sep 2026, against `7d12dbc` (main at #499).*
