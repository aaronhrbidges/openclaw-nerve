#!/bin/bash
# Nerve start wrapper — .env is loaded by the Node server at runtime.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"
export PATH="/usr/local/bin:/opt/homebrew/bin:${PATH}"
export NODE_ENV=production
exec node --import file://${SCRIPT_DIR}/node_modules/tsx/dist/loader.mjs server/index.ts
