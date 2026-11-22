# dsh-plugin-antigravity-acp

Antigravity CLI (`agy acp`) delegation for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

The plugin packages two things in one installable Cordis row:

- the **`antigravity-acp` skill**, which teaches an agent when to delegate, how
  to write a standalone prompt, how authentication reaches the child, and how
  to debug ACP failures;
- an **optional auto-mount** of the official
  [`@deepseek-ai/dsh-subagent-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-acp)
  provider and a `dsh-tool-subagent` instance named `subagent_antigravity`.

DSH still owns the ACP protocol implementation. This package does not vendor
`agy`, the official backend, or Antigravity credentials.

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0` (verified against `0.2.2-rc.5`)
- Node.js `>=24.9.0`
- `agy` with ACP support (`agy acp --help` must show `--sandbox`)
- Official `@deepseek-ai/dsh-subagent-acp` in the profile for the auto-mounted
  provider. The standard Web bundle already ships `dsh-tool-subagent`.
- One authentication path: an existing `agy` login cache, or
  `GEMINI_API_KEY` in the parent environment for explicit forwarding

Check the CLI first:

```bash
agy acp --help
which agy
```

## Install

Install the ACP backend and this plugin into the same profile:

```bash
dsh plugin --profile my-profile add @deepseek-ai/dsh-subagent-acp
dsh plugin --profile my-profile add /absolute/path/to/miketako-dsh-plugins/plugins/antigravity-acp
```

If the published backend version does not match your DSH build, install the
copy from the DSH source checkout this profile loads. Do not install a second
`@deepseek-ai/cordis` or `@deepseek-ai/dsh-agent`; those must stay shared with
the host.

Set `command` to the absolute path from `which agy` in the generated row. A bare
`agy` works only when the DSH process itself has that directory on `PATH`.

## Configuration

The bundle patch inserts this profile row:

```yaml
- id: antigravity-acp
  name: 'dsh-plugin-antigravity-acp'
  config:
    providerName: antigravity
    toolName: subagent_antigravity
    command: agy
    args:
      - acp
      - --sandbox
      - --disable-telemetry
    permission: reject
```

Edit the installed profile row (or the package's `cordis.patch.yml`) to change
`command`, `env`, or `permission`.

| Field | Default | Meaning |
| --- | --- | --- |
| `providerName` | `antigravity` | Provider name registered on `ctx.subagents`. |
| `toolName` | `subagent_antigravity` | Model-facing tool name, distinct from `subagent` and `subagent_fork`. |
| `command` | `agy` | ACP server executable. Prefer an absolute path. |
| `args` | `acp --sandbox --disable-telemetry` | Arguments passed to `command`. |
| `permission` | `reject` | `reject` declines every ACP permission request; `allow` picks the first allow option. No human dialog appears. |
| `env` | `{}` | Explicit child environment. Use this for `GEMINI_API_KEY`; DSH scrubs credential-looking parent variables. |
| `backendModule` | `@deepseek-ai/dsh-subagent-acp` | Module imported for the provider. |
| `toolModule` | `@deepseek-ai/dsh-tool-subagent` | Module imported for the tool instance. |
| `autoConfigure` | `true` | Mount the two optional modules when they import. Set `false` to register only the skill. |
| `skillName` | `antigravity-acp` | Embedded skill name. |
| `skillDescription` | built-in | Skill routing description shown in the catalog. |
| `disposeEofGraceMs` | `6000` | EOF quiesce grace forwarded to the backend. |
| `disposeGraceMs` | `3000` | Failure observation and SIGTERM-to-SIGKILL grace forwarded to the backend. |

API-key configuration:

```yaml
- id: antigravity-acp
  config:
    command: /absolute/path/to/agy
    env:
      GEMINI_API_KEY: !!js process.env.GEMINI_API_KEY
```

`!!js` is evaluated only inside Cordis entry `config`, not in `disabled` or
other entry metadata. The key is read from the parent process and layered over
the scrubbed child environment. Do not paste a literal key into the patch file.

## Behavior

1. The plugin registers the embedded skill. This always succeeds.
2. With `autoConfigure: true`, it dynamically imports `backendModule` and mounts
   it as a child plugin with the provider configuration.
3. It then imports `toolModule` and mounts a tool instance bound to
   `providerName` and `toolName`. The tool row sets `modelSelection: false` and
   `maxDepth: provider-managed`, because the ACP provider advertises neither
   model discovery nor a depth-limit capability.
4. If either optional package is missing, the plugin logs an actionable warning
   and keeps the skill. Profile startup is not broken by a missing optional
   dependency.
5. Disposing the row disposes the child provider and tool through Cordis.

The model calls the configured tool directly:

```text
subagent_antigravity(
  description="Review the auth boundary",
  cwd="/absolute/path/to/repo",
  prompt="Repository: /absolute/path/to/repo\nTask: ...\nConstraints: read-only...\nOutput: ..."
)
```

The ACP child does not inherit the parent conversation, DSH tools, or system
prompt. Every delegation must be self-contained.

The plugin row is enough once the optional modules are installed. The manual
fallback rows in the skill remain valid for a skill-only install; they now
include the same `modelSelection: false` and `maxDepth: provider-managed`
settings.

## Why the skill is also standalone

The same `SKILL.md` is available at
[`skills/antigravity-acp`](../../skills/antigravity-acp) for users who configure
the official backend and tool rows manually. The plugin embeds a byte-identical
copy in `assets/SKILL.md`; a test fails if the two drift.

## Permission model

- `permission: reject` is the safe default for review. It also rejects shell
  commands that request permission, so do not expect `git` or test commands to
  run.
- `permission: allow` auto-approves the first `allow_once` / `allow_always`
  option. Keep `--sandbox` in `args`, prefer a clean worktree or disposable copy,
  and review the diff. There is no human approval step inside ACP.

Use `permission: reject` for "summarize this repository" and
`permission: allow` only when the task needs edits or commands.

## Verify

1. Start DSH with the profile and confirm no `antigravity-acp` warning appears.
2. Ask the parent to use the `antigravity-acp` skill; the catalog should load it.
3. Delegate `Reply with exactly OK` through `subagent_antigravity`.
4. If the run fails, inspect `~/.gemini/antigravity-cli/log/acp-*.log`, or add
   `--cli_log_file /absolute/path/to/acp.log` to `args`.

| Symptom | Action |
| --- | --- |
| `subagent_antigravity` missing | Install `@deepseek-ai/dsh-tool-subagent` and reload; check the tool name. |
| Provider missing | Install `@deepseek-ai/dsh-subagent-acp`; check `backendModule`. |
| `spawn ENOENT` | Set `command` to the absolute path from `which agy`. |
| Authentication error | Add `env.GEMINI_API_KEY: !!js process.env.GEMINI_API_KEY` or use `agy` login cache. |
| Child cannot edit or run commands | `permission: reject`; switch to `allow` with `--sandbox`. |
| Start-time option rejected | ACP supports no `agentPreset`, `agentOptions`, `outputSchema`, or depth cap. Remove them. |

## Limitations

- The official ACP backend is not bundled and is not a hard dependency. Without
  it the plugin is a skill provider only.
- `agy` and its ACP flags are external interfaces and can change; rerun
  `agy acp --help` after upgrades.
- The child's tool traffic stays in its own ACP log. The parent receives only
  the final text, so the task prompt must ask for evidence and a change summary.
- The ACP provider cannot enforce DSH's numeric `maxDepth`, `agentPreset`, or
  `outputSchema`; the tool mounts with `maxDepth: provider-managed` and the ACP
  child owns its own recursion. Do not add a numeric `maxDepth` to the row.
- `permission: allow` plus `--sandbox` is a child-side restriction, not a DSH
  permission guarantee.

## License

MIT. See [LICENSE](../../LICENSE).
