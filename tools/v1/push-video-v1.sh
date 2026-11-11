#!/bin/bash
# Video V1 — spend guards. ADI RUNS THIS. Claude never does, not even with --help.
#
# Pushes studio-video-v1 and opens the PR. Nothing here touches the database, the
# deploy config, or any live infrastructure — the branch is server-side guards and
# tests only, and it does not enable video.
set -euo pipefail

BRANCH=studio-video-v1
BASE=main
BASE_SHA=27185ee     # main at branch point
EXPECTED_COMMITS=8   # what this script was written against

# The tip is NOT pinned by sha, on purpose: committing this file would change the
# sha it pins, so the pin could never be right. The branch point and the commit
# count pin it instead — add or drop a commit and this refuses rather than pushing
# something nobody re-read.

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

# Uncommitted work, scoped to what this branch actually touches.
#
# The first version of this check tested all of server/ shared/ docs/ client/ and hard-failed on
# server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip — a file no commit here goes
# near, and one that CANNOT be cleaned. .gitattributes carries
# `server/scripts/calibration/runs/** text eol=lf`, and that glob catches a binary .zip, so git
# applies CRLF→LF on the clean filter and the archive reads 251877 bytes against a stored 251881.
# Any fresh checkout of this repo is born with it dirty; `git checkout --` re-dirties it immediately.
# See V-L5 in docs/probes/video-v1-ledger.md — it is a real bug, in the calibration lane, not ours.
#
# So the guard now asks the question it meant to ask: is there uncommitted work in a file THIS BRANCH
# EDITS? That is the thing a push would silently leave behind. Anything else is noted and stepped
# over, loudly enough that a genuine surprise is still visible.
# Intersected by name rather than by passing the list back as pathspecs — a filename with a space
# would word-split into two bogus pathspecs and the guard would silently check nothing.
touched=$(git diff --name-only "$BASE_SHA..HEAD")
dirty=$(git status --porcelain -- server shared docs client tools | awk '{ $1=""; sub(/^ /,""); print }')

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
git log --oneline "$BASE_SHA..HEAD"
read -r -p "Proceed? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted"; exit 1; }

git push -u origin "$BRANCH"

gh pr create --base "$BASE" --head "$BRANCH" \
  --title "Studio: video spend guards — cap the latent \$24 clip before any video can generate (video V1)" \
  --body-file "$WT/tools/v1/pr-body.md"
