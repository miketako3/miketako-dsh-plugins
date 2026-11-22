/**
 * Virtual model adapter.
 *
 * One provider route (`virtual` by default) advertises logical models. Each
 * request is routed to a physical provider/model, with in-request fallback and
 * per-turn stickiness so the provider prefix cache stays useful.
 *
 * @module dsh-plugin-virtual-router/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AuditSink } from './audit.ts'
import type { Config, RouteConfig } from './config.ts'
import type { RouterDecision, RouterEngine } from './router.ts'

type AttemptOutcome =
  | { kind: 'success'; usage?: TokenUsage; finishEmitted: boolean }
  | { kind: 'failure'; failure: LlmFailure; partial: boolean; finishEmitted: boolean; aborted: boolean }

function failureOf(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error.failure
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const message = typeof record['message'] === 'string' ? record['message'] : String(error)
    const code = typeof record['code'] === 'string' ? record['code'] : 'UNKNOWN'
    const status = typeof record['status'] === 'number' ? record['status'] : undefined
    return { message, code, ...status === undefined ? {} : { status } }
  }
  return { message: String(error), code: 'UNKNOWN' }
}

function routeLabel(route: RouteConfig | undefined): string {
  return route === undefined ? 'none' : `${route.provider}/${route.model}`
}

/**
 * Provider-wire adapter that delegates to physical routes.
 */
export class VirtualModelAdapter extends LlmAdapter {
  /**
   * @param ctx - plugin context carrying the LLM runtime.
   * @param engine - routing policy and state.
   * @param audit - audit sink.
   * @param config - resolved configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly engine: RouterEngine,
    private readonly audit: AuditSink,
    private readonly config: Config,
  ) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.config.displayName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const virtual = this.config.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: virtual?.name ?? model,
      ...virtual === undefined ? {} : { context: { contextWindow: virtual.contextWindow } },
      ...virtual?.description === undefined ? {} : { description: virtual.description },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId ?? 'anonymous'
    const before = this.engine.snapshot(sessionId)
    const decision = this.engine.decide({
      sessionId,
      turn: before.turn,
      model: options.model,
      ...options.purpose === undefined ? {} : { purpose: options.purpose },
      messages: options.messages as never,
      ...options.tools === undefined ? {} : { tools: options.tools },
    })

    if (decision.kind === 'stop') {
      this.audit.write({
        ts: Date.now(),
        event: 'stop',
        sessionId,
        turn: before.turn,
        phase: decision.phase,
        virtualModel: options.model,
        ...before.route === undefined ? {} : { from: before.route },
        reason: decision.reason,
        estimatedInputTokens: decision.estimatedInputTokens,
        outcome: 'blocked',
      })
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: decision.reason, code: 'BUDGET_EXCEEDED' },
        },
      }
      return
    }

    const candidates = this.candidates(decision)
    let lastFailure: LlmFailure | undefined
    let lastFinishEmitted = false

    for (let index = 0; index < candidates.length; index += 1) {
      const route = candidates[index]
      if (route === undefined) break
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
        return
      }
      if (index > 0) {
        this.audit.write({
          ts: Date.now(),
          event: 'fallback',
          sessionId,
          turn: before.turn,
          phase: decision.phase,
          virtualModel: options.model,
          ...candidates[index - 1] === undefined ? {} : { from: candidates[index - 1] },
          to: route,
          reason: lastFailure === undefined ? 'fallback' : `${lastFailure.code}: ${lastFailure.message}`,
          ...lastFailure === undefined ? {} : { failures: this.engine.stateOf(sessionId).failures },
          outcome: 'failure',
        })
      }

      const attempt = yield* this.attempt(options, route)
      lastFinishEmitted = attempt.finishEmitted
      if (attempt.kind === 'success') {
        // Input tokens are already accounted from the pre-request estimate;
        // add only the output so the token budget is not double counted.
        this.engine.recordSuccess(sessionId, route, attempt.usage?.outputTokens)
        this.audit.write({
          ts: Date.now(),
          event: 'route',
          sessionId,
          turn: before.turn,
          phase: decision.phase,
          ...options.purpose === undefined ? {} : { purpose: options.purpose },
          virtualModel: options.model,
          ...before.route === undefined ? {} : { from: before.route },
          to: route,
          reason: decision.reason,
          ...decision.estimatedCostDelta === undefined ? {} : { estimatedCostDelta: decision.estimatedCostDelta },
          estimatedInputTokens: decision.estimatedInputTokens,
          outcome: 'success',
        })
        return
      }

      lastFailure = attempt.failure
      this.engine.recordFailure(sessionId, route)
      if (attempt.aborted) {
        if (!attempt.finishEmitted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: attempt.failure } }
        }
        return
      }
      if (attempt.partial) {
        if (!attempt.finishEmitted) {
          yield { type: 'finish', reason: { kind: 'error', failure: attempt.failure } }
        }
        this.audit.write({
          ts: Date.now(),
          event: 'route',
          sessionId,
          turn: before.turn,
          phase: decision.phase,
          virtualModel: options.model,
          from: route,
          to: route,
          reason: `partial response failed: ${attempt.failure.code}`,
          outcome: 'failure',
        })
        return
      }
      const more = index + 1 < candidates.length
      if (more && this.engine.shouldFallback(attempt.failure.code, attempt.failure.status) && !attempt.finishEmitted) {
        continue
      }
      if (!attempt.finishEmitted) {
        yield { type: 'finish', reason: { kind: 'error', failure: attempt.failure } }
      }
      this.audit.write({
        ts: Date.now(),
        event: 'route',
        sessionId,
        turn: before.turn,
        phase: decision.phase,
        virtualModel: options.model,
        ...before.route === undefined ? {} : { from: before.route },
        to: route,
        reason: `${attempt.failure.code}: ${attempt.failure.message}`,
        outcome: 'failure',
      })
      return
    }

    if (!lastFinishEmitted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: lastFailure ?? { message: 'no candidate route produced a response', code: 'NO_ADAPTER' },
        },
      }
    }
  }

  private candidates(decision: Extract<RouterDecision, { kind: 'route' }>): RouteConfig[] {
    const primary = decision.route
    const seen = new Set([`${primary.provider}\u0000${primary.model}`])
    const fallbacks = this.engine.fallbackRoutes().filter(route => {
      const key = `${route.provider}\u0000${route.model}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return [primary, ...fallbacks]
  }

  private async *attempt(
    options: GenerateOptions,
    route: RouteConfig,
  ): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    let buffered: StreamChunk[] = []
    let streaming = false
    let finishEmitted = false
    let usage: TokenUsage | undefined

    const flush = function* (): Generator<StreamChunk> {
      for (const chunk of buffered) yield chunk
      buffered = []
    }

    try {
      const upstream = this.ctx.llm.stream({
        ...options,
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as never },
      })
      for await (const chunk of upstream) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (!streaming) {
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
            streaming = true
            yield* flush()
            yield chunk
            continue
          }
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              return {
                kind: 'failure',
                failure: chunk.reason.failure,
                partial: false,
                finishEmitted: false,
                aborted: chunk.reason.kind === 'aborted',
              }
            }
            yield* flush()
            yield chunk
            finishEmitted = true
            return { kind: 'success', ...usage === undefined ? {} : { usage }, finishEmitted }
          }
          buffered.push(chunk)
          continue
        }
        yield chunk
        if (chunk.type === 'finish') {
          finishEmitted = true
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            return {
              kind: 'failure',
              failure: chunk.reason.failure,
              partial: true,
              finishEmitted,
              aborted: chunk.reason.kind === 'aborted',
            }
          }
          return { kind: 'success', ...usage === undefined ? {} : { usage }, finishEmitted }
        }
      }
      yield* flush()
      if (!finishEmitted) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        finishEmitted = true
      }
      return { kind: 'success', ...usage === undefined ? {} : { usage }, finishEmitted }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield* flush()
        return {
          kind: 'failure',
          failure: { message: 'aborted', code: 'ABORTED' },
          partial: streaming,
          finishEmitted: false,
          aborted: true,
        }
      }
      yield* flush()
      return {
        kind: 'failure',
        failure: failureOf(error),
        partial: streaming,
        finishEmitted: false,
        aborted: false,
      }
    }
  }
}

/** Human-readable route label for diagnostics. */
export { routeLabel }
