#!/bin/bash
# Video V8 — duration precision. ADI RUNS THIS. Claude never does, not even with --help.
#
# Pushes studio-duration-fix and opens the PR.
#
# ⚠️  THIS BRANCH CARRIES A MIGRATION (0058). Merging it applies
# `ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS duration_seconds_precise double precision`
# to the dev database via deploy-dev, and to prod on the manual deploy-prod dispatch. It is
# additive and catalog-only — no rewrite, no lock of consequence, no data movement, and the
# pre-0058 image never names the column — but it IS a schema change and the deploy-dev
# migration step is the thing to watch on CI.
set -euo pipefail

BRANCH=studio-duration-fix
BASE=main
BASE_SHA=2ab0cf5     # main at branch point (merge of PR #523)
EXPECTED_COMMITS=7   # what this script was written against (includes this helper commit)

# The tip is NOT pinned by sha, on purpose: committing this file would change the sha it pins,
# so the pin could never be right. The branch point and the commit count pin it instead — add
# or drop a commit and this refuses rather than pushing something nobody re-read.

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$WT"

here=$(git rev-parse --abbrev-ref HEAD)
[ "$here" = "$BRANCH" ] || { echo "on '$here', expected '$BRANCH'"; exit 1; }

git merge-base --is-ancestor "$BASE_SHA" HEAD || {
  echo "$BASE_SHA is not an ancestor of HEAD — not the branch this helper was written for"
  exit 1
}

tip=$(git rev-parse --short HEAD)
n=$(git rev-list --count "$BASE_SHA..HEAD")
[ "$n" = "$EXPECTED_COMMITS" ] || {
  echo "branch has $n commit(s) on $BASE_SHA; helper was written against $EXPECTED_COMMITS."
  echo "Re-read the branch before pushing — the helper is stale."
  exit 1
}

# THE MIGRATION TRIPLE MUST BE INTACT. db-migrate.sh names each file by hand — there is no glob —
# so the .sql, the step-3 list line and the schema.ts declaration have to travel together or the
# HARD drift gate reds the deploy that merged half of them. Checked here rather than trusted,
# because the failure lands on a deploy rather than on a test.
git show "$BRANCH:migrations/0058_media_assets_duration_precise.sql" >/dev/null 2>&1 || {
  echo "0058 .sql is missing from the branch"; exit 1; }
git show "$BRANCH:scripts/db-migrate.sh" | grep -q '0058_media_assets_duration_precise' || {
  echo "0058 is not in db-migrate.sh's step-3 list — the file would never be applied"; exit 1; }
git show "$BRANCH:shared/schema.ts" | grep -q 'duration_seconds_precise' || {
  echo "duration_seconds_precise is not declared in schema.ts — the drift gate would red"; exit 1; }

# Uncommitted work, scoped to what this branch actually touches.
#
# Same guard, and the same reason, as tools/v1/push-video-v1.sh: a blanket check hard-fails on
# server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip, which CANNOT be cleaned.
# .gitattributes carries `server/scripts/calibration/runs/** text eol=lf`, that glob catches a
# binary .zip, so git applies CRLF→LF on the clean filter and the archive reads 251877 bytes
# against a stored 251881. Any fresh checkout is born with it dirty. Not ours, not fixable here.
#
# So the guard asks the question it meant to ask: is there uncommitted work in a file THIS BRANCH
# EDITS? Intersected by name rather than by passing the list back as pathspecs — a filename with a
# space would word-split into two bogus pathspecs and the guard would silently check nothing.
touched=$(git diff --name-only "$BASE_SHA..HEAD")
dirty=$(git status --porcelain -- server shared docs client tools migrations scripts | awk '{ $1=""; sub(/^ /,""); print }')

dirty_mine=$(printf '%s\n' "$dirty" | grep -Fxf <(printf '%s\n' "$touched") || true)
[ -z "$dirty_mine" ] || {
  echo "uncommitted changes in files this branch edits — commit or set aside first:"
  printf '%s\n' "$dirty_mine"
  exit 1
}

dirty_other=$(printf '%s\n' "$dirty" | grep -vFxf <(printf '%s\n' "$touched") || true)
[ -n "$dirty_other" ] && {
  echo "note: dirty paths OUTSIDE this branch's diff — left alone, and a push sends commits not the"
  echo "      working tree, so none of this travels:"
  printf '      %s\n' $dirty_other
  echo
}

echo "About to push $BRANCH ($tip, ${BASE_SHA}..HEAD) to origin and open a PR against $BASE."
echo "⚠️  This branch carries migration 0058 — deploy-dev will apply it to the dev database."
git log --oneline "$BASE_SHA..HEAD"
read -r -p "Proceed? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted"; exit 1; }

git push -u origin "$BRANCH"

gh pr create --base "$BASE" --head "$BRANCH" \
  --title "Studio: a video's real length, measured — migration 0058 and the three probes that fill it (video V8)" \
  --body-file "$WT/tools/dur/pr-body.md"
