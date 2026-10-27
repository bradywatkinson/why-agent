#!/usr/bin/env bash
# Score src/agent/guard.ts with the official Meterless Scout eval runner.
# Only the guard stage is implemented here, so read the injection metrics;
# intent/tool metrics will be 0 because this agent does not classify intents.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d vendor/scout-intent ]; then
  npx --yes degit meterless/meterless/engines/scout-intent vendor/scout-intent
  (cd vendor/scout-intent && npm install --no-audit --no-fund)
fi
cd vendor/scout-intent
SCOUT_IMPL="$(cd ../.. && pwd)/src/agent/guard.ts" npx tsx evals/runner/index.ts "${1:-injection}"
