/**
 * Context longevity for the DeepSeek Harness.
 *
 * Three independent capabilities share one host service:
 * - deferred tool loading keeps a large registry out of every request,
 * - structured compaction retains files, verification, open issues, and the
 *   next action across a context replacement,
 * - cache warming refreshes a provider prefix during long tool calls.
 *
 * @module dsh-plugin-context-longevity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import type { Config as LongevityConfig } from './config.ts'
import { DeferredToolController } from './deferred.ts'
import { ContextLongevityService } from './service.ts'
import { CacheWarmer } from './warming.ts'

export { Config } from './config.ts'
export type {
  CacheWarmingConfig,
  Config as ContextLongevityConfig,
  DeferredToolsConfig,
  StructuredCompactionConfig,
} from './config.ts'
export { collectCommands, collectFilePaths, enrichSummary, StructuredCompactionEngine } from './compaction.ts'
export { composeAllowList, CONTROL_TOOLS, DeferredToolController, rankTools } from './deferred.ts'
export type { ActivationResult, DiscoveredTool, DiscoveryResult } from './deferred.ts'
export { ContextLongevityService } from './service.ts'
export type { ContextLongevityOptions } from './service.ts'
export { CacheWarmer } from './warming.ts'

/** Plugin name. */
export const name = 'context-longevity'

/** Services used by the deferred registry, prompt section, and warmer. */
export const inject = ['tools', 'agents', 'systemPrompt', 'llm']

function renderDiscovery(value: {
  tools: readonly { name: string; description: string; active: boolean }[]
  total: number
  activeCount: number
  deferredCount: number
}): string {
  if (value.tools.length === 0) {
    return `No matching deferred tools. ${value.activeCount}/${value.total} tools are visible.`
  }
  const lines = value.tools.map(tool => `${tool.active ? '[active]' : '[hidden]'} ${tool.name}: ${tool.description}`)
  return [
    `Showing ${value.tools.length} of ${value.total} tools (${value.activeCount} visible, ${value.deferredCount} deferred).`,
    ...lines,
    'Call activate_tools with exact names to load hidden tools.',
  ].join('\n')
}

function renderActivation(value: {
  activated: readonly string[]
  alreadyActive: readonly string[]
  unknown: readonly string[]
  overLimit: readonly string[]
  activeCount: number
}): string {
  const lines: string[] = []
  if (value.activated.length > 0) lines.push(`Activated: ${value.activated.join(', ')}`)
  if (value.alreadyActive.length > 0) lines.push(`Already active: ${value.alreadyActive.join(', ')}`)
  if (value.unknown.length > 0) lines.push(`Unknown tools: ${value.unknown.join(', ')}`)
  if (value.overLimit.length > 0) lines.push(`Over the visible-tool limit: ${value.overLimit.join(', ')}`)
  lines.push(`${value.activeCount} tools are now visible.`)
  return lines.join('\n')
}

/**
 * Mount the plugin.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: LongevityConfig): void {
  new ContextLongevityService(ctx, { structuredCompaction: config.structuredCompaction })
  const controller = new DeferredToolController(ctx, config.deferredTools)
  const warmer = new CacheWarmer(ctx, config.cacheWarming)

  ctx.effect(() => () => warmer.dispose(), 'context-longevity:cache-warmer')
  ctx.effect(() => () => controller.dispose(), 'context-longevity:deferred-state')

  if (config.deferredTools.enabled) {
    ctx.tools.register(defineTool({
      name: 'discover_tools',
      description: [
        'Search the full tool catalog when the tool you need is not currently visible.',
        'Returns tool names and descriptions without loading their schemas into context.',
        'Use activate_tools with exact names from the result to make them callable.',
      ].join(' '),
      parameters: {
        query: {
          type: 'string',
          description: 'Optional case-insensitive words matched against tool names and descriptions.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 25).',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  active: { type: 'boolean', required: true },
                },
                additionalProperties: false,
              },
              required: true,
            },
            total: { type: 'number', required: true },
            activeCount: { type: 'number', required: true },
            deferredCount: { type: 'number', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: renderDiscovery(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return controller.discover(exec.agent, args.query, args.limit ?? config.deferredTools.discoverLimit)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'activate_tools',
      description: [
        'Load hidden tools into this session so they become callable on the next step.',
        'Pass exact names returned by discover_tools. Activated tools stay visible after compaction.',
      ].join(' '),
      parameters: {
        names: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Exact tool names to activate.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            activated: { type: 'array', items: { type: 'string' }, required: true },
            alreadyActive: { type: 'array', items: { type: 'string' }, required: true },
            unknown: { type: 'array', items: { type: 'string' }, required: true },
            overLimit: { type: 'array', items: { type: 'string' }, required: true },
            activeCount: { type: 'number', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: renderActivation(value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (exec.agent === undefined) {
          return { activated: [], alreadyActive: [], unknown: [...args.names], overLimit: [], activeCount: 0 }
        }
        return controller.activate(exec.agent, args.names)
      },
    }))
  }

  const attach = (agent: Agent): void => {
    try {
      controller.attach(agent)
    } catch (error) {
      ctx.logger.warn(`context-longevity: failed to attach deferred tools to ${agent.session.id}`)
      ctx.logger.warn(error)
    }
  }

  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => {
    attach(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    controller.detach(agent)
  })
  ctx.on('tools/change', () => {
    try {
      controller.reconcile()
    } catch (error) {
      ctx.logger.warn('context-longevity: deferred tool reconciliation failed')
      ctx.logger.warn(error)
    }
  })

  if (config.cacheWarming.enabled) {
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.parent !== undefined) return next()
      const stop = warmer.begin(exec.agent)
      try {
        return await next()
      } finally {
        stop()
      }
    })
  }
}
