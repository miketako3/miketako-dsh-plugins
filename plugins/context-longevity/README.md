# dsh-plugin-context-longevity

Three context controls for long DSH sessions: deferred tool loading, structured compaction, and optional cache warming.

## Install

```bash
pnpm build
dsh plugin --profile my-profile add /absolute/path/to/plugins/context-longevity
```

The bundle patch inserts the `context-longevity` row, which provides deferred tools and cache warming. Structured compaction is a separate row because it extends the host's `BasicCompactionEngine`.

## Deferred tool loading

When more than `threshold` global tools are registered, each root agent sees an always-active core plus tools loaded on demand:

- `discover_tools({ query?, limit? })` — rank hidden tools by name and description.
- `activate_tools({ tools: [...] })` — make named tools visible for the rest of the session.

Activation is plugin state, so it survives compaction. The restriction is installed with `agent.ctx.tools.restrict({ allow })`; registry entries are not removed, and agent-scoped tools are exempt.

```yaml
- id: context-longevity
  config:
    deferredTools:
      enabled: true
      threshold: 20
      maxActive: 28
      discoverLimit: 25
      alwaysActive:
        - read
        - write
        - edit
        - bash
        - glob
        - grep
        - todo_write
        - present
        - job_list
        - job_output
        - job_kill
        - discover_tools
        - activate_tools
      prompt: true
```

A live run with 27 tools reported `12 visible, 15 deferred`.

## Structured compaction

`dsh-plugin-context-longevity/compaction` subclasses `BasicCompactionEngine`. It appends an explicit output contract to the summarization call and deterministically retains facts the model omitted.

Required headings:

1. Primary Request and Intent
2. Decisions and Constraints
3. Files and Code
4. Verification
5. Open Issues
6. Next Step

The engine also appends file paths and shell commands observed in the summarized region, and adds `## Retained Facts` only when a required heading is missing.

Wire it as a replacement row:

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

`compaction-basic` cannot accept extra keys, so it must be disabled separately. The structured options live on the `context-longevity` row:

```yaml
- id: context-longevity
  config:
    structuredCompaction:
      instruction: true
      retainFiles: true
      retainCommands: true
      maxRetainedFiles: 40
      maxRetainedCommands: 10
```

If the compaction row runs without the `context-longevity` service row, it falls back to the same defaults. In a web profile, edit the `compaction-basic` row in each agent preset you use.

## Cache warming

Disabled by default. During a long tool call, send a one-token request with the same system prompt, tools, and message prefix so the next step hits a warm provider prefix cache.

```yaml
- id: context-longevity
  config:
    cacheWarming:
      enabled: true
      delayMs: 2000
      intervalMs: 60000
      maxWarmingsPerTurn: 3
      maxMessages: 400
      maxTokens: 1
```

Warming skips nested PTC calls and is cancelled when the tool returns. It costs provider tokens; enable it only when cached reads are materially cheaper.

## Test

```bash
pnpm test
```

The suite covers tool ranking, allow-list composition, activation limits, heading retention, file/command extraction, and cache-warming gating.
