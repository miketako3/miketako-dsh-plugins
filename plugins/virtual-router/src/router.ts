/**
 * Pure routing policy for the virtual router.
 *
 * The engine owns no I/O: it decides a physical route from session state,
 * request phase, failure history, and budget, and records outcomes. The
 * adapter turns that decision into an actual `ctx.llm.stream()` call.
 *
 * @module dsh-plugin-virtual-router/router
 */

import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Config, RouteConfig, TierConfig } from './config.ts'

/** Detected task phase. */
export type RoutePhase = 'plan' | 'implement' | 'verify' | 'summarize' | 'default'

/** One routing decision. */
export type RouterDecision =
  | {
    readonly kind: 'route'
    readonly route: RouteConfig
    readonly tierId?: string
    readonly phase: RoutePhase
    readonly reason: string
    readonly sticky: boolean
    readonly estimatedInputTokens: number
    readonly estimatedCostDelta: number
  }
  | {
    readonly kind: 'stop'
    readonly reason: string
    readonly phase: RoutePhase
    readonly estimatedInputTokens: number
  }

/** Input to one decision. */
export interface DecideInput {
  readonly sessionId: string
  readonly turn: number
  readonly model: string
  readonly purpose?: string
  readonly messages: readonly GenerateOptions['messages'][number][]
  readonly tools?: GenerateOptions['tools']
}

/** Mutable per-session routing state. */
export interface SessionRoutingState {
  turn: number
  sticky?: { route: RouteConfig; turn: number } | undefined
  lastRoute?: RouteConfig | undefined
  forcedTier?: string | undefined
  failures: number
  requests: number
  tokens: number
  lastPhase?: RoutePhase | undefined
  stopped?: string | undefined
}

/** Read-only status snapshot. */
export interface RoutingSnapshot {
  readonly sessionId: string
  readonly turn: number
  readonly phase?: RoutePhase
  readonly route?: RouteConfig
  readonly forcedTier?: string
  readonly failures: number
  readonly requests: number
  readonly tokens: number
  readonly stopped?: string
}

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Estimate the request's input tokens without a provider tokenizer.
 * @param messages - derived request messages.
 * @param tools - tool schemas.
 * @returns a conservative character-based estimate.
 */
export function estimateTokens(
  messages: readonly { role: string; content: readonly ContentBlock[] }[],
  tools: readonly { name: string; description: string; parameters: unknown }[] = [],
): number {
  let chars = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'reasoning') chars += block.text.length
      else if (block.type === 'tool-call') chars += block.name.length + block.arguments.length
      else if (block.type === 'image') chars += 4_000
    }
  }
  for (const tool of tools) chars += tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length
  return Math.max(1, Math.ceil(chars / 4))
}

/**
 * Detect the current task phase from the latest user text.
 * @param messages - request messages.
 * @param config - phase-detection words.
 * @returns the detected phase.
 */
export function detectPhase(
  messages: readonly Message[],
  config: Config['phaseDetection'],
  purpose?: string,
): RoutePhase {
  if (purpose === 'compaction') return 'summarize'
  if (!config.enabled) return 'default'
  let text = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const kind = (message.source as { kind?: string } | undefined)?.kind
    if (kind !== undefined && !['user', 'durable-resume', 'agent', 'hook', 'parent'].includes(kind)) continue
    text = textOf(message).toLowerCase()
    break
  }
  if (text.length === 0) return 'default'
  const has = (words: readonly string[]): boolean => words.some(word => text.includes(word.toLowerCase()))
  if (has(config.verify)) return 'verify'
  if (has(config.plan)) return 'plan'
  if (has(config.implement)) return 'implement'
  return 'default'
}

function routeKey(route: RouteConfig): string {
  return `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ''}`
}

/**
 * Session-scoped routing engine.
 */
export class RouterEngine {
  private readonly sessions = new Map<string, SessionRoutingState>()

  /**
   * @param config - resolved router configuration.
   */
  constructor(readonly config: Config) {}

  /**
   * Read or create one session state.
   * @param sessionId - session identity.
   * @returns mutable state owned by the engine.
   */
  stateOf(sessionId: string): SessionRoutingState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { turn: 0, failures: 0, requests: 0, tokens: 0 }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * Advance the session turn and clear turn-scoped stickiness.
   * @param sessionId - session identity.
   * @param turn - new turn number.
   */
  noteTurn(sessionId: string, turn: number): void {
    const state = this.stateOf(sessionId)
    if (turn <= state.turn && state.turn !== 0) return
    state.turn = turn
    state.stopped = undefined
    if (this.config.sticky.perTurn) state.sticky = undefined
  }

  /**
   * Force the next decision onto a tier (manual or circuit-breaker escalation).
   * @param sessionId - session identity.
   * @param reason - diagnostic reason.
   */
  escalate(sessionId: string, reason: string): void {
    void reason
    const state = this.stateOf(sessionId)
    const ladder = this.ladder()
    if (ladder.length === 0) return
    const current = state.forcedTier ?? this.currentTierId(state)
    const index = current === undefined ? -1 : ladder.findIndex(tier => tier.id === current)
    const next = ladder[Math.min(ladder.length - 1, Math.max(0, index + 1))]
    if (next === undefined) return
    state.forcedTier = next.id
    state.sticky = undefined
    state.failures = Math.max(state.failures, this.config.escalation.afterFailures)
  }

  /**
   * Force an exact tier.
   * @param sessionId - session identity.
   * @param tierId - tier to use.
   */
  forceTier(sessionId: string, tierId: string): void {
    const tier = this.tier(tierId)
    if (tier === undefined) return
    const state = this.stateOf(sessionId)
    state.forcedTier = tierId
    state.sticky = undefined
  }

  /**
   * Record a successful request.
   * @param sessionId - session identity.
   * @param route - physical route that succeeded.
   * @param usageTokens - provider-reported total, when available.
   */
  recordSuccess(sessionId: string, route: RouteConfig, usageTokens?: number): void {
    const state = this.stateOf(sessionId)
    state.lastRoute = route
    state.sticky = this.config.sticky.enabled ? { route, turn: state.turn } : undefined
    state.failures = 0
    state.forcedTier = undefined
    if (usageTokens !== undefined && Number.isFinite(usageTokens) && usageTokens > 0) state.tokens += usageTokens
  }

  /**
   * Record a failed request attempt.
   * @param sessionId - session identity.
   * @param route - route that failed.
   */
  recordFailure(sessionId: string, route: RouteConfig): void {
    void route
    const state = this.stateOf(sessionId)
    state.failures += 1
    state.sticky = undefined
  }

  /**
   * Record that a route was attempted (budget accounting).
   * @param sessionId - session identity.
   * @param estimatedTokens - estimated input tokens.
   */
  recordAttempt(sessionId: string, estimatedTokens: number): void {
    const state = this.stateOf(sessionId)
    state.requests += 1
    state.tokens += Math.max(0, estimatedTokens)
  }

  /**
   * Decide the physical route for one request.
   * @param input - request facts.
   * @returns a route or a budget stop.
   */
  decide(input: DecideInput): RouterDecision {
    const state = this.stateOf(input.sessionId)
    state.turn = Math.max(state.turn, input.turn)
    const phase = detectPhase(input.messages as Message[], this.config.phaseDetection, input.purpose)
    state.lastPhase = phase
    const estimatedInputTokens = estimateTokens(input.messages, input.tools)
    const last = state.lastRoute
    const previousCost = last === undefined ? 0 : this.costOf(last, estimatedInputTokens)

    if (input.purpose !== 'cache-warm') {
      const exhausted = this.budgetExceeded(state, estimatedInputTokens)
      if (exhausted !== undefined) {
        if (this.config.budget.onExhausted === 'downgrade') {
          const tier = this.tier(this.config.budget.downgradeTier)
          if (tier !== undefined) {
            return this.routeDecision(input.sessionId, tier, phase, `budget ${exhausted}; downgraded`, false, estimatedInputTokens, previousCost, state)
          }
        }
        state.stopped = exhausted
        return { kind: 'stop', reason: `budget exhausted: ${exhausted}`, phase, estimatedInputTokens }
      }
    }

    if (input.purpose === 'cache-warm') {
      const route = last ?? this.defaultRoute(input.model, phase)
      if (route === undefined) return { kind: 'stop', reason: 'no route configured', phase, estimatedInputTokens }
      return this.routeDecision(input.sessionId, route, phase, 'cache-warm reuses the last physical route', true, estimatedInputTokens, previousCost, state, false)
    }

    if (state.sticky !== undefined && state.sticky.turn === state.turn) {
      return this.routeDecision(input.sessionId, state.sticky.route, phase, 'sticky turn', true, estimatedInputTokens, previousCost, state)
    }

    if (state.forcedTier !== undefined) {
      const tier = this.tier(state.forcedTier)
      if (tier !== undefined) {
        return this.routeDecision(input.sessionId, tier, phase, `forced tier ${state.forcedTier}`, false, estimatedInputTokens, previousCost, state)
      }
    }

    const escalated = this.escalatedTier(state)
    if (escalated !== undefined) {
      return this.routeDecision(input.sessionId, escalated, phase, `failure escalation after ${state.failures} failures`, false, estimatedInputTokens, previousCost, state)
    }

    const phaseTierId = this.config.phaseRoutes[phase] ?? this.config.phaseRoutes['default']
    const phaseTier = phaseTierId === undefined ? undefined : this.tier(phaseTierId)
    if (phaseTier !== undefined) {
      return this.routeDecision(input.sessionId, phaseTier, phase, `phase ${phase}`, false, estimatedInputTokens, previousCost, state)
    }

    const route = this.defaultRoute(input.model, phase)
    if (route === undefined) return { kind: 'stop', reason: 'no route configured', phase, estimatedInputTokens }
    return this.routeDecision(input.sessionId, route, phase, 'model default', false, estimatedInputTokens, previousCost, state)
  }

  /**
   * Physical fallback routes for one decision.
   * @returns configured fallbacks in order.
   */
  fallbackRoutes(): RouteConfig[] {
    return this.config.fallback.enabled ? this.config.fallback.routes : []
  }

  /**
   * Whether a normalized failure triggers fallback.
   * @param code - provider-neutral code.
   * @param status - HTTP status, when present.
   * @returns true when another route should be tried.
   */
  shouldFallback(code: string | undefined, status: number | undefined): boolean {
    if (!this.config.fallback.enabled) return false
    if (code !== undefined && this.config.fallback.codes.includes(code)) return true
    return status !== undefined && this.config.fallback.statuses.includes(status)
  }

  /**
   * Snapshot one session.
   * @param sessionId - session identity.
   * @returns read-only status.
   */
  snapshot(sessionId: string): RoutingSnapshot {
    const state = this.stateOf(sessionId)
    return {
      sessionId,
      turn: state.turn,
      ...state.lastPhase === undefined ? {} : { phase: state.lastPhase },
      ...state.lastRoute === undefined ? {} : { route: state.lastRoute },
      ...state.forcedTier === undefined ? {} : { forcedTier: state.forcedTier },
      failures: state.failures,
      requests: state.requests,
      tokens: state.tokens,
      ...state.stopped === undefined ? {} : { stopped: state.stopped },
    }
  }

  private budgetExceeded(state: SessionRoutingState, estimatedTokens: number): string | undefined {
    if (this.config.budget.maxRequests > 0 && state.requests >= this.config.budget.maxRequests) {
      return `request budget ${this.config.budget.maxRequests} reached`
    }
    if (this.config.budget.maxTokens > 0 && state.tokens + estimatedTokens > this.config.budget.maxTokens) {
      return `token budget ${this.config.budget.maxTokens} reached`
    }
    return undefined
  }

  private routeDecision(
    sessionId: string,
    route: RouteConfig,
    phase: RoutePhase,
    reason: string,
    sticky: boolean,
    estimatedInputTokens: number,
    previousCost: number,
    state: SessionRoutingState,
    countBudget = true,
  ): RouterDecision {
    if (countBudget) this.recordAttempt(sessionId, estimatedInputTokens)
    const tierId = this.tierIdOf(route)
    return {
      kind: 'route',
      route,
      ...tierId === undefined ? {} : { tierId },
      phase,
      reason,
      sticky,
      estimatedInputTokens,
      estimatedCostDelta: this.costOf(route, estimatedInputTokens) - previousCost,
    }
  }

  private costOf(route: RouteConfig, inputTokens: number): number {
    const input = route.inputCostPerMTok ?? 0
    const output = route.outputCostPerMTok ?? 0
    return (inputTokens / 1_000_000) * input + (1_000 / 1_000_000) * output
  }

  private ladder(): TierConfig[] {
    return this.config.escalation.ladder
      .map(id => this.tier(id))
      .filter((tier): tier is TierConfig => tier !== undefined)
  }

  private escalatedTier(state: SessionRoutingState): RouteConfig | undefined {
    if (!this.config.escalation.enabled) return undefined
    if (state.failures < this.config.escalation.afterFailures) return undefined
    const ladder = this.ladder()
    if (ladder.length === 0) return undefined
    const index = Math.min(
      ladder.length - 1,
      Math.floor(state.failures / Math.max(1, this.config.escalation.afterFailures)),
    )
    return ladder[index]
  }

  private currentTierId(state: SessionRoutingState): string | undefined {
    if (state.forcedTier !== undefined) return state.forcedTier
    return state.lastRoute === undefined ? undefined : this.tierIdOf(state.lastRoute)
  }

  private defaultRoute(model: string, phase: RoutePhase): RouteConfig | undefined {
    const virtual = this.config.models.find(candidate => candidate.id === model)
    const tierId = virtual?.defaultTier ?? this.config.phaseRoutes[phase] ?? this.config.phaseRoutes['default']
    return tierId === undefined ? undefined : this.tier(tierId)
  }

  private tier(id: string | undefined): TierConfig | undefined {
    if (id === undefined || id.length === 0) return undefined
    return this.config.tiers.find(tier => tier.id === id)
  }

  private tierIdOf(route: RouteConfig): string | undefined {
    const key = routeKey(route)
    return this.config.tiers.find(tier => routeKey(tier) === key)?.id
  }
}
