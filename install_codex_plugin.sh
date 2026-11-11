#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUS_URL=${1:-${AGENT_BUS_URL:-http://127.0.0.1:7800}}
if [ "$#" -gt 0 ]; then shift; fi

cd "$SCRIPT_DIR"
exec bun run install:codex --url "$BUS_URL" "$@"
