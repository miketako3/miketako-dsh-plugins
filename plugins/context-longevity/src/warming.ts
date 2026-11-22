/**
 * Cache warming during long tool calls.
 *
 * Providers keep a prefix cache warm for a short time after the last matching
 * request. A long tool call can exceed that window, forcing the next request to
 * re-prefill the whole conversation. While a tool is running, this scheduler
 * periodically replays the current durable prefix with a one-token output cap,
 * so the next real request still finds a warm prefix.
 *
 * Warming is off by default: it costs a small request per interval, and only
 * providers with prefix caching benefit.
 *
 * @module dsh-plugin-context-longevity/warming
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { CacheWarmingConfig } from './config.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap {
    /** Periodic prefix-cache refresh issued while a tool is running. */
    'cache-warm': true
  }
}

/** Scheduler bound to one plugin lifecycle. */
export class CacheWarmer {
  private readonly active = new Set<AbortController>()
  private readonly sessionsInFlight = new Set<string>()

  /**
   * @param ctx - plugin context with the LLM service.
   * @param config - warming options.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: CacheWarmingConfig,
  ) {}

  /**
   * Start warming for one tool execution.
   * @param agent - calling agent, when the call belongs to one.
   * @returns a stopper for the tool's completion.
   */
  begin(agent: Agent | undefined): () => void {
    if (!this.config.enabled || agent === undefined || this.config.maxWarmingsPerTurn <= 0) {
      return () => {}
    }
    const controller = new AbortController()
    this.active.add(controller)
    let warmings = 0
    let timer: NodeJS.Timeout | undefined

    const schedule = (delay: number): void => {
      if (controller.signal.aborted || warmings >= this.config.maxWarmingsPerTurn) return
      timer = setTimeout(() => {
        timer = undefined
        void (async () => {
          if (controller.signal.aborted) return
          warmings += 1
          await this.warm(agent, controller.signal)
          if (!controller.signal.aborted && warmings < this.config.maxWarmingsPerTurn) {
            schedule(this.config.intervalMs)
          }
        })()
      }, delay)
      timer.unref()
    }
    schedule(this.config.delayMs)

    return () => {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
      this.active.delete(controller)
    }
  }

  /** Abort every in-flight warm request. */
  dispose(): void {
    for (const controller of this.active) controller.abort()
    this.active.clear()
  }

  private async warm(agent: Agent, signal: AbortSignal): Promise<void> {
    const sessionId = agent.session.id
    if (this.sessionsInFlight.has(sessionId)) return
    this.sessionsInFlight.add(sessionId)
    try {
      const messages = agent.session.deriveMessages()
      if (messages.length === 0 || messages.length > this.config.maxMessages) return
      const selection = agent.model.current() ?? agent.session.requestHeader()?.config
      if (selection === undefined || selection.provider.length === 0 || selection.model.length === 0) return
      const assembly = await this.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      this.ctx.logger.info(`context-longevity: warming ${messages.length} messages with ${assembly.tools.length} tools`)
      const stream = this.ctx.llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        messages,
        system: renderPrompt(assembly),
        tools: assembly.tools,
        maxTokens: this.config.maxTokens,
        signal,
        sessionId,
        purpose: 'cache-warm' as never,
      })
      for await (const chunk of stream) {
        if (signal.aborted) break
        void chunk
      }
    } catch (error) {
      if (!signal.aborted) {
        this.ctx.logger.debug('context-longevity: cache warm request failed')
        this.ctx.logger.debug(error)
      }
    } finally {
      this.sessionsInFlight.delete(sessionId)
    }
  }
}
