#!/bin/bash
# Video V9 — shot routing, the prompt library, the clip QA instrument and the runner stage.
# ADI RUNS THIS. Claude never does, not even with --help.
#
# Pushes studio-video-v9 and opens the PR.
#
# ⚠️  NO MIGRATION, AND THE GUARD BELOW PROVES IT RATHER THAN ASSERTING IT. This branch merges
# DARK: STUDIO_VIDEO_ENABLED and STUDIO_CREATIVE_QA are both off by default and neither default
# moves here, so the video path is unreachable and the QA stage costs one boolean per tick. The
# verdict rides in `media_assets.metadata.creative_qa`, a jsonb key that already exists — which is
# why there is no .sql, no db-migrate.sh line and no schema.ts declaration to keep in step.
set -euo pipefail

BRANCH=studio-video-v9
BASE=main
BASE_SHA=801c42f      # origin/main at branch point (merge of PR #529, video V8)
EXPECTED_COMMITS=18   # what this script was written against (includes this helper commit)

# The tip is NOT pinned by sha, on purpose: committing this file would change the sha it pins, so
# the pin could never be right. The branch point and the commit count pin it instead — add or drop
# a commit and this refuses rather than pushing something nobody re-read.

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

# ── THE DARK-MERGE GUARD ────────────────────────────────────────────────────────────────────────
#
# The PR body says this merges dark and carries no schema change. That claim is worth exactly as
# much as a check, so it is one. A migration that arrived later would otherwise ship under a
# description that says there is none — and the drift gate names each file by hand, so half a
# migration reds a DEPLOY rather than a test.
forbidden=$(git diff --name-only "$BASE_SHA..HEAD" -- migrations shared/schema.ts scripts/db-migrate.sh .github gcp)
[ -z "$forbidden" ] || {
  echo "this branch touches paths V9 is not supposed to touch:"
  printf '  %s\n' $forbidden
  echo "Either the helper is stale or the PR body is now wrong. Re-read before pushing."
  exit 1
}

# Uncommitted work, scoped to what this branch actually touches.
#
# Same guard, and the same reason, as tools/dur and tools/v1: a blanket check hard-fails on
# server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip, which CANNOT be cleaned.
# .gitattributes carries `server/scripts/calibration/runs/** text eol=lf`, that glob catches a
# binary .zip, so git applies CRLF→LF on the clean filter and the archive reads short against what
# is stored. Any fresh checkout is born with it dirty. Not ours, not fixable here.
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
echo "Merges dark: STUDIO_VIDEO_ENABLED and STUDIO_CREATIVE_QA both default off. No migration."
git log --oneline "$BASE_SHA..HEAD"
read -r -p "Proceed? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted"; exit 1; }

git push -u origin "$BRANCH"

gh pr create --base "$BASE" --head "$BRANCH" \
  --title "Studio: a clip is routed by what KIND of segment it is, and inspected after it is made (video V9)" \
  --body-file "$WT/tools/v9/pr-body.md"
