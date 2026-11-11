#!/bin/bash
# Video V6 — the stitch engine. ADI RUNS THIS. Claude never does, not even with --help.
#
# Pushes studio-video-v6 and opens the PR. Nothing here touches the database, the deploy
# config, or any live infrastructure. The branch adds one new directory
# (server/studio/video/**) plus its ledger, and NOTHING imports it yet — V7 is what wires
# it up, so this is dead code the moment it merges. That is the whole reversibility story
# and the reason there is no feature flag.
#
# Zero model calls were made building it. ffmpeg and ffprobe are the only processes the
# module spawns, and ffmpeg is already in the container (Dockerfile:29-31) — no new
# dependency.
set -euo pipefail

BRANCH=studio-video-v6
BASE=main
BASE_SHA=e96323a     # main at branch point (#512, after studio-v2 had NOT yet merged)
EXPECTED_COMMITS=2   # what this script was written against

# The tip is not pinned by sha on purpose: committing this file changes the sha it would
# pin. The branch point plus the commit count pin it instead — add or drop a commit and
# this refuses rather than pushing something nobody re-read.

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

# Uncommitted work, scoped to files THIS BRANCH edits. Everything else is noted and stepped
# over — see the same guard in tools/v1/push-video-v1.sh and V-L5 in the V1 ledger for why:
# .gitattributes carries `server/scripts/calibration/runs/** text eol=lf`, that glob catches
# a binary .zip, and so every fresh checkout of this repo is born with that archive dirty and
# cannot be cleaned. This worktree is no exception. No commit here goes near it.
# Intersected by name rather than by passing the list back as pathspecs — a filename with a
# space would word-split into two bogus pathspecs and the guard would silently check nothing.
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
  echo "note: dirty paths OUTSIDE this branch's diff — left alone, and a push sends commits not"
  echo "      the working tree, so none of this travels:"
  printf '      %s\n' $dirty_other
  echo
}

echo "About to push $BRANCH ($tip, ${BASE_SHA}..HEAD) to origin and open a PR against $BASE."
git log --oneline "$BASE_SHA..HEAD"
read -r -p "Proceed? [y/N] " ans
[ "$ans" = "y" ] || { echo "aborted"; exit 1; }

git push -u origin "$BRANCH"

gh pr create --base "$BASE" --head "$BRANCH" \
  --title "Studio: a stitch engine for clips that share no encode params (video V6)" \
  --body-file "$WT/tools/v6/pr-body.md"
