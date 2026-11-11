#!/usr/bin/env bash
# Commercial Intelligence ↔ Brain boundary checkpoint — the approved calls, ONE CELL PER INVOCATION.
#   bash docs/audits/artifacts/brain-context-experiment-1/ci-boundary/run.sh A3 A3-2
# Arguments: <cell> [label]. Writes {inputs, record} to ci-boundary/arm/<cell>/<label>.json. Approved 26 Sep:
# A0 → A1 → A2 → A3 ×3 → A4 → A5 → B0 → B1 → C0 → C2 → D0 → D2. No reruns, no tuning, nothing materialised.
set -euo pipefail
ART=docs/audits/artifacts/brain-context-experiment-1
CI=$ART/ci-boundary
R2=$ART/1b/overlays/R2.json
D2K=$ART/1b3/decisions/D2k.json
CTX=$ART/context-block.json
RUN="npx tsx --require dotenv/config server/scripts/intelligence/brainRun.ts"
CELL=${1:?cell}; LABEL=${2:-$CELL}
OUT=$CI/arm/$CELL; mkdir -p "$OUT"
if [ -e "$OUT/$LABEL.json" ]; then echo "refusing: $OUT/$LABEL.json exists (no reruns)"; exit 2; fi
MIA=(--athlete "Mia Bhuta" --variants V3 --context $CTX --work-overlay $R2)
case $CELL in
  A0) $RUN "${MIA[@]}" --decision $D2K --out "$OUT" --label "$LABEL" ;;
  A1|A2|A3|A4) $RUN "${MIA[@]}" --decision $D2K --commercial $CI/cells/$CELL.json --out "$OUT" --label "$LABEL" ;;
  A5) $RUN "${MIA[@]}" --decision $D2K,$CI/fixtures/D3-r2.decision.json --commercial $CI/cells/A5.json --out "$OUT" --label "$LABEL" ;;
  B0) $RUN "${MIA[@]}" --decision $D2K --withhold connected-commercial --out "$OUT" --label "$LABEL" ;;
  B1) $RUN "${MIA[@]}" --decision $D2K --withhold connected-commercial --commercial $CI/cells/B1.json --out "$OUT" --label "$LABEL" ;;
  C0) $RUN --athlete "Cristiano Ronaldo" --variants V2 --work-overlay $CI/fixtures/C-ronaldo.overlay.json --decision $CI/fixtures/C-ronaldo.decision.json --out "$OUT" --label "$LABEL" ;;
  C2) $RUN --athlete "Cristiano Ronaldo" --variants V2 --work-overlay $CI/fixtures/C-ronaldo.overlay.json --decision $CI/fixtures/C-ronaldo.decision.json --commercial $CI/cells/C2.json --out "$OUT" --label "$LABEL" ;;
  D0) $RUN --athlete "Lilia Bhuta" --variants V2 --work-overlay $CI/fixtures/D-lilia.overlay.json --decision $CI/fixtures/D-lilia.decision.json --out "$OUT" --label "$LABEL" ;;
  D2) $RUN --athlete "Lilia Bhuta" --variants V2 --work-overlay $CI/fixtures/D-lilia.overlay.json --decision $CI/fixtures/D-lilia.decision.json --commercial $CI/cells/D2.json --out "$OUT" --label "$LABEL" ;;
  *) echo "unknown cell $CELL"; exit 2 ;;
esac
