---
name: antigravity-acp
description: "Delegate a self-contained task to Google Antigravity CLI (`agy acp`) as an isolated DSH subagent; covers DSH ACP config, auth, permissions, prompts, and debugging."
version: 1.0.0
author: Kaito Hiruta
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [Delegation, Antigravity, Gemini, ACP, Subagent, Code-Review]
    related_skills: [agent-delegation, codex, claude-code, opencode]
category: autonomous-ai-agents
---

# Antigravity ACP subagent

Use DSH's official `@deepseek-ai/dsh-subagent-acp` provider to run
[Google Antigravity CLI](https://antigravity.google/docs/ide/extensions/acp/)
(`agy acp`) as an out-of-process child worker.

The child gets its own process, session, model, and tools. The parent supplies
only a task and a working directory. The parent sees the child's final
assistant text; intermediate messages and tool traffic stay in the child's ACP
log and do not enter the parent conversation.

This skill is for **DeepSeek Harness**, not Hermes' own `delegate_task` tool.

If `dsh-plugin-antigravity-acp` is installed, it registers this skill and
mounts the provider and tool automatically when the official packages are
present. Configure `command`, `env`, and `permission` on the plugin row, then
skip the manual [Mount](#mount-the-provider-and-a-tool) section. The manual
rows remain the fallback for a skill-only install.

## When to use

- A read-only investigation, repository summary, design review, or second
  opinion where an independent runtime is useful.
- Work you want isolated from the parent's tools and context.
- Delegating to Gemini/Antigravity quota instead of the parent model.
- A task that fits in one standalone prompt and returns one text answer.

Do not use it when the child must see the parent conversation, use DSH-only
tools, honor an agent preset, return structured JSON, or be depth-capped. The
ACP provider rejects those requests and inherits no parent history. Use the
in-process `subagent`/`subagent_fork` backends for those cases.

## Preflight

```bash
agy acp --help
which agy
```

`agy acp --help` must show `--sandbox`; a bare `agy` without the `acp`
subcommand is not an ACP server. Resolve the absolute path now; the child is
spawned without a login shell, so `agy` on `PATH` is not enough.

Choose one authentication mode:

- **Login cache (simplest):** sign in once with `agy` or `agy acp --login`,
  then let the child reuse the cached session. Do not pass an API key.
- **API key:** export `GEMINI_API_KEY` in the parent environment and forward it
  explicitly through the row's `config.env`. DSH scrubs credential-looking
  parent variables before spawning the child, so inheritance alone will not
  work. Never paste the key literally into the patch file.

## Mount the provider and a tool

Install the ACP backend into the profile first. The standard Web bundle already
ships `dsh-tool-subagent`, so normally only the ACP provider is missing:

```bash
dsh plugin --profile web add @deepseek-ai/dsh-subagent-acp
```

Both rows below are required. The provider row only registers `antigravity` on
`ctx.subagents`; it does not create a model-facing tool. A `tool-subagent`
instance binds to exactly one provider, so add a second instance with a
distinct tool name.

Append to the active profile patch, normally
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: subagent-acp-antigravity
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: antigravity
    command: /absolute/path/to/agy      # output of `which agy`
    args:
      - acp
      - --sandbox
      - --disable-telemetry
    permission: reject                  # reject | allow
    env:
      GEMINI_API_KEY: !!js process.env.GEMINI_API_KEY
    disposeEofGraceMs: 6000
    disposeGraceMs: 3000

- id: tool-subagent-antigravity
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: antigravity
    toolName: subagent_antigravity
    modelSelection: false
    maxDepth: provider-managed
```

Notes:

- `!!js` is evaluated only inside a Cordis entry's `config`, not in `disabled`
  or other entry metadata. The expression above reads the parent process at
  mount time; the key is then layered over the scrubbed child environment.
- If you use the login cache, omit the `env` block entirely.
- Do not set `agentPreset`, `agentOptions`, `outputSchema`, or `depthLimit`.
  The ACP provider advertises no support for them and rejects the run before
  spawn. The tool row keeps `modelSelection: false` for the same reason.
- `maxDepth: provider-managed` is required: the ACP provider cannot enforce a
  numeric DSH recursion budget. A numeric `maxDepth` (including the default)
  makes the tool row fail to mount.
- `permission: reject` blocks every ACP permission request. That is the safe
  default for review, but it can also block shell commands the child would use
  for `git` or tests. If the task needs commands, switch to `allow` **and**
  keep `--sandbox`; review the resulting workspace diff before trusting it.
- `permission: allow` auto-selects the first `allow_once`/`allow_always`
  option. There is no human approval dialog. Run it against a clean worktree
  or a disposable copy, never against uncommitted work you cannot restore.
- Profile row changes take effect after the DSH process reloads that profile.
  Restart the Web host or start a new session with the changed profile; do not
  assume a live session picked up the new row.

## Delegate

Call the generated tool by its configured name:

```text
subagent_antigravity(
  description="Review the auth boundary",
  cwd="/absolute/path/to/repo",
  prompt="""
Repository: /absolute/path/to/repo
Task: Review the authentication boundary in src/auth/ and report concrete
risks. Do not edit files.
Constraints: read-only; no network; cite file:line for every claim.
Output: bullet list of findings, then a one-paragraph verdict.
"""
)
```

The prompt must be self-contained. Restate the repository path, the goal,
relevant background, constraints, and the exact output format. The child does
not see this conversation, prior tool results, or the parent's system prompt.
Prefer absolute paths and explicit file names over "the file we discussed".

For a review worker, ask for evidence (`path:line`) and tell it not to edit.
For an implementation worker, ask it to summarize changed files and commands
run, because that traffic is otherwise invisible to the parent.

## Verify

1. Confirm the tool appears in the parent's tool catalog after reload.
2. Send the smallest possible delegation first: `Reply with exactly OK`.
3. If that works, send a bounded read-only task against a small directory.
4. Inspect the Antigravity ACP log at
   `~/.gemini/antigravity-cli/log/acp-*.log`, or pass
   `--cli_log_file /absolute/path/to/acp.log` in `args` while debugging.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `spawn ENOENT` / child never starts | relative or wrong `command` | use the absolute path from `which agy` |
| Handshake timeout / immediate EOF | missing `acp` argument, incompatible `agy` | run `agy acp` manually, check `agy acp --help` |
| Authentication error after it worked in a terminal | parent key scrubbed | add `config.env.GEMINI_API_KEY: !!js process.env.GEMINI_API_KEY`, or use the login cache |
| Child cannot edit or run commands | `permission: reject` | use `permission: allow` with `--sandbox`, on a disposable tree |
| Provider row loaded but no tool exists | only the provider row was added | add the `tool-subagent` row with `provider: antigravity` and reload |
| Provider rejects start-time options | a preset, options, schema, or depth cap was supplied | remove them; ACP does not support them |
| No useful answer | task depended on parent context | rewrite as a standalone prompt with paths and facts |

Run `agy acp --help` again after upgrading Antigravity CLI; flags and the log
location can change between versions.

## Security

- Keep the profile patch at mode `0600`; it may contain `!!js` expressions but
  should not contain literal credentials.
- `--sandbox` is an Antigravity-side restriction, not a DSH permission
  guarantee. Treat the child as a separate agent with its own judgment.
- Review the child's final answer and any workspace diff before merging.
  ACP tool traffic is not in the parent session, so the final text is the
  only automatic record in the parent.
