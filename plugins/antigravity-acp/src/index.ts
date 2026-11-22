/**
 * Antigravity ACP integration for the DeepSeek Harness.
 *
 * The plugin always registers the `antigravity-acp` skill. When the official
 * ACP backend and `dsh-tool-subagent` packages are installed, it mounts them as
 * child plugins so one installable row yields a callable
 * `subagent_antigravity` tool. Missing optional packages downgrade the plugin
 * to the skill alone instead of breaking profile startup.
 *
 * @module dsh-plugin-antigravity-acp
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { Config } from './config.ts'
import { registerSkill } from './skill.ts'

export { Config, type Config as AntigravityAcpConfig } from './config.ts'
export { loadSkillContent, registerSkill, SKILL_PATH, stripFrontmatter } from './skill.ts'

/** Plugin name. */
export const name = 'antigravity-acp'

/** The skill registry is always needed; optional modules bring their own injects. */
export const inject = ['skills']

/** Module namespace shape accepted by `ctx.plugin`. */
type OptionalModule = Plugin<unknown> & {
  Config?: (value: unknown) => unknown
}

/**
 * Resolve from the profile that loaded this plugin, not from this package.
 * A profile install keeps the optional modules beside the host; resolving from
 * here avoids picking up a second copy of Cordis in a development checkout.
 * @param ctx - plugin context carrying the profile base URL.
 * @param specifier - package name or importable URL.
 * @returns the module namespace.
 */
async function importOptional(ctx: Context, specifier: string): Promise<OptionalModule> {
  let resolved: string | undefined
  if (ctx.baseUrl !== undefined) {
    try {
      resolved = createRequire(new URL('package.json', ctx.baseUrl)).resolve(specifier)
    } catch {
      // Fall back to normal resolution so data URLs and direct test imports work.
    }
  }
  const module = await import(resolved === undefined ? specifier : pathToFileURL(resolved).href) as OptionalModule
  if (typeof module !== 'function' && typeof module.apply !== 'function') {
    throw new TypeError(`${specifier} does not export a Cordis plugin`)
  }
  return module
}

/**
 * Mount the official ACP provider and tool, logging a setup hint when either
 * optional package is missing. Failure never aborts the skill registration.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
async function mountOptional(ctx: Context, config: Config): Promise<void> {
  let backend: OptionalModule
  try {
    backend = await importOptional(ctx, config.backendModule)
  } catch (error) {
    ctx.logger.warn(
      `antigravity-acp: ${config.backendModule} is not installed; registered the skill only. `
      + `Install it with: dsh plugin --profile <profile> add ${config.backendModule}`,
    )
    ctx.logger.warn(error)
    return
  }

  try {
    await ctx.plugin(backend, {
      providerName: config.providerName,
      command: config.command,
      args: config.args,
      permission: config.permission,
      env: config.env,
      disposeEofGraceMs: config.disposeEofGraceMs,
      disposeGraceMs: config.disposeGraceMs,
    })
  } catch (error) {
    ctx.logger.warn(`antigravity-acp: failed to mount ${config.backendModule}`)
    ctx.logger.warn(error)
    return
  }

  let tool: OptionalModule
  try {
    tool = await importOptional(ctx, config.toolModule)
  } catch (error) {
    ctx.logger.warn(
      `antigravity-acp: ${config.toolModule} is not installed; provider ${config.providerName} `
      + `is registered but no ${config.toolName} tool exists.`,
    )
    ctx.logger.warn(error)
    return
  }

  try {
    await ctx.plugin(tool, {
      provider: config.providerName,
      toolName: config.toolName,
      // The ACP provider has no model-selection or depthLimit capability; the
      // child manages both, so DSH-side budgets would be unenforceable.
      modelSelection: false,
      maxDepth: 'provider-managed',
    })
  } catch (error) {
    ctx.logger.warn(`antigravity-acp: failed to mount ${config.toolModule}`)
    ctx.logger.warn(error)
  }
}

/**
 * Register the skill and, when enabled, the optional ACP provider/tool pair.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.effect(() => registerSkill(ctx, config), 'antigravity-acp:skill')
  if (config.autoConfigure) await mountOptional(ctx, config)
}
