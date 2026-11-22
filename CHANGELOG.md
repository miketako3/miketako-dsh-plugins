# Changelog

## Unreleased

### Plugins

- Added `dsh-plugin-antigravity-acp`, an integration plugin that registers the
  `antigravity-acp` skill and, when the optional official packages are present,
  mounts `@deepseek-ai/dsh-subagent-acp` and a `subagent_antigravity` tool.
- Missing optional backend or tool packages downgrade the plugin to the skill
  instead of failing profile startup.

### Skills

- Added the `antigravity-acp` skill for delegating a standalone task to Google
  Antigravity CLI (`agy acp`) through `@deepseek-ai/dsh-subagent-acp`.
- Documents the required provider and tool rows, credential scrubbing and
  explicit `env` forwarding, permission modes, rejected start-time options,
  and ACP log locations.
- The standalone skill is documentation only; it does not install the ACP
  backend or vendor `agy`. The plugin mounts the backend and tool when they are
  present.
- The mounted tool sets `modelSelection: false` and
  `maxDepth: provider-managed`, matching the ACP provider's capabilities.

## 0.1.0 — 2026-11-22

Initial public release.

### `dsh-plugin-durable-exec`

- SQLite WAL ledger for tool idempotency and turn checkpoints.
- Side-effect classification with `read-only`, `idempotent`, and `side-effect` policies.
- Replay of completed and failed calls; `TOOL_OUTCOME_UNKNOWN` for in-flight calls after a crash.
- Transient retry with exponential backoff and provider `retryAfter`.
- Circuit breaker with optional virtual-router escalation.
- Startup auto-resume for interrupted root sessions.

### `dsh-plugin-context-longevity`

- Deferred tool loading with `discover_tools` and `activate_tools`.
- Structured compaction with required sections and deterministic file/command retention.
- Optional cache warming during long tool calls.

### `dsh-plugin-virtual-router`

- Virtual provider and per-request routing by phase, failure history, budget, and forced tier.
- Sticky routing per turn and provider fallback before the first content delta.
- Per-session token and request budgets with stop or downgrade.
- JSONL audit of routing decisions.
