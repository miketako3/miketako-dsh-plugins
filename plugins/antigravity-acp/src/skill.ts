/**
 * Embedded skill loading for the Antigravity ACP integration.
 *
 * @module dsh-plugin-antigravity-acp/skill
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { Config } from './config.ts'

/** Absolute path to the packaged skill body. */
export const SKILL_PATH = fileURLToPath(new URL('../assets/SKILL.md', import.meta.url))

/**
 * Remove a leading YAML frontmatter block from a skill document.
 * @param text - raw SKILL.md contents.
 * @returns the Markdown body without frontmatter.
 */
export function stripFrontmatter(text: string): string {
  const normalized = text.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return normalized
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return normalized
  return normalized.slice(end + 5).replace(/^\n+/, '')
}

/**
 * Read and prepare the packaged skill body for the current configuration.
 * @param config - resolved plugin configuration.
 * @returns Markdown content with a plugin-specific installation note.
 */
export function loadSkillContent(config: Config): string {
  const body = stripFrontmatter(readFileSync(SKILL_PATH, 'utf8'))
  const intro = [
    '> Installed by `dsh-plugin-antigravity-acp`.',
    `> With \`autoConfigure\` enabled (the default), this plugin mounts \`${config.backendModule}\``,
    `> as the \`${config.providerName}\` provider and \`${config.toolModule}\` as the`,
    `> \`${config.toolName}\` tool when those optional packages are installed. Configure`,
    '> `command`, `env`, and `permission` on the `antigravity-acp` row. The manual rows',
    '> below are the fallback when only the standalone skill is installed.',
  ].join(' ')
  return `${intro}\n\n${body}`
}

/**
 * Register the embedded skill on the calling context.
 * @param ctx - plugin context with the `skills` service.
 * @param config - resolved plugin configuration.
 * @returns the registration disposer.
 */
export function registerSkill(ctx: Context, config: Config): () => void {
  return ctx.skills.register({
    name: config.skillName,
    description: config.skillDescription,
    source: 'bundled',
    path: SKILL_PATH,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('..', import.meta.url)) },
    content: loadSkillContent(config),
    invocation: { modelInvocable: true, userInvocable: true },
  })
}
