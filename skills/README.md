# Skills

Reusable operating instructions for DSH agents. A skill is Markdown plus
frontmatter, not itself a Cordis plugin: it tells an agent when and how to use a
capability, while the capability itself is installed separately.

## Available skills

| Skill | Use it for |
| --- | --- |
| [`antigravity-acp`](antigravity-acp) | Delegating a self-contained task to Google Antigravity CLI (`agy acp`) through DSH's official `@deepseek-ai/dsh-subagent-acp` backend. |

## Install

Copy or symlink a skill into the filesystem skill root that your DSH profile
loads. For example, when the profile uses `~/.agents/skills`:

```bash
mkdir -p ~/.agents/skills
ln -s "$(pwd)/skills/antigravity-acp" ~/.agents/skills/antigravity-acp
```

If your setup discovers skills through another root, such as
`~/.hermes/skills`, link it there instead (or as well):

```bash
mkdir -p ~/.hermes/skills/autonomous-ai-agents
ln -s "$(pwd)/skills/antigravity-acp" \
  ~/.hermes/skills/autonomous-ai-agents/antigravity-acp
```

A symlink keeps the repository as the source of truth. A copy works too, but
then the two can drift.

## Relationship to the plugins

The `plugins/` packages extend the DSH runtime through Cordis. The skill in
this directory only documents a composition built from official DSH packages
(`@deepseek-ai/dsh-subagent-acp` and `@deepseek-ai/dsh-tool-subagent`) and the
external `agy` CLI. Installing the skill does not install those packages, and
installing those packages does not install the skill.

[`dsh-plugin-antigravity-acp`](../plugins/antigravity-acp) is the packaged
form: it registers this skill from an embedded copy and, when the optional
official packages are installed, mounts the ACP provider and a
`subagent_antigravity` tool. The embedded copy and this directory must stay
byte-identical; the plugin test enforces that.
