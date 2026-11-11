# Verifying a guard bites

A test that passes is not evidence a guard works. The only evidence is removing the guard and
watching the suite go red. This is the procedure, and the failures it encodes were all paid for
once already.

## The procedure

1. **`git status` must be clean of anything you did not intend to be there.** Take no baseline
   backup until it is. A backup taken over a leftover mutation makes every subsequent measurement
   wrong, silently, and in a direction that looks like success.
2. **`cp` the file aside. Never `git stash`.** A pathspec'd stash+pop in this repo once swallowed
   an unrelated uncommitted edit and deleted an untracked file. `cp` costs one command and cannot
   do that.
3. **Mutate by hand**, with an editor, one guard at a time. Generated mutation scripts cost more
   time in quoting bugs than they ever save, and a script that half-applies leaves live mutations
   behind (see step 1).
4. **Run the suite. Record the exact red count.**
5. **`cp` back and verify** — `diff -q` against the backup, plus a `grep -c` for a sentinel string
   from the restored guard. Both, because a restore that silently no-ops looks identical to one
   that worked.

## Reading the result

**A count of 0 does not mean "the test is missing".** The first question is whether the logic is
reachable from a test AT ALL.

Measured example: the path-dispatch decision in `runStudioGeneration` read 0 red because it was an
inline ternary inside a function you cannot call without standing up a job row. It was not
untested, it was _untestable_. Extracting the decision into a pure function (`usesMaskedPath`) is
what made it assertable — and the test that mattered was the one case where the two inputs
disagree: brief shape says croppable, caller says FULL_IMAGE. Every other combination passes with
the parameter ignored.

**A comment has no test.** Do not fill in the cell. An invented number makes the whole table less
trustworthy than an honest gap.

**A test that must HOLD has to be RUN, not inferred.** When a mutation is supposed to leave certain
tests green — the ones asserting what the change must not break — execute them against the mutated
file and read the pass. Their absence from the failure list is not evidence: absence means "held"
or "never ran", and those are different facts. Measured 2026-09-09: widening `PERSON_NOUNS` had to
leave `shin guard`, `belly band` and `bust line` working, and the only way to know they did was to
run those two tests under the mutation and watch them pass. A revert check where EVERYTHING goes
red tells you the tests are coupled to the change; one where the right things go red and the
guard-against-overreach holds tells you the guard bites and is bounded.

## When the revert check comes back GREEN

**Ask whether the test COULD have failed — not whether it did.**

> What would this test have to see to fail? If the answer is "nothing I can produce by breaking the
> thing it guards", it isn't a guard.

Three instances found in one day, all the same shape — something reporting success while measuring
nothing:

- **A test that loops over the list it protects.** Shrink the list and it iterates fewer times and
  reports green. `GARMENT_NOUNS` is the only ALLOW gate for masking, so deleting an entry silently
  degrades every edit naming that garment to a rectangle — the exact defect a day was spent tracing.
  **Removing `"socks"` from it passed all 884 tests.** Eight tests iterate that constant and not one
  of them can see a deletion. The fix is a hand-written expectation beside the loop:
  `PERSON_NOUNS` and `KNOWN_BAD_NOUNS` both have one, and both caught their mutations the same day.
- **A default that swallows its own failure.** `verdict = "off"` in the composite made a segmentation
  CRASH indistinguishable from a disabled feature, so `extract_area: bad extract area` read as a
  flag problem for four runs.
- **A count that conflates two outcomes.** `found: 1` is what the background short-circuit AND an
  ordinary object entry both produce, so "detection returned the wrong shape" and "detection
  returned the right shape" logged identically.

The tell in all three: the observation had no value it could not have taken. A log field, a default
or an assertion that cannot distinguish success from failure is decoration.

## Running the suite

```bash
npm test -- server/studio --runInBand
```

- **`npx jest` bare fails.** PGlite needs `--experimental-vm-modules`, which only the npm script
  sets. The failure is `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` and it looks like a broken
  test, not a missing flag.
- **It also needs a bigger heap, and `npm test` is where that lives too.** Both flags are pinned in
  the `test` script, which is the reason to go through it rather than reaching for `npx jest` with a
  half-remembered `NODE_OPTIONS`. Invoked directly, the equivalent is:

  ```bash
  NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=8192" LOG_LEVEL=silent \
    npx jest server/studio --runInBand
  ```

  ⚠️ **AN OOM HERE READS AS A CATASTROPHIC FAILURE, WHICH IS WHY IT MATTERS TO THIS RUNBOOK.**
  Without the heap flag the scoped studio run dies at `FATAL ERROR: Reached heap limit Allocation
  failed - JavaScript heap out of memory`, exit **134** (SIGABRT), after reporting only ONE suite —
  no summary line, and a red count that is pure artefact. Measured 2026-09-09 at 40 suites / 1164
  tests; it ran clean at 39 / 1120 the same morning, so this is an edge that moves as suites are
  added. **Exit 134 with a truncated suite count is ALWAYS this and never a real failure** — which
  is exactly the way a step 4 red count sends someone chasing a guard that was fine all along.
- **Scope to the directory you touched.** There is no reason to run the whole repo for a change
  confined to one module.
- **Keep `--runInBand` for PGlite-backed suites.** It looks like the slow option and is the fast
  one. Measured back to back on `server/studio` (27 suites, 840 tests):

  |                    | wall   | user | system | CPU  |
  | ------------------ | ------ | ---- | ------ | ---- |
  | parallel (default) | 156.7s | 402s | 288s   | 439% |
  | `--runInBand`      | 83.5s  | 160s | 6.6s   | 197% |

  Serial is ~2x faster and spends 6.6s of system time against 288s. That gap is PGlite WASM
  instances contending — each db-backed suite boots its own Postgres, and `maxWorkers: "50%"` boots
  many at once. Wall-clock readings taken while a `tsc` or `prettier` run is competing for the
  machine are worthless for this comparison; measure the two back to back or not at all.
