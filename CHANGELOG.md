# Changelog

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
