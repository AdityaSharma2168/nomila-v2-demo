#!/usr/bin/env bash
#
# run-first-last.sh — the ONE paid command of the Kling first-and-last probe, in a line short enough
# that a terminal cannot wrap it.
#
# ⚠️ WHY THIS FILE EXISTS. The full invocation is ~145 characters and twice got split across a line
# break on the way into a terminal. The second time, `--run` arrived WITHOUT `--cap` and the script's
# own guard refused before any call — which is the guard working, and is also a warning: the failure
# mode of a wrapped spend command is arbitrary, and the next arrangement of fragments might not be a
# safe one. So the arguments live in a file rather than in a paste.
#
# ⚠️ THIS SPENDS. Quote ceiling $2.5200, expected invoice $1.6800 (4 x 5s x $0.084, the audio-off arm,
# verified on four real invoices). Nothing here is a dry run — for that, drop every flag:
#
#     npx tsx -r dotenv/config server/scripts/studioKlingFirstLast.ts
#
# ⚠️ ADI RUNS THIS. Claude does not, in any form — not with a flag, not to "check", not once. The
# house rule (`never-invoke-push-helpers`) was written after a helper was invoked for its --help and
# did its job anyway. `bash -n` is the only thing Claude may do to this file.
set -euo pipefail

cd "$(dirname "$0")/../.."

# --confirm-pairs is Adi asserting that c2 and c4 pair TWO FRAMES OF THE SAME WOMAN. This library is
# 3+ different people and a small d(A,B) is evidence of one SHOOT, never of one person. A mixed pair
# does not produce a weaker finding, it produces a measurement of a morph.
exec npx tsx -r dotenv/config server/scripts/studioKlingFirstLast.ts \
  --run --cap 2.59 --confirm-pairs
