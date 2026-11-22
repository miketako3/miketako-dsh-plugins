#!/usr/bin/env bash
# Manual smoke test for all three plugins against a throwaway DSH profile.
#
# Run from a DSH source checkout after installing the plugins:
#   DSH_PROFILE=longhorizon ./scripts/live-smoke.sh
#
# The prompt deliberately uses one tool so the ledger, router, and compaction
# paths are exercised. It requires a working provider and model in the profile.
set -euo pipefail

profile="${DSH_PROFILE:?set DSH_PROFILE to an installed test profile}"
dsh="${DSH_BIN:-pnpm dsh}"
home="${DSH_HOME:-$HOME/.dsh}"

if ! command -v node >/dev/null 2>&1; then
  echo "node 24.9 or newer is required" >&2
  exit 1
fi

out="$(mktemp -t dsh-live-smoke.XXXXXX.jsonl)"
trap 'rm -f "$out"' EXIT

echo "== running one tool turn on profile: $profile"
$dsh --profile "$profile" --json \
  "Use the bash tool to run exactly: echo live-smoke. Then reply with the command output only." \
  | tee "$out"

session_id="$(node -e '
  const fs = require("node:fs");
  const line = fs.readFileSync(process.argv[1], "utf8").split("\n").find(l => l.includes("\"type\":\"session\""));
  if (!line) process.exit(1);
  console.log(JSON.parse(line).sessionId);
' "$out")"

echo "== ledger rows for $session_id"
node - "$session_id" "$home" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const [sessionId, home] = process.argv.slice(2);
const db = new DatabaseSync(`${home}/durable-exec/ledger.db`);
const rows = db.prepare('SELECT tool_name, status, policy FROM tool_executions WHERE session_id = ?').all(sessionId);
console.log(rows);
if (!rows.some(row => row.tool_name === 'bash' && row.status === 'COMPLETED')) {
  console.error('expected a COMPLETED bash row');
  process.exit(1);
}
const checkpoint = db.prepare('SELECT status, turn, step FROM checkpoints WHERE session_id = ?').get(sessionId);
console.log(checkpoint);
if (checkpoint?.status !== 'IDLE') {
  console.error('expected an IDLE checkpoint after a completed turn');
  process.exit(1);
}
NODE

echo "== routing audit tail"
tail -5 "$home/virtual-router/audit.jsonl" 2>/dev/null || echo "(no audit file)"
echo "== ok"
