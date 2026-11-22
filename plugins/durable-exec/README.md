# dsh-plugin-durable-exec

Crash recovery and side-effect safety for long DSH tasks.

The plugin records every tool call in a SQLite ledger before it executes, records the result before it reaches the session, and checkpoints each turn. After a process restart it resumes interrupted root sessions and refuses to silently repeat a side effect whose outcome was never observed.

## Install

```bash
pnpm build
dsh plugin --profile my-profile add /absolute/path/to/plugins/durable-exec
```

The bundle patch inserts:

```yaml
- id: durable-exec
  name: dsh-plugin-durable-exec
```

## Behavior

- `tools/pre-execute` inserts a `PENDING` row keyed by `(session, turn, step, tool, canonical arguments)`.
- `tools/execute` short-circuits a replay:
  - `COMPLETED` returns the recorded value and content.
  - `FAILED` returns the recorded error.
  - `PENDING` from an earlier process returns `TOOL_OUTCOME_UNKNOWN`.
- `tools/result` records the final result and updates the circuit breaker.
- `turn/start`, step changes, and `turn/end` write checkpoints.
- On startup, `RUNNING` root checkpoints are resumed (up to `maxSessions`), and in-flight calls of the interrupted turn become `TOOL_OUTCOME_UNKNOWN`.

Side effects are never retried automatically. Only `read-only` and `idempotent` tools use the retry policy.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `databasePath` | `$DSH_HOME/durable-exec/ledger.db` | SQLite ledger; parent directories are created. |
| `toolPolicies` | read/glob/grep/web/session read-only; todo_write idempotent; write/edit/bash/present side-effect | Per-tool classification. |
| `defaultToolPolicy` | `side-effect` | Classification for unknown tools. |
| `retry.maxAttempts` | 3 | Attempts including the first. |
| `retry.initialDelayMs` / `maxDelayMs` | 500 / 15000 | Exponential backoff bounds. |
| `retry.jitterRatio` | 0.2 | Fractional jitter. |
| `circuitBreaker.failureThreshold` | 8 | Consecutive failures before opening. |
| `circuitBreaker.action` | `escalate` | `escalate` uses `ctx.virtualRouter` when present; otherwise the turn stops. |
| `circuitBreaker.noProgressTurns` | 4 | Tool-using turns without a workspace change. |
| `checkpoints.includeGitHead` | true | Capture `git rev-parse HEAD`. |
| `autoResume.enabled` | true | Resume interrupted root sessions at startup. |
| `autoResume.maxSessions` | 3 | Sessions resumed per process start. |
| `autoResume.maxAttempts` | 3 | Automatic resume attempts per session. |
| `autoResume.resumeWindowTurns` | 5 | Turns in which recorded results may be replayed. |

Full example:

```yaml
- id: durable-exec
  config:
    databasePath: /Users/you/.dsh/durable-exec/ledger.db
    toolPolicies:
      bash: side-effect
      write: side-effect
      read: read-only
      todo_write: idempotent
      my_custom_read_tool: read-only
    retry:
      enabled: true
      maxAttempts: 3
      initialDelayMs: 500
      maxDelayMs: 15000
      jitterRatio: 0.2
    circuitBreaker:
      failureThreshold: 8
      cooldownMs: 60000
      action: escalate
      noProgressTurns: 4
      noProgressAction: escalate
    checkpoints:
      includeGitHead: true
    autoResume:
      enabled: true
      maxSessions: 3
      maxAttempts: 3
```

## API

```ts
ctx.durableExec.checkpoint({ status: 'RUNNING', turn, step, goal })
ctx.durableExec.recent(sessionId, limit)
ctx.durableExec.entry(idempotencyKey)
ctx.durableExec.snapshot()
```

## Operational notes

- The ledger contains tool arguments and results unredacted. It is created with mode `0600`.
- Nested PTC calls (`exec.parent !== undefined`) bypass the ledger; the outer call owns replay.
- Subagent sessions are not auto-resumed; only root `RUNNING` checkpoints are.
- A headless process may exit before a resumed turn completes. The next boot retries up to `autoResume.maxAttempts`.

## Test

```bash
pnpm test
```

The suite covers canonical hashing, retry classification, WAL persistence across close/open, pending replay, semantic lookup, interrupted-session listing, attempt accounting, and unknown-outcome resolution.
