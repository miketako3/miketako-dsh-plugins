/**
 * Host service for the virtual router.
 *
 * Durable-exec and other autonomy plugins use `escalate()`; status surfaces use
 * `snapshot()` and `recentAudit()`.
 *
 * @module dsh-plugin-virtual-router/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AuditRecord, AuditSink } from './audit.ts'
import type { RouteConfig } from './config.ts'
import type { RouterEngine, RoutingSnapshot } from './router.ts'

/** Public control surface exposed as `ctx.virtualRouter`. */
export class VirtualRouterService extends Service {
  /**
   * @param ctx - owning plugin context.
   * @param engine - routing state machine.
   * @param audit - structured audit sink.
   */
  constructor(
    ctx: Context,
    private readonly engine: RouterEngine,
    private readonly audit: AuditSink,
  ) {
    super(ctx, 'virtualRouter')
  }

  /**
   * Escalate one agent's next request one tier and clear its sticky route.
   * @param agent - agent to escalate.
   * @param reason - diagnostic reason recorded in the audit.
   */
  escalate(agent: Agent, reason: string): void {
    const sessionId = agent.session.id
    const before = this.engine.snapshot(sessionId).route
    this.engine.escalate(sessionId, reason)
    const after = this.engine.snapshot(sessionId).forcedTier
    const to = after === undefined ? undefined : this.routeOfTier(after)
    this.audit.write({
      ts: Date.now(),
      event: 'escalate',
      sessionId,
      turn: this.engine.stateOf(sessionId).turn,
      virtualModel: '',
      ...before === undefined ? {} : { from: before },
      ...to === undefined ? {} : { to },
      reason,
      failures: this.engine.stateOf(sessionId).failures,
    })
  }

  /**
   * Force an exact tier for one session.
   * @param sessionId - session identity.
   * @param tierId - tier id from configuration.
   * @returns false when the tier does not exist.
   */
  forceTier(sessionId: string, tierId: string): boolean {
    if (this.routeOfTier(tierId) === undefined) return false
    this.engine.forceTier(sessionId, tierId)
    return true
  }

  /**
   * Advance the tracked turn for one session.
   * @param sessionId - session identity.
   * @param turn - turn number from `turn/start`.
   */
  noteTurn(sessionId: string, turn: number): void {
    this.engine.noteTurn(sessionId, turn)
  }

  /**
   * Read routing state for one session.
   * @param sessionId - session identity.
   * @returns status snapshot.
   */
  snapshot(sessionId: string): RoutingSnapshot {
    return this.engine.snapshot(sessionId)
  }

  /**
   * Read recent audit records.
   * @param limit - maximum records.
   * @returns newest first.
   */
  recentAudit(limit = 20): AuditRecord[] {
    return this.audit.recent(limit)
  }

  private routeOfTier(tierId: string): RouteConfig | undefined {
    return this.engine.config.tiers.find(tier => tier.id === tierId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Virtual model routing control, when the plugin is loaded. */
    virtualRouter: VirtualRouterService
  }
}
