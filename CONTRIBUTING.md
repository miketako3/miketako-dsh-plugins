# Contributing

Thanks for improving long-horizon DSH behavior. This repository is a pnpm workspace; each plugin under `plugins/` is an independent package.

## Setup

```bash
pnpm install
pnpm check
```

`pnpm check` runs typecheck, tests, and build for every package. Node 24.9 or newer is required because the durable ledger uses the built-in `node:sqlite` module.

## Layout

```
plugins/<name>/
  src/
    index.ts        # Cordis plugin entry
    config.ts       # Schemastery schema and defaults
    ...             # focused modules
  test/             # Vitest suites
  cordis.patch.yml  # bundle row appended by `dsh plugin add`
  README.md
```

## Rules that are not negotiable

1. **Never rewrite session history.** DSH session records are append-only. Add state in plugin memory, SQLite, or JSONL instead of inventing session events.
2. **Never bypass the sandbox or permissions.** Do not call privileged operations to avoid an approval; use the host tool pipeline.
3. **Use `ctx.effect()` for every resource** — timers, listeners, database handles, adapter registrations, tool restrictions, system-prompt sections. A plugin unload must leave no residue.
4. **Use the Cordis contract**: `name`, `inject`, `Config`, `apply`. A class service is fine, but it must still declare `inject` and `Config` and register through the context.
5. **Replace built-ins by disabling, never by renaming.** A profile patch disables the built-in row and inserts a new row:

   ```yaml
   - id: compaction-basic
     disabled: true
   - id: compaction-longevity
     name: dsh-plugin-context-longevity/compaction
   ```

6. **Do not add a runtime dependency that duplicates Cordis or DSH services.** Those packages must be peers so service identity is shared. Leaf data packages may be regular dependencies.

## Writing a change

- Keep routing, compaction, and ledger logic in pure functions where possible; the plugin entry should wire them, not implement policy.
- Add a regression test that fails before the change. Tests use real `node:sqlite` for the ledger and a fake `LlmAdapter` for routing.
- Document new configuration keys in the plugin README and, when user-visible, in the root README.
- If a change alters the bundle patch shape, update `cordis.patch.yml` and mention the migration in the pull request.

## Commit and pull request

- One logical change per pull request.
- Include the commands you ran and their results.
- Note any live verification (profile, provider, DSH version) separately from unit tests.
- By contributing, you agree that your contribution is licensed under the MIT license.

## Reporting bugs

Include the plugin version, DSH version, Node version, the profile patch rows involved, and the smallest reproduction. Redact API keys, file contents, and anything else sensitive from logs and ledger excerpts.
