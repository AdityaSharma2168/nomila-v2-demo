# Studio dev hygiene — .env, logs, keys, worktrees (PR 4, C3)

Local-machine practice for the Studio lane. Nothing here changes code or deploy config.

## 1 · `.env` — duplicate keys

`scripts/setup-dev-env.sh` rewrites `.env` atomically and copies every key it does not manage through
verbatim (`:151-173`), with **no de-duplication** — so a key hand-added twice stays twice forever.
Nothing in the repo appends to `.env`; the duplicates are hand edits. `STUDIO_ENABLED` was in it three
times on 22 Sep 2026.

**Which one is live:** dotenv 16.4.7's `parse` assigns keys in file order (`obj[key] = value`), so the
**last** occurrence wins. A dedup that keeps the last line of each key changes nothing at runtime.

List duplicated names, with how many times each appears and how many *distinct values* it has —
**names and counts only, never a value**:

```bash
cd /Users/adi/nomila-v2 && awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { n[$1]++; v[$1 SUBSEP substr($0, index($0,"=")+1)] = 1 }
  END { for (k in n) if (n[k] > 1) { d = 0; for (kv in v) { split(kv, p, SUBSEP); if (p[1] == k) d++ }
        printf "%-40s x%d  distinct values: %d\n", k, n[k], d } }' .env | sort
```

A key with `distinct values: 2+` is worth a look before the dedup: the last one is the one in use,
and the others are what someone once meant.

Write a deduplicated copy beside it (keeps the LAST occurrence of each key, every comment and blank
line), compare the NAMES, then move it into place yourself:

```bash
cd /Users/adi/nomila-v2 && awk '
  { line[NR] = $0; key[NR] = ""; if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) { key[NR] = substr($0, 1, RLENGTH-1); last[key[NR]] = NR } }
  END { for (i = 1; i <= NR; i++) if (key[i] == "" || last[key[i]] == i) print line[i] }' .env > .env.dedup \
  && diff <(cut -d= -f1 .env | sort) <(cut -d= -f1 .env.dedup | sort)
# then, when the diff shows only the extra copies going:  mv .env.dedup .env
```

Every worktree that copied `.env` (`cp /Users/adi/nomila-v2/.env <worktree>/.env`) carries the
duplicates too; re-copy after the dedup.

## 2 · The server's stdout goes to a file, every run

Planner spend is booked from the server log's `plan derived` lines (input/output tokens). A server
started without a tee leaves a run unbookable — PR 4's Lane A before-run was booked from the
terminal by hand for exactly that reason. Start it as:

```bash
cd <worktree> && DOTENV_CONFIG_PATH=/Users/adi/nomila-v2/.env npm run server:dev 2>&1 | tee probe-out/<lane>/server.log
```

`probe-out/*` is gitignored, and so is the tee. Before believing any acceptance result, grep the
log's first lines for `studio router ready` — its `revision` is the build that answered (PR 4, C1).

## 3 · Model keys — one per environment, each with its own limit

- **Dev and prod never share a key.** A dev mistake must not spend prod's credit, and two
  environments on one key cannot be capped separately (flip checklist §1b recommends a second
  OpenRouter key for prod for the same reason).
- **Every key carries a provider-side spend limit**, set in the provider's console — the app's day
  cap (`studio/pricing`, a QUOTE ceiling) never sees what a key actually bills, so the key's own
  limit is the backstop the code cannot be.
- **A local `.env` holds the dev key only.** A probe that needs more spend than a session cap is a
  request to Adi, never a key swap.
- Rotating a key is Secret Manager + a redeploy (flip checklist §3); nothing reads a key live.

## 4 · Worktrees

One worktree per unit of work, under `/Users/adi/nomila-v2-worktrees/<slug>`, on its own branch;
the server runs from the worktree being tested and nowhere else. When the unit merges, reap it:

```bash
rm -f <worktree>/probe-out/<lane>/.token                       # a token never outlives its worktree
D=$(date +%Y%m%d); mkdir -p ~/probe-archives/<slug>-$D
cp -R <worktree>/probe-out/. ~/probe-archives/<slug>-$D/      # probe outputs are evidence; keep them
git -C <worktree> status --short                               # only the calibration zip may be dirty
git -C /Users/adi/nomila-v2 worktree remove --force <worktree> && git -C /Users/adi/nomila-v2 worktree prune
```

Check before `--force`: `git -C <worktree> log --oneline origin/main..HEAD` must be empty (nothing
unpushed) and `status` must show only `server/scripts/calibration/**`. On 22 Sep 2026 there were ~120
worktrees, most of them detached `base-*` / `*-percommit` snapshots from finished builds — reaping
those is a separate tidy, done the same way.
