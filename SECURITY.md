# Security policy

## Supported versions

Security fixes are applied to the latest release on the `main` branch. These plugins are pre-1.0 and do not maintain backport branches.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately through GitHub's **Security → Report a vulnerability** form on this repository, or email the maintainer listed in `package.json`.

Include:

- the affected plugin and version,
- the DSH version and Node version,
- a minimal reproduction,
- the impact you believe is possible.

You should receive an acknowledgement within a few days. Please allow time for a fix before public disclosure.

## What these plugins touch

| Plugin | Data written | Location |
| --- | --- | --- |
| `durable-exec` | Tool arguments, results, errors, checkpoints, Git HEAD | `databasePath` (default `$DSH_HOME/durable-exec/ledger.db`) |
| `context-longevity` | In-memory deferred-tool state; no session events | Process memory |
| `virtual-router` | Routing metadata, token estimates, optional cost estimates | `auditPath` (default `$DSH_HOME/virtual-router/audit.jsonl`) |

The ledger and audit file are created with POSIX mode `0600`. The ledger may contain file contents, command output, or credentials echoed by a tool. Treat it as sensitive as the DSH session log.

## Security properties

- The plugins do not bypass the DSH sandbox, approval flow, or permission presets.
- They do not append custom session events and do not rewrite existing history.
- SQL uses bound parameters; tool names and arguments are never interpolated into SQL.
- The router never records message content in the audit file.
- All timers, listeners, database handles, and adapter registrations are released through `ctx.effect()` disposal.
- Provider fallback is limited to errors before the first content delta, so a partial response is not silently replaced.

## Known limitations

- Tool results are stored unredacted. A secret printed by `bash` will be present in the ledger until you delete the database.
- Cache warming, when enabled, sends the request prefix to the configured provider. It is off by default.
- Auto-resume resumes interrupted root sessions automatically. Disable `autoResume.enabled` if an unattended restart must never continue work without a human.
- The router's phase detection is heuristic and can misclassify a turn. Use `forceTier` or explicit `phaseRoutes` when predictability matters more than cost.
