/**
 * Virtual-router configuration.
 *
 * @module dsh-plugin-virtual-router/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** One physical provider/model route. */
export interface RouteConfig {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort. */
  reasoningEffort?: string
  /** Optional input price used only for the audit's estimated delta. */
  inputCostPerMTok?: number
  /** Optional output price used only for the audit's estimated delta. */
  outputCostPerMTok?: number
}

/** One named tier in the escalation ladder. */
export interface TierConfig extends RouteConfig {
  /** Stable tier id referenced by routes and the ladder. */
  id: string
}

/** One advertised virtual model. */
export interface VirtualModelConfig {
  /** Model id selected in the model picker. */
  id: string
  /** Display name. */
  name: string
  /** Advertised context window. */
  contextWindow: number
  /** Tier used when no rule matches. */
  defaultTier: string
  /** Optional description. */
  description?: string
}

/** Failure-escalation policy. */
export interface EscalationConfig {
  /** Whether repeated request failures move up the ladder. */
  enabled: boolean
  /** Consecutive failures before escalating one tier. */
  afterFailures: number
  /** Tier ids from cheapest to most capable. */
  ladder: string[]
}

/** Provider fallback policy. */
export interface FallbackConfig {
  /** Whether an error can move to another physical route within one request. */
  enabled: boolean
  /** Ordered fallback routes. */
  routes: RouteConfig[]
  /** Stable failure codes that trigger fallback. */
  codes: string[]
  /** HTTP statuses that trigger fallback. */
  statuses: number[]
}

/** Per-session budget policy. */
export interface BudgetConfig {
  /** Cumulative input-token ceiling; zero disables the token budget. */
  maxTokens: number
  /** Request ceiling; zero disables the request budget. */
  maxRequests: number
  /** Stop the turn or downgrade to the budget tier. */
  onExhausted: 'stop' | 'downgrade'
  /** Tier id used by the downgrade policy. */
  downgradeTier: string
}

/** Sticky-routing policy. */
export interface StickyConfig {
  /** Reuse one route within a turn. */
  enabled: boolean
  /** Clear the sticky route at a turn boundary. */
  perTurn: boolean
}

/** Heuristic phase detection. */
export interface PhaseDetectionConfig {
  /** Enable message-text heuristics. */
  enabled: boolean
  /** Lowercase substrings that indicate planning. */
  plan: string[]
  /** Lowercase substrings that indicate implementation. */
  implement: string[]
  /** Lowercase substrings that indicate verification. */
  verify: string[]
}

/** Complete plugin configuration. */
export interface Config {
  /** Provider route registered by this adapter. */
  provider: string
  /** Display name for the provider. */
  displayName: string
  /** Advertised virtual models. */
  models: VirtualModelConfig[]
  /** Physical tiers. */
  tiers: TierConfig[]
  /** Phase-to-tier mapping: plan, implement, verify, summarize, default. */
  phaseRoutes: Record<string, string>
  /** Failure escalation. */
  escalation: EscalationConfig
  /** Provider fallback. */
  fallback: FallbackConfig
  /** Per-session budget. */
  budget: BudgetConfig
  /** Sticky routing. */
  sticky: StickyConfig
  /** Audit log path; empty disables file output. */
  auditPath: string
  /** Phase heuristics. */
  phaseDetection: PhaseDetectionConfig
}

/** Default audit path under the DSH home directory. */
export function defaultAuditPath(): string {
  const home = process.env['DSH_HOME']?.trim()
  const base = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'virtual-router', 'audit.jsonl')
}

const route = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
  reasoningEffort: Schema.string(),
  inputCostPerMTok: Schema.number().min(0),
  outputCostPerMTok: Schema.number().min(0),
})

/** Runtime configuration schema. */
export const Config: Schema<Config> = Schema.object({
  provider: Schema.string().default('virtual'),
  displayName: Schema.string().default('Virtual Router'),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().required(),
    contextWindow: Schema.number().step(1).min(1).default(262_144),
    defaultTier: Schema.string().required(),
    description: Schema.string(),
  })).default([]),
  tiers: Schema.array(Schema.object({
    id: Schema.string().required(),
    provider: Schema.string().required(),
    model: Schema.string().required(),
    reasoningEffort: Schema.string(),
    inputCostPerMTok: Schema.number().min(0),
    outputCostPerMTok: Schema.number().min(0),
  })).default([]),
  phaseRoutes: Schema.dict(Schema.string()).default({}),
  escalation: Schema.object({
    enabled: Schema.boolean().default(true),
    afterFailures: Schema.number().step(1).min(1).default(2),
    ladder: Schema.array(Schema.string()).default([]),
  }),
  fallback: Schema.object({
    enabled: Schema.boolean().default(true),
    routes: Schema.array(route).default([]),
    codes: Schema.array(Schema.string()).default([
      'RATE_LIMIT',
      'SERVER_ERROR',
      'TIMEOUT',
      'NETWORK',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
    ]),
    statuses: Schema.array(Schema.number()).default([408, 429, 500, 502, 503, 504]),
  }),
  budget: Schema.object({
    maxTokens: Schema.number().step(1).min(0).default(0),
    maxRequests: Schema.number().step(1).min(0).default(0),
    onExhausted: Schema.union(['stop', 'downgrade']).default('stop'),
    downgradeTier: Schema.string().default(''),
  }),
  sticky: Schema.object({
    enabled: Schema.boolean().default(true),
    perTurn: Schema.boolean().default(true),
  }),
  auditPath: Schema.string().default(defaultAuditPath()),
  phaseDetection: Schema.object({
    enabled: Schema.boolean().default(true),
    plan: Schema.array(Schema.string()).default([
      'plan',
      'design',
      'architect',
      'investigate',
      'research',
      '計画',
      '設計',
      '調査',
    ]),
    implement: Schema.array(Schema.string()).default([
      'implement',
      'add',
      'fix',
      'change',
      'refactor',
      'write',
      '実装',
      '修正',
      '追加',
    ]),
    verify: Schema.array(Schema.string()).default([
      'test',
      'verify',
      'check',
      'lint',
      'typecheck',
      'build',
      '検証',
      'テスト',
      '確認',
    ]),
  }),
})
