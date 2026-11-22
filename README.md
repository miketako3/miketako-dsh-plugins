# miketako-dsh-plugins

Long-horizon autonomy for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), packaged as three independent Cordis plugins.

A long task is not a long prompt. It is a sequence of turns that must survive a crash, a context window that must not forget what matters, and a model choice that should change as the work moves from planning to implementation to verification. These plugins address those three failure modes separately, and compose when all three are installed.

| Plugin | Problem it solves | Replaces a host plugin? |
| --- | --- | --- |
| [`dsh-plugin-durable-exec`](plugins/durable-exec) | A process restart loses in-flight work, and a retried side effect can run twice. | No; it adds an execution ledger and checkpoints. |
| [`dsh-plugin-context-longevity`](plugins/context-longevity) | A large tool registry is sent on every request, and compaction drops exact paths and commands. | Optionally replaces `compaction-basic` with a structured summarizer. |
| [`dsh-plugin-virtual-router`](plugins/virtual-router) | Every request uses one model, even when a cheaper or stronger one is appropriate. | No; it registers a new provider and a virtual model. |

All three are MIT licensed, have no runtime dependency outside DSH and the Node standard library, and keep DSH's append-only session history untouched.

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0` (verified against `0.2.2-rc.5`)
- Node.js `>=24.9.0` (verified on `24.22.1`)
- `pnpm` `11.x`
- Optional: a working provider registered in DSH, such as `litellm`, for the router

The plugins are not published to npm. Install them from a clone or from packed tarballs.

## Install from a clone

```bash
git clone https://github.com/miketako3/miketako-dsh-plugins.git
cd miketako-dsh-plugins
pnpm install
pnpm build
```

Install one plugin into a profile:

```bash
dsh plugin --profile my-profile add /absolute/path/to/miketako-dsh-plugins/plugins/durable-exec
```

`dsh plugin add` reads the package's `dsh.bundle.patch` and appends its Cordis row to the profile patch. If you run DSH from a source checkout, use `pnpm dsh` from that checkout instead of a global `dsh` binary.

To install a packed tarball instead:

```bash
pnpm --filter dsh-plugin-durable-exec pack --pack-destination dist
dsh plugin --profile my-profile add ./dist/dsh-plugin-durable-exec-0.1.0.tgz
```

The `dsh` command's profile installer does not install peer dependencies automatically when the profile uses `autoInstallPeers: false`. The DSH installation already provides `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`, and the compaction packages. If your profile resolves plugins from a directory that cannot see those packages, add the matching `@deepseek-ai/dsh-*` versions as direct profile dependencies at the same version as DSH.

## 1. Durable execution

**Package:** `dsh-plugin-durable-exec`  
**Cordis plugin name:** `durable-exec`  
**Service:** `ctx.durableExec`

The plugin records every tool call before it runs and every result before it is appended to the session. The ledger is SQLite with WAL, using the built-in `node:sqlite` module, so no native module is compiled.

### What it records

| Record | Written on | Contents |
| --- | --- | --- |
| Tool execution | `tools/pre-execute`, `tools/result` | idempotency key, tool name, canonical argument hash, policy, status, result, error code |
| Checkpoint | `turn/start`, each step, `turn/end` | session id, turn, step, status, goal excerpt, Git HEAD, workspace progress |

The idempotency key is `(sessionId, turn, step, toolName, sha256(canonical arguments))`. It deliberately excludes the model-generated call id, which changes when a model re-issues the same call.

### Side-effect policy

Each tool gets one policy:

- `read-only` — can be retried and replayed freely.
- `idempotent` — can be retried; a replay returns the recorded result.
- `side-effect` — is never automatically repeated. If the process died while the call was in flight, the ledger returns `TOOL_OUTCOME_UNKNOWN` and asks the model to inspect external state before retrying.

Defaults:

```yaml
toolPolicies:
  read: read-only
  glob: read-only
  grep: read-only
  web_fetch: read-only
  web_search: read-only
  session_query: read-only
  todo_write: idempotent
  write: side-effect
  edit: side-effect
  bash: side-effect
  present: side-effect
defaultToolPolicy: side-effect
```

Unknown tools default to `side-effect`; a new tool is safe by default rather than dangerous by default.

### Retry and circuit breaker

Transient provider failures are retried only for `read-only` and `idempotent` tools, with exponential backoff, jitter, and provider `retryAfter` support:

```yaml
retry:
  enabled: true
  maxAttempts: 3
  initialDelayMs: 500
  maxDelayMs: 15000
  jitterRatio: 0.2
```

After 8 consecutive failures the breaker opens. With `action: escalate` it calls `ctx.virtualRouter.escalate()` when the router is installed; otherwise it stops the turn. Four tool-using turns without a workspace change trigger the same escalation.

### Crash recovery

On startup the plugin looks for `RUNNING` checkpoints owned by root agents, marks any in-flight calls of that turn as `TOOL_OUTCOME_UNKNOWN`, and resumes up to three sessions. A resumed turn gets a `durable-resume` message describing the interrupted turn, step, and Git HEAD. DSH's own repair path still appends `interrupted` tool results; the ledger never rewrites those records.

### Configuration

```yaml
- id: durable-exec
  config:
    databasePath: /Users/you/.dsh/durable-exec/ledger.db
    retry:
      maxAttempts: 3
    circuitBreaker:
      failureThreshold: 8
      action: escalate
    checkpoints:
      includeGitHead: true
    autoResume:
      enabled: true
      maxSessions: 3
      maxAttempts: 3
      resumeWindowTurns: 5
      prompt: >-
        This session was interrupted by a harness process restart. Resume the
        original task from the last recorded checkpoint.
```

The database is created with mode `0600`. It contains tool arguments and results, which may include file contents or command output; treat it as sensitive as the session log.

### API

```ts
ctx.durableExec.checkpoint({ status: 'RUNNING', turn, step, goal })
ctx.durableExec.recent(sessionId, limit)
ctx.durableExec.entry(key)
ctx.durableExec.snapshot()
```

## 2. Context longevity

**Package:** `dsh-plugin-context-longevity`  
**Cordis plugin names:** `context-longevity` (deferred tools, cache warming) and `context-longevity/compaction` (structured compaction)

### Deferred tool loading

When the global tool registry exceeds `threshold` (default 20), each root agent sees an always-active core plus tools returned by `discover_tools` and loaded by `activate_tools`. Activation is plugin state, not message history, so it survives compaction.

Default core: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `todo_write`, `present`, `job_list`, `job_output`, `job_kill`, plus the two control tools. `maxActive` caps the visible set at 28.

A live run with 27 registered tools showed `12 visible, 15 deferred`; `discover_tools` returned ranked matches, and `activate_tools` made a hidden tool callable on the next step.

The restriction is installed with `agent.ctx.tools.restrict({ allow })`. It never removes a tool from the registry and never touches the session log. Agent-scoped tools registered on the agent's own context are exempt from the inherited restriction.

```yaml
- id: context-longevity
  config:
    deferredTools:
      enabled: true
      threshold: 20
      maxActive: 28
      discoverLimit: 25
      alwaysActive: [read, write, edit, bash, glob, grep, todo_write, present, job_list, job_output, job_kill, discover_tools, activate_tools]
```

### Structured compaction

`dsh-plugin-context-longevity/compaction` subclasses DSH's `BasicCompactionEngine`. It adds an explicit output contract to the summarization call and deterministically appends facts the model omitted:

- required sections: Primary Request and Intent, Decisions and Constraints, Files and Code, Verification, Open Issues, Next Step
- file paths observed in tool arguments and authored messages (up to 40)
- shell commands observed in tool arguments (up to 10)
- a `## Retained Facts` block added when a required section or an observed file/command is missing from the model's summary

The base engine still owns the durable compaction events, summarization request, token accounting, and fallback behavior. The subclass only appends to the returned summary; it does not rewrite prior session events.

Because the base compaction config rejects unknown keys, the structured engine is a **separate loader row**:

```yaml
- id: compaction-basic
  disabled: true
- id: compaction-longevity
  name: dsh-plugin-context-longevity/compaction
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    auto: true
```

Install the base plugin row (`context-longevity`) with `dsh plugin add`; then edit the profile patch to disable `compaction-basic` and insert the compaction row above.

> **Web profiles:** the web app mounts compaction per agent preset (`packages/bundle/web-app/presets/*.patch.yml`, row id `compaction-basic`). Disable that row in each preset you use; a top-level profile replacement only affects the headless/base composition.

### Cache warming

Optional and disabled by default. During a tool call that runs longer than `delayMs`, the plugin sends a one-token request with the same system prompt, tools, and message prefix, so the provider's prefix cache is warm for the next step. Warming is skipped for nested PTC calls, repeated at `intervalMs` up to `maxWarmingsPerTurn`, and cancelled when the tool returns.

```yaml
- id: context-longevity
  config:
    cacheWarming:
      enabled: true
      delayMs: 2000
      intervalMs: 60000
      maxWarmingsPerTurn: 3
```

Warming consumes provider tokens and money. It is off by default; enable it only when your provider bills cached reads at a meaningful discount.

## 3. Virtual model router

**Package:** `dsh-plugin-virtual-router`  
**Cordis plugin name:** `virtual-router`  
**Provider id:** `virtual` (configurable)  
**Service:** `ctx.virtualRouter`

The router registers an `LlmAdapter` for a virtual provider. A model picker entry such as `virtual/autonomous` is resolved at request time to one physical tier. Routing considers, in order:

1. budget stop or downgrade
2. an explicit forced tier (`ctx.virtualRouter.forceTier`)
3. failure escalation from the sticky session state
4. phase rules (`plan`, `implement`, `verify`, `summarize`, `default`)
5. the model's `defaultTier`

Within a turn the chosen route is sticky, so a multi-step turn does not bounce between providers. A turn boundary clears it. A provider error before any content delta can fall back to another physical route; an error after content has started is surfaced, not retried, because the user has already seen partial output.

### litellm example

```yaml
- id: litellm
  config:
    baseUrl: http://127.0.0.1:4000
    apiKey: ${LITELLM_API_KEY}

- id: virtual-router
  config:
    provider: virtual
    displayName: Virtual Router
    models:
      - id: autonomous
        name: Autonomous
        contextWindow: 262144
        defaultTier: cheap
    tiers:
      - id: cheap
        provider: litellm
        model: gpt-4.1-mini
      - id: strong
        provider: litellm
        model: gpt-4.1
        reasoningEffort: high
    phaseRoutes:
      plan: strong
      implement: cheap
      verify: cheap
      summarize: cheap
      default: cheap
    escalation:
      enabled: true
      afterFailures: 2
      ladder: [cheap, strong]
    fallback:
      enabled: true
      routes:
        - provider: litellm
          model: gpt-4.1
      codes: [RATE_LIMIT, SERVER_ERROR, TIMEOUT]
      statuses: [408, 429, 500, 502, 503, 504]
    budget:
      maxTokens: 2000000
      maxRequests: 400
      onExhausted: stop
    sticky:
      enabled: true
      perTurn: true
    auditPath: /Users/you/.dsh/virtual-router/audit.jsonl
```

Point the agent's default model at the virtual model:

```yaml
- id: agent-default-model
  config:
    provider: virtual
    model: autonomous
```

### Budget behavior

`maxTokens` counts cumulative input tokens for the session; `maxRequests` counts physical requests. On exhaustion:

- `stop` — the adapter returns a `BUDGET_EXCEEDED` finish error without calling a provider.
- `downgrade` — the adapter routes to `budget.downgradeTier` and records the change.

### Audit

Every decision is appended as one JSON line: timestamp, event (`route`, `fallback`, `stop`, `escalate`), session, turn, phase, virtual model, from/to route, reason, failure count, estimated input tokens, and optional estimated cost delta. Message content is never recorded. The file is created with mode `0600`; an empty `auditPath` disables file output while keeping the bounded in-memory ring used by `ctx.virtualRouter.recentAudit()`.

### API

```ts
ctx.virtualRouter.escalate(agent, 'tool failure')
ctx.virtualRouter.forceTier(agent, 'strong')
ctx.virtualRouter.noteTurn(sessionId, turn)
ctx.virtualRouter.snapshot(sessionId)
ctx.virtualRouter.recentAudit(limit)
```

## Using all three together

```yaml
- id: durable-exec
- id: context-longevity
  config:
    deferredTools: { enabled: true }
    cacheWarming: { enabled: false }
- id: virtual-router
  config:
    # ...
- id: agent-default-model
  config: { provider: virtual, model: autonomous }
```

The composition is intentionally loose:

- `durable-exec` calls `ctx.get('virtualRouter')` only when escalating; it works without the router.
- `context-longevity` never imports the router or the ledger.
- `virtual-router` never depends on either.

All three write outside the session log: SQLite ledger, JSONL audit, and in-memory routing state. None of them appends custom session event types, so sessions remain readable by stock DSH.

## Fork customizations vs. plugins

These plugins were extracted alongside a personal DSH fork. Most of that fork is **not** expressible as a plugin, because it changes code that runs before the plugin graph or inside the web shell:

| Fork change | Plugin-expressible? | Why |
| --- | --- | --- |
| Mobile Web layout (CSS modules, `AppFrame`, `InputBar`, `Rows`) | No | CSS-module class names are content-hashed at build time, and the layout changes alter TSX structure, not just styles. A client plugin can inject CSS but cannot reliably target those hashed selectors or replace component behavior. Kept as fork-only. |
| `DSH_WEB_NOAUTH=1` | No | It is consumed by the HTTP server bootstrap before profiles and plugins load. Use the fork or an environment-specific launcher. |
| Per-token logprobs streaming | No | It is a protocol-level change in `@earendil-works/pi-ai` and the model adapter, patched through `patches/`. |
| HTTP proxy long-request timeout | No | The proxy is installed before plugin activation. |
| Durable execution, deferred tools, compaction, routing | **Yes** | These are the three plugins in this repository. |

If you need the mobile layout, use the fork; if you need long-horizon behavior, use these plugins. The repository does not claim to reproduce the fork.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check   # typecheck + test + build
```

Each plugin is an independent package under `plugins/`. Tests use Vitest and Node's real `node:sqlite`; they do not mock the ledger. The router tests construct a fake `LlmAdapter` and assert routing, escalation, fallback, budget stop, and sticky behavior without a network call.

For a manual end-to-end smoke test against a throwaway profile, see [`scripts/live-smoke.sh`](scripts/live-smoke.sh).

Live verification used a throwaway profile with a litellm-compatible endpoint and a 27-tool registry:

- a headless tool turn produced a `COMPLETED` ledger row and an `IDLE` checkpoint;
- SIGKILL during `bash` left a `PENDING` row and a `RUNNING` checkpoint, and the next boot resumed the session with `durable-resume`, `turn: 2`, and `resume_count: 1`;
- deferred loading showed `12 visible, 15 deferred`; `activate_tools` made a hidden tool callable;
- the router audit showed `phase default/implement`, `to cheap/strong`, and `outcome success`;
- structured compaction produced all required sections and a deterministic `Retained Facts` block.

## Limitations

- `dsh plugin add` does not install peers when the profile disables peer auto-install. See [Install from a clone](#install-from-a-clone).
- The compaction replacement is a separate loader row and must be wired manually; it is not installed by the bundle patch because the base row must be disabled first.
- Web presets mount their own compaction rows; a single top-level replacement is not enough for every preset.
- Auto-resume is best-effort. A headless process can exit before the resumed turn finishes; the next boot retries up to `autoResume.maxAttempts`.
- The ledger stores tool arguments and results unredacted. Tool output may contain secrets; protect the DSH home directory and the ledger file.
- Cache warming is off by default and costs tokens.

## License

MIT. See [LICENSE](LICENSE).
