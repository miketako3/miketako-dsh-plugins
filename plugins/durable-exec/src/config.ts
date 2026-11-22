/**
 * Configuration schema for the durable-execution plugin.
 *
 * @module dsh-plugin-durable-exec/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** Side-effect classification assigned to every tool invocation. */
export type ToolPolicy = 'read-only' | 'idempotent' | 'side-effect'

/** Retry policy applied only to calls whose tool policy permits repetition. */
export interface RetryConfig {
  /** Whether transient-failure retries are enabled. */
  enabled: boolean
  /** Maximum attempts including the first one. */
  maxAttempts: number
  /** First backoff delay in milliseconds. */
  initialDelayMs: number
  /** Backoff ceiling in milliseconds. */
  maxDelayMs: number
  /** Fractional jitter applied to each delay, from 0 to 1. */
  jitterRatio: number
  /** Provider-neutral failure codes treated as transient. */
  retryableCodes: string[]
}

/** Circuit-breaker and stuck-session limits. */
export interface CircuitBreakerConfig {
  /** Consecutive failed side-effecting or idempotent calls that open the breaker. */
  failureThreshold: number
  /** Cooldown before the same session may open the breaker again. */
  cooldownMs: number
  /** What an open breaker does: escalate the routed model or stop the turn. */
  action: 'escalate' | 'stop'
  /** Consecutive tool-using turns with no observed progress before acting. Zero disables it. */
  noProgressTurns: number
  /** What repeated no-progress turns do. */
  noProgressAction: 'escalate' | 'stop'
}

/** Checkpoint persistence options. */
export interface CheckpointConfig {
  /** Capture the workspace Git HEAD with each turn checkpoint. */
  includeGitHead: boolean
  /** Milliseconds a Git probe may take. */
  gitTimeoutMs: number
  /** Characters of the latest user goal retained in a checkpoint. */
  goalMaxChars: number
}

/** Startup recovery options. */
export interface AutoResumeConfig {
  /** Whether interrupted sessions are resumed when the harness starts. */
  enabled: boolean
  /** Upper bound on sessions resumed per process start. */
  maxSessions: number
  /** Upper bound on automatic resume attempts for one session. */
  maxAttempts: number
  /** Turns after the interrupted turn in which recorded results may be replayed. */
  resumeWindowTurns: number
  /** Prompt injected into a resumed session. */
  prompt: string
}

/** Complete plugin configuration. */
export interface Config {
  /** SQLite ledger path. Parent directories are created on load. */
  databasePath: string
  /** Per-tool side-effect classifications. */
  toolPolicies: Record<string, ToolPolicy>
  /** Classification for tools absent from {@link Config.toolPolicies}. */
  defaultToolPolicy: ToolPolicy
  /** Transient-failure retry policy. */
  retry: RetryConfig
  /** Circuit-breaker policy. */
  circuitBreaker: CircuitBreakerConfig
  /** Checkpoint policy. */
  checkpoints: CheckpointConfig
  /** Startup auto-resume policy. */
  autoResume: AutoResumeConfig
}

/** Default resume prompt: deliberately operational, not conversational. */
export const DEFAULT_RESUME_PROMPT = [
  'This session was interrupted by a harness process restart. Resume the original task from the last recorded checkpoint.',
  'Do not repeat tool calls whose results already appear in the conversation.',
  'If a tool result says its outcome is unknown, verify external state before retrying a side-effecting operation.',
  'Report the resumed checkpoint briefly, then continue working.',
].join(' ')

/** Default ledger path under the DSH home directory. */
export function defaultDatabasePath(): string {
  const home = process.env['DSH_HOME']?.trim()
  const base = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'durable-exec', 'ledger.db')
}

const policy = Schema.union(['read-only', 'idempotent', 'side-effect'])

/** Runtime configuration schema. */
export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default(defaultDatabasePath()),
  toolPolicies: Schema.dict(policy).default({
    read: 'read-only',
    glob: 'read-only',
    grep: 'read-only',
    web_fetch: 'read-only',
    web_search: 'read-only',
    session_query: 'read-only',
    todo_write: 'idempotent',
    write: 'side-effect',
    edit: 'side-effect',
    bash: 'side-effect',
    present: 'side-effect',
  }),
  defaultToolPolicy: policy.default('side-effect'),
  retry: Schema.object({
    enabled: Schema.boolean().default(true),
    maxAttempts: Schema.number().step(1).min(1).default(3),
    initialDelayMs: Schema.number().step(1).min(0).default(500),
    maxDelayMs: Schema.number().step(1).min(0).default(15_000),
    jitterRatio: Schema.number().min(0).max(1).default(0.2),
    retryableCodes: Schema.array(Schema.string()).default([
      'RATE_LIMIT',
      'SERVER_ERROR',
      'TIMEOUT',
      'NETWORK',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
    ]),
  }),
  circuitBreaker: Schema.object({
    failureThreshold: Schema.number().step(1).min(1).default(8),
    cooldownMs: Schema.number().step(1).min(0).default(60_000),
    action: Schema.union(['escalate', 'stop']).default('escalate'),
    noProgressTurns: Schema.number().step(1).min(0).default(4),
    noProgressAction: Schema.union(['escalate', 'stop']).default('escalate'),
  }),
  checkpoints: Schema.object({
    includeGitHead: Schema.boolean().default(true),
    gitTimeoutMs: Schema.number().step(1).min(1).default(1_000),
    goalMaxChars: Schema.number().step(1).min(1).default(2_000),
  }),
  autoResume: Schema.object({
    enabled: Schema.boolean().default(true),
    maxSessions: Schema.number().step(1).min(0).default(3),
    maxAttempts: Schema.number().step(1).min(0).default(3),
    resumeWindowTurns: Schema.number().step(1).min(0).default(5),
    prompt: Schema.string().default(DEFAULT_RESUME_PROMPT),
  }),
})
