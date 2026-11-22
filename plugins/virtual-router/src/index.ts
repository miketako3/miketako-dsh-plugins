/**
 * Virtual model router for the DeepSeek Harness.
 *
 * Registers a logical provider whose models are routed per request by phase,
 * failure history, sticky turn, and budget, with provider fallback and a
 * structured audit trail. The physical provider is never hidden from the
 * Session: the request header keeps the virtual route, and the audit records
 * the physical route actually used.
 *
 * @module dsh-plugin-virtual-router
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AuditSink } from './audit.ts'
import { Config } from './config.ts'
import type { Config as RouterConfig } from './config.ts'
import { VirtualModelAdapter } from './adapter.ts'
import { RouterEngine } from './router.ts'
import { VirtualRouterService } from './service.ts'

export { Config } from './config.ts'
export type {
  BudgetConfig,
  Config as VirtualRouterConfig,
  EscalationConfig,
  FallbackConfig,
  PhaseDetectionConfig,
  RouteConfig,
  StickyConfig,
  TierConfig,
  VirtualModelConfig,
} from './config.ts'
export { AuditSink } from './audit.ts'
export type { AuditRecord } from './audit.ts'
export { VirtualModelAdapter } from './adapter.ts'
export { detectPhase, estimateTokens, RouterEngine } from './router.ts'
export type { DecideInput, RoutePhase, RouterDecision, RoutingSnapshot, SessionRoutingState } from './router.ts'
export { VirtualRouterService } from './service.ts'

/** Plugin name. */
export const name = 'virtual-router'

/** Services required by the adapter and turn tracking. */
export const inject = ['llm']

/** Warn about dangling tier references without preventing the profile from loading. */
function validateConfig(ctx: Context, config: RouterConfig): void {
  const tiers = new Set(config.tiers.map(tier => tier.id))
  for (const model of config.models) {
    if (!tiers.has(model.defaultTier)) {
      ctx.logger.warn(`virtual-router: model ${model.id} references unknown tier ${model.defaultTier}`)
    }
  }
  for (const [phase, tier] of Object.entries(config.phaseRoutes)) {
    if (!tiers.has(tier)) ctx.logger.warn(`virtual-router: phase ${phase} references unknown tier ${tier}`)
  }
  for (const tier of config.escalation.ladder) {
    if (!tiers.has(tier)) ctx.logger.warn(`virtual-router: escalation ladder references unknown tier ${tier}`)
  }
  if (config.budget.downgradeTier.length > 0 && !tiers.has(config.budget.downgradeTier)) {
    ctx.logger.warn(`virtual-router: budget downgrade references unknown tier ${config.budget.downgradeTier}`)
  }
}

/**
 * Mount the plugin.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: RouterConfig): void {
  validateConfig(ctx, config)
  const engine = new RouterEngine(config)
  const audit = new AuditSink(config.auditPath, ctx.logger)
  new VirtualRouterService(ctx, engine, audit)
  const adapter = new VirtualModelAdapter(ctx, engine, audit, config)

  ctx.effect(
    () => ctx.llm.registerAdapter([config.provider], adapter),
    'virtual-router:adapter',
  )

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'turn/start') ctx.virtualRouter.noteTurn(session.id, event.data.turn)
  })

  if (config.models.length === 0) {
    ctx.logger.info('virtual-router: no virtual models configured; set config.models to enable routing')
  }
}
