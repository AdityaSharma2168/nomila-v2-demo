#!/usr/bin/env bash
# Print one joined row from dev, read-only. Runs the worktree's script with the main checkout's .env.
#   bash tools/join-row/print-row.sh <athlete uuid> [--latest-edit | --asset <uuid> | --job <uuid> | --edit <uuid>] [--json]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${DOTENV_CONFIG_PATH:-/Users/adi/nomila-v2/.env}"
ATHLETE="${1:?athlete uuid}"; shift
cd "$HERE"
DOTENV_CONFIG_PATH="$ENV_FILE" npx tsx -r dotenv/config server/scripts/studioJoinRow.ts --athlete "$ATHLETE" "${@:---latest-edit}"
