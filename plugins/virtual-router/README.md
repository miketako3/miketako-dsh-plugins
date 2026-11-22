# dsh-plugin-virtual-router

Request-level model routing for DSH: one virtual model, several physical tiers.

The plugin registers an `LlmAdapter` for a virtual provider. A model such as `virtual/autonomous` is resolved per request using budget state, an explicit tier, failure escalation, phase heuristics, and the model's default tier. The decision is auditable; message content is not recorded.

## Install

```bash
pnpm build
dsh plugin --profile my-profile add /absolute/path/to/plugins/virtual-router
```

The bundle patch inserts:

```yaml
- id: virtual-router
  name: dsh-plugin-virtual-router
```

Then point the agent at the virtual model:

```yaml
- id: agent-default-model
  config:
    provider: virtual
    model: autonomous
```

## Routing order

1. **Budget** — `maxTokens` / `maxRequests` exhausted: stop or downgrade.
2. **Forced tier** — `ctx.virtualRouter.forceTier(agent, tierId)`.
3. **Escalation** — consecutive request failures move one tier up `ladder`.
4. **Phase** — `plan`, `implement`, `verify`, `summarize`, `default`.
5. **Default** — the virtual model's `defaultTier`.

Sticky routing keeps one physical route for all steps of a turn (`sticky.perTurn`). A turn boundary clears it.

## Fallback

Fallback is considered only before the first content delta. A `RATE_LIMIT`, `SERVER_ERROR`, `TIMEOUT`, HTTP 408/429/5xx, or a configured code tries the next route in `fallback.routes`. Once content has been yielded, an error is surfaced rather than retried, so partial output is not discarded.

## Budget

- `onExhausted: stop` returns a `BUDGET_EXCEEDED` finish error without calling a provider.
- `onExhausted: downgrade` routes to `downgradeTier` and records the change.

Input-token usage is counted cumulatively per session; requests counts physical attempts.

## Configuration

```yaml
- id: virtual-router
  config:
    provider: virtual
    displayName: Virtual Router
    models:
      - id: autonomous
        name: Autonomous
        contextWindow: 262144
        defaultTier: cheap
        description: Cheapest capable route
    tiers:
      - id: cheap
        provider: litellm
        model: gpt-4.1-mini
      - id: strong
        provider: litellm
        model: gpt-4.1
        reasoningEffort: high
        inputCostPerMTok: 2
        outputCostPerMTok: 8
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
      codes: [RATE_LIMIT, SERVER_ERROR, TIMEOUT, NETWORK, ECONNRESET]
      statuses: [408, 429, 500, 502, 503, 504]
    budget:
      maxTokens: 2000000
      maxRequests: 400
      onExhausted: stop
      downgradeTier: cheap
    sticky:
      enabled: true
      perTurn: true
    phaseDetection:
      enabled: true
      plan: [plan, design, architect, investigate, research]
      implement: [implement, add, fix, change, refactor, write]
      verify: [test, verify, check, lint, typecheck, build]
    auditPath: /Users/you/.dsh/virtual-router/audit.jsonl
```

`tiers` and `models` default to empty. A configuration with a dangling `defaultTier`, `phaseRoutes` value, or ladder entry fails fast at load time.

## Audit

One JSON line per decision:

```json
{"ts":1795330000000,"event":"route","sessionId":"session-...","turn":1,"phase":"implement","virtualModel":"autonomous","from":{"provider":"virtual","model":"autonomous"},"to":{"provider":"litellm","model":"gpt-4.1-mini"},"reason":"phase implement","failures":0,"estimatedInputTokens":7616,"outcome":"success"}
```

`event` is `route`, `fallback`, `stop`, or `escalate`. `estimatedCostDelta` is present when both routes declare prices. The file is created with mode `0600`; an empty `auditPath` disables file output.

## API

```ts
ctx.virtualRouter.escalate(agent, 'reason')
ctx.virtualRouter.forceTier(agent, 'strong')
ctx.virtualRouter.noteTurn(sessionId, turn)
ctx.virtualRouter.snapshot(sessionId)
ctx.virtualRouter.recentAudit(limit)
```

`escalate` is used by `dsh-plugin-durable-exec` when its circuit breaker opens, if both plugins are installed.

## Test

```bash
pnpm test
```

The suite covers phase routing, sticky turns, escalation, budget stop, budget downgrade, configured fallback codes, pre-content fallback, refusal to fall back after content, and a budget stop that never calls a provider.
