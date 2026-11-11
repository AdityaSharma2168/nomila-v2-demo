#!/usr/bin/env bash
# Commercial Intelligence ↔ Brain boundary checkpoint — the fixture stage. Every cell rendered with --dry: the exact
# prompt that WOULD be sent, and nothing sent. Run from the repo root. Provider calls happen only when --dry is removed
# by hand, cell by cell, after approval.
set -euo pipefail
ART=docs/audits/artifacts/brain-context-experiment-1
CI=$ART/ci-boundary
R2=$ART/1b/overlays/R2.json
D2K=$ART/1b3/decisions/D2k.json
CTX=$ART/context-block.json
RUN="npx tsx --require dotenv/config server/scripts/intelligence/brainRun.ts"
MODE=${1:---dry}

cell() { # name athlete variant extra-args…
  local name=$1 athlete=$2 variant=$3; shift 3
  mkdir -p "$CI/dry/$name"
  echo "── $name"
  $RUN --athlete "$athlete" --variants "$variant" --out "$CI/dry/$name" --label "$name" "$@" $MODE
}

# A · Mia, connected, rich — the R2 term sheet, the 7-item context block, the D2k question
cell A0 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K
cell A1 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K --commercial $CI/cells/A1.json
cell A2 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K --commercial $CI/cells/A2.json
cell A3 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K --commercial $CI/cells/A3.json
cell A4 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K --commercial $CI/cells/A4.json
cell A5 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K,$CI/fixtures/D3-r2.decision.json --commercial $CI/cells/A5.json
# B · Mia, connected commercial withheld at the rendering
cell B0 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K --withhold connected-commercial
cell B1 "Mia Bhuta" V3 --context $CTX --work-overlay $R2 --decision $D2K --withhold connected-commercial --commercial $CI/cells/B1.json
# C · Cristiano Ronaldo, public / research-only — zero live Objectives, no context block
cell C0 "Cristiano Ronaldo" V2 --work-overlay $CI/fixtures/C-ronaldo.overlay.json --decision $CI/fixtures/C-ronaldo.decision.json
cell C2 "Cristiano Ronaldo" V2 --work-overlay $CI/fixtures/C-ronaldo.overlay.json --decision $CI/fixtures/C-ronaldo.decision.json --commercial $CI/cells/C2.json
# D · Lilia Bhuta, user, no observed commerce — zero live Objectives, no context block
cell D0 "Lilia Bhuta" V2 --work-overlay $CI/fixtures/D-lilia.overlay.json --decision $CI/fixtures/D-lilia.decision.json
cell D2 "Lilia Bhuta" V2 --work-overlay $CI/fixtures/D-lilia.overlay.json --decision $CI/fixtures/D-lilia.decision.json --commercial $CI/cells/D2.json
