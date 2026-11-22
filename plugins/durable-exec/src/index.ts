/**
 * Durable tool execution for the DeepSeek Harness.
 *
 * The plugin records a tool call before it runs, records its lossless outcome
 * inside the tool pipeline (before the agent loop appends the result), turns
 * exact repeats into replays, retries only repetition-safe policies, and
 * persists a per-session checkpoint so a crashed harness can resume.
 *
 * @module dsh-plugin-durable-exec
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AutoResumeConfig, Config as DurableConfig, RetryConfig, ToolPolicy } from './config.ts'
import { hashArguments, idempotencyKey } from './hash.ts'
import { LedgerStore } from './store.ts'
import type { CheckpointRecord, LedgerEntry, PersistedResult } from './store.ts'

export { Config } from './config.ts'
export type { Config as DurableExecConfig, ToolPolicy } from './config.ts'
export { canonicalJson, hashArguments, idempotencyKey } from './hash.ts'
export { LedgerStore } from './store.ts'
export type { CheckpointRecord, LedgerEntry, PersistedResult } from './store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Process-restart resume notice injected by durable-exec. */
    'durable-resume': {
      kind: 'durable-resume'
      form: 'notice'
      summary: string
    }
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Recorded by the workspace-changes plugin; optional here so the listener stays decoupled. */
    'workspace/changes': { turn: number }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The durable circuit breaker opened. Observers may escalate a routed model
     * or surface the event; durable-exec itself has already applied its action.
     */
    'durable/circuit-open'(payload: {
      readonly sessionId: SessionId
      readonly kind: 'tool-failures' | 'no-progress'
      readonly failures: number
      readonly reason: string
    }): void
  }
}

/** Public read-only view for tools, status panels, and tests. */
export interface DurableExecSnapshot {
  readonly instanceId: string
  readonly checkpoint?: CheckpointRecord
  readonly recent: readonly LedgerEntry[]
}

/** Host service exposed as `ctx.durableExec`. */
export class DurableExecService extends Service {
  readonly instanceId: string
  private readonly store: LedgerStore

  /**
   * @param ctx - owning plugin context.
   * @param instanceId - process-local ledger owner identity.
   * @param store - open ledger store.
   */
  constructor(ctx: Context, instanceId: string, store: LedgerStore) {
    super(ctx, 'durableExec')
    this.instanceId = instanceId
    this.store = store
  }

  /**
   * Read the durable checkpoint for one session.
   * @param sessionId - session identity.
   * @returns the checkpoint, or undefined.
   */
  checkpoint(sessionId: string): CheckpointRecord | undefined {
    return this.store.getCheckpoint(sessionId)
  }

  /**
   * Read recent ledger rows for one session.
   * @param sessionId - session identity.
   * @param limit - maximum rows.
   * @returns newest rows first.
   */
  recent(sessionId: string, limit = 20): readonly LedgerEntry[] {
    return this.store.recent(sessionId, limit)
  }

  /**
   * Read one ledger row by its exact idempotency key.
   * @param key - key produced by {@link idempotencyKey}.
   * @returns the row, or undefined.
   */
  entry(key: string): LedgerEntry | undefined {
    return this.store.get(key)
  }

  /**
   * Collect one diagnostics snapshot.
   * @param sessionId - session identity.
   * @returns checkpoint plus recent rows.
   */
  snapshot(sessionId: string): DurableExecSnapshot {
    const checkpoint = this.store.getCheckpoint(sessionId)
    return {
      instanceId: this.instanceId,
      ...checkpoint === undefined ? {} : { checkpoint },
      recent: this.recent(sessionId),
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable-execution ledger and checkpoint view, when the plugin is loaded. */
    durableExec: DurableExecService
  }
}

/** Plugin name. */
export const name = 'durable-exec'

/** Services required by the tool and agent hooks. */
export const inject = ['agents', 'tools']

interface SessionState {
  turn: number
  step: number
  toolCalls: number
  progress: boolean
  noProgressTurns: number
  failures: number
  lastFailureAt: number
  cooldownUntil: number
  paused: boolean
}

interface ResumeWindow {
  readonly fromTurn: number
  readonly untilTurn: number
}

interface VirtualRouterControl {
  escalate(agent: Agent, reason: string): void
}

function freshState(): SessionState {
  return {
    turn: 0,
    step: 0,
    toolCalls: 0,
    progress: false,
    noProgressTurns: 0,
    failures: 0,
    lastFailureAt: 0,
    cooldownUntil: 0,
    paused: false,
  }
}

function policyFor(config: DurableConfig, toolName: string): ToolPolicy {
  return config.toolPolicies[toolName] ?? config.defaultToolPolicy
}

/** Whether a policy permits the same operation to run again without new external effects. */
export function repetitionSafe(policy: ToolPolicy): boolean {
  return policy === 'read-only' || policy === 'idempotent'
}

function retryAfterOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as { providerRetryAfterMs?: unknown }).providerRetryAfterMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Classify a thrown tool failure as transient.
 * @param error - thrown value from a tool body or downstream wrapper.
 * @param config - retry configuration.
 * @returns true when the same repetition-safe call may be attempted again.
 */
export function isRetryableFailure(error: unknown, config: RetryConfig): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false
  if (typeof error !== 'object' || error === null) return false
  const record = error as { code?: unknown; status?: unknown; cause?: unknown }
  if (typeof record.code === 'string' && config.retryableCodes.includes(record.code)) return true
  if (typeof record.status === 'number' && (record.status === 408 || record.status === 429 || record.status >= 500)) {
    return true
  }
  const cause = record.cause
  if (cause !== undefined && cause !== error && isRetryableFailure(cause, config)) return true
  return false
}

/**
 * Backoff with bounded exponential growth and symmetric jitter.
 * @param attempt - 1-based retry number.
 * @param config - retry configuration.
 * @param retryAfterMs - provider-requested delay, when present.
 * @returns delay in milliseconds.
 */
export function backoffDelay(attempt: number, config: RetryConfig, retryAfterMs?: number): number {
  const base = Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** Math.max(0, attempt - 1))
  const jitter = base * config.jitterRatio * (Math.random() * 2 - 1)
  const delay = Math.max(0, base + jitter)
  return retryAfterMs === undefined ? Math.min(config.maxDelayMs, delay) : Math.max(delay, retryAfterMs)
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errorOfResult(result: ToolExecutionResult): unknown {
  if (!result.isError) return undefined
  const error = result.error
  const wrapped = new Error(error.message) as Error & { code?: string; status?: number; providerRetryAfterMs?: number }
  if (error.info !== undefined) {
    wrapped.code = error.info.code
    wrapped.name = error.info.name
  }
  return wrapped
}

function persistResult(result: ToolExecutionResult): PersistedResult {
  if (result.isError) {
    return {
      kind: 'error',
      content: result.content,
      error: result.error,
      ...result.error.info === undefined ? {} : { errorCode: result.error.info.code },
    }
  }
  return { kind: 'success', value: result.value, content: result.content }
}

export function replayResult(entry: LedgerEntry): ToolExecutionResult | undefined {
  if (entry.status === 'COMPLETED' && entry.valueJson !== undefined) {
    const content = entry.contentJson === undefined ? [] : JSON.parse(entry.contentJson) as ContentBlock[]
    return {
      isError: false,
      value: JSON.parse(entry.valueJson),
      content,
    }
  }
  if (entry.status === 'FAILED' && entry.errorJson !== undefined) {
    const error = JSON.parse(entry.errorJson) as {
      message: string
      info?: { name: string; code: string; reason?: string }
    }
    const content = entry.contentJson === undefined ? [] : JSON.parse(entry.contentJson) as ContentBlock[]
    return { isError: true, error, content }
  }
  return undefined
}

function ambiguousResult(toolName: string): ToolExecutionResult {
  const message = [
    `The previous process was interrupted while ${toolName} was in flight, so whether its side effect`,
    'was applied is unknown. Do not retry it blindly. Inspect the external state first, then decide',
    'whether to repeat, compensate, or continue.',
  ].join(' ')
  return {
    isError: true,
    error: {
      message,
      info: { name: 'AmbiguousInflightError', code: 'AMBIGUOUS_INFLIGHT' },
    },
    content: [{ type: 'text', text: message }],
  }
}

function gitHead(cwd: string | undefined, timeout: number): string | undefined {
  if (cwd === undefined) return undefined
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

function latestGoal(session: Session, maxChars: number): string | undefined {
  try {
    const messages = session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user') continue
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      if (text.length > 0) return text.slice(0, maxChars)
    }
  } catch {
    return undefined
  }
  return undefined
}

function hasHumanMessage(messages: readonly Message[]): boolean {
  return messages.some(message => message.source.kind === 'user')
}

/**
 * Mount the durable execution plugin.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: DurableConfig): void {
  const instanceId = randomUUID()
  const store = new LedgerStore(config.databasePath)
  new DurableExecService(ctx, instanceId, store)
  const states = new WeakMap<Session, SessionState>()
  const resumeWindows = new Map<string, ResumeWindow>()

  ctx.effect(() => () => {
    store.close()
  }, 'durable-exec:ledger')

  const stateOf = (session: Session): SessionState => {
    let state = states.get(session)
    if (state === undefined) {
      state = freshState()
      states.set(session, state)
    }
    return state
  }

  const selectionOf = (session: Session): { provider?: string; model?: string; reasoningEffort?: string } => {
    const selection = ctx.agents.get(session.id)?.model.current()
    if (selection === undefined) return {}
    return {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) },
    }
  }

  const checkpoint = (
    session: Session,
    status: 'RUNNING' | 'IDLE',
    turn: number,
    step: number,
    includeGoal: boolean,
  ): void => {
    try {
      const goal = includeGoal ? latestGoal(session, config.checkpoints.goalMaxChars) : undefined
      const head = includeGoal && config.checkpoints.includeGitHead
        ? gitHead(session.header.cwd, config.checkpoints.gitTimeoutMs)
        : undefined
      const selection = selectionOf(session)
      store.checkpoint({
        sessionId: session.id,
        status,
        turn,
        step,
        ...goal === undefined ? {} : { goal },
        ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
        ...head === undefined ? {} : { gitHead: head },
        ...selection.provider === undefined ? {} : { provider: selection.provider },
        ...selection.model === undefined ? {} : { model: selection.model },
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        ...session.header.origin === undefined ? {} : { origin: session.header.origin },
      })
    } catch (error) {
      ctx.logger.warn('durable-exec: checkpoint write failed')
      ctx.logger.warn(error)
    }
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const state = stateOf(session)
    switch (event.type) {
      case 'turn/start': {
        state.turn = event.data.turn
        state.step = 0
        state.toolCalls = 0
        state.progress = false
        checkpoint(session, 'RUNNING', state.turn, state.step, true)
        break
      }
      case 'step/start': {
        state.step = event.data.step
        checkpoint(session, 'RUNNING', state.turn, state.step, false)
        break
      }
      case 'workspace/changes': {
        const reader = (ctx as unknown as {
          get(name: string): { summary(sessionId: SessionId, seq: number): { total: number } | undefined } | undefined
        }).get('workspaceChanges')
        const summary = reader?.summary(session.id, event.seq)
        if (summary !== undefined && summary.total > 0) state.progress = true
        break
      }
      case 'turn/end': {
        checkpoint(session, 'IDLE', event.data.turn, state.step, false)
        if (state.toolCalls > 0 && !state.progress) {
          state.noProgressTurns += 1
        } else if (state.toolCalls > 0) {
          state.noProgressTurns = 0
        } else {
          state.noProgressTurns = 0
        }
        const limit = config.circuitBreaker.noProgressTurns
        if (limit > 0 && state.noProgressTurns >= limit) {
          const agent = ctx.agents.get(session.id)
          const reason = `durable-exec: ${state.noProgressTurns} consecutive turns used tools without observed progress`
          if (config.circuitBreaker.noProgressAction === 'stop') {
            state.paused = true
            state.noProgressTurns = 0
            ctx.logger.warn(reason)
          } else if (agent !== undefined) {
            escalate(ctx, agent, reason)
            state.noProgressTurns = 0
          }
        }
        break
      }
      default:
        break
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const state = stateOf(agent.session)
    if (state.paused) {
      if (hasHumanMessage(messages)) {
        state.paused = false
        state.noProgressTurns = 0
        ctx.logger.info('durable-exec: a human message resumed a paused session')
      } else {
        ctx.logger.warn(`durable-exec: rejecting an automatic step for paused session ${agent.session.id}`)
        return { kind: 'reject' }
      }
    }
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === undefined || exec.parent !== undefined) return next()
    const session = exec.agent.session
    const state = stateOf(session)
    const argsHash = hashArguments(exec.arguments)
    const key = idempotencyKey({
      sessionId: session.id,
      turn: state.turn,
      step: state.step,
      toolName: exec.name,
      argsHash,
    })
    store.begin({
      key,
      sessionId: session.id,
      turn: state.turn,
      step: state.step,
      toolName: exec.name,
      argsHash,
      policy: policyFor(config, exec.name),
      callId: exec.callId,
      ownerInstance: instanceId,
    })
    const decision = await next()
    if (decision.kind !== 'allow') store.discard(key)
    return decision
  })

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent === undefined || exec.parent !== undefined) return next()
    const session = exec.agent.session
    const state = stateOf(session)
    const argsHash = hashArguments(exec.arguments)
    const policy = policyFor(config, exec.name)
    const key = idempotencyKey({
      sessionId: session.id,
      turn: state.turn,
      step: state.step,
      toolName: exec.name,
      argsHash,
    })
    let entry = store.get(key)
    if (entry === undefined) {
      entry = store.begin({
        key,
        sessionId: session.id,
        turn: state.turn,
        step: state.step,
        toolName: exec.name,
        argsHash,
        policy,
        callId: exec.callId,
        ownerInstance: instanceId,
      })
    }

    if (entry.status === 'COMPLETED') {
      const replay = replayResult(entry)
      if (replay !== undefined) {
        ctx.logger.info(`durable-exec: replayed completed ${exec.name} (${entry.key.slice(-16)})`)
        return replay
      }
    }
    if (entry.status === 'FAILED' && policy === 'side-effect') {
      const replay = replayResult(entry)
      if (replay !== undefined) {
        ctx.logger.info(`durable-exec: replayed recorded failure of ${exec.name}`)
        return replay
      }
    }
    if (entry.status === 'PENDING' && entry.ownerInstance !== instanceId && policy === 'side-effect') {
      ctx.logger.warn(`durable-exec: ${exec.name} has an ambiguous in-flight record from a previous process`)
      return ambiguousResult(exec.name)
    }

    const resume = resumeWindows.get(session.id)
    if (resume !== undefined && policy !== 'read-only' && state.turn > resume.fromTurn && state.turn <= resume.untilTurn) {
      const previous = store.findSemantic(session.id, exec.name, argsHash, resume.fromTurn)
      if (previous !== undefined) {
        if (previous.status === 'COMPLETED' || (previous.status === 'FAILED' && policy === 'side-effect')) {
          const replay = replayResult(previous)
          if (replay !== undefined) {
            ctx.logger.info(`durable-exec: replayed ${exec.name} from interrupted turn ${resume.fromTurn}`)
            return replay
          }
        }
        if (previous.status === 'PENDING' && previous.ownerInstance !== instanceId && policy === 'side-effect') {
          ctx.logger.warn(`durable-exec: ${exec.name} was in flight when the interrupted turn ended`)
          return ambiguousResult(exec.name)
        }
      }
    }

    return executeWithRetry(exec, next, policy, config, ctx)
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || exec.parent !== undefined) return
    const session = exec.agent.session
    const state = stateOf(session)
    const argsHash = hashArguments(exec.arguments)
    const key = idempotencyKey({
      sessionId: session.id,
      turn: state.turn,
      step: state.step,
      toolName: exec.name,
      argsHash,
    })
    try {
      if (store.get(key) === undefined) {
        store.begin({
          key,
          sessionId: session.id,
          turn: state.turn,
          step: state.step,
          toolName: exec.name,
          argsHash,
          policy: policyFor(config, exec.name),
          callId: exec.callId,
          ownerInstance: instanceId,
        })
      }
      store.complete(key, persistResult(result))
    } catch (error) {
      ctx.logger.warn('durable-exec: ledger write failed')
      ctx.logger.warn(error)
    }

    state.toolCalls += 1
    const policy = policyFor(config, exec.name)
    if (!result.isError) {
      if (policy !== 'read-only') state.progress = true
      state.failures = 0
      return
    }
    if (policy === 'read-only') return
    state.failures += 1
    state.lastFailureAt = Date.now()
    if (state.failures < config.circuitBreaker.failureThreshold) return
    if (Date.now() < state.cooldownUntil) return
    state.cooldownUntil = Date.now() + config.circuitBreaker.cooldownMs
    const reason = `durable-exec: ${state.failures} consecutive failed side-effecting tool calls`
    ctx.emit('durable/circuit-open', {
      sessionId: session.id,
      kind: 'tool-failures',
      failures: state.failures,
      reason,
    })
    if (config.circuitBreaker.action === 'stop') {
      ctx.logger.warn(reason)
      exec.agent.cancel({ kind: 'hook', reason })
    } else {
      escalate(ctx, exec.agent, reason)
    }
  })

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      try {
        const loader = (ctx as unknown as { get(name: string): { await(): Promise<void> } | undefined }).get('loader')
        await loader?.await()
      } catch (error) {
        ctx.logger.warn('durable-exec: waiting for loader composition failed')
        ctx.logger.warn(error)
      }
      if (disposed || !config.autoResume.enabled) return
      await resumeInterrupted(ctx, store, config.autoResume, resumeWindows)
    })()
    return () => {
      disposed = true
    }
  }, 'durable-exec:auto-resume')
}

function escalate(ctx: Context, agent: Agent, reason: string): void {
  const router = (ctx as unknown as { get(name: string): unknown }).get('virtualRouter') as VirtualRouterControl | undefined
  if (router !== undefined && typeof router.escalate === 'function') {
    try {
      router.escalate(agent, reason)
      ctx.logger.info(`durable-exec: escalated ${agent.session.id} through virtual-router`)
    } catch (error) {
      ctx.logger.warn('durable-exec: virtual-router escalation failed')
      ctx.logger.warn(error)
    }
  } else {
    ctx.logger.warn(`durable-exec: circuit open without a router to escalate: ${reason}`)
  }
}

async function executeWithRetry(
  exec: ToolExecution,
  next: () => Promise<ToolExecutionResult>,
  policy: ToolPolicy,
  config: DurableConfig,
  ctx: Context,
): Promise<ToolExecutionResult> {
  const retry = config.retry
  const attempts = retry.enabled && repetitionSafe(policy) ? Math.max(1, retry.maxAttempts) : 1
  let attempt = 1
  for (;;) {
    try {
      const result = await next()
      if (!result.isError || !retry.enabled || !repetitionSafe(policy) || attempt >= attempts) return result
      if (!isRetryableFailure(errorOfResult(result), retry) || exec.signal.aborted) return result
      ctx.logger.warn(`durable-exec: retrying ${exec.name} after a transient failure (attempt ${attempt}/${attempts})`)
      await abortableDelay(backoffDelay(attempt, retry), exec.signal)
      attempt += 1
    } catch (error) {
      if (!retry.enabled || !repetitionSafe(policy) || attempt >= attempts) throw error
      if (!isRetryableFailure(error, retry) || exec.signal.aborted) throw error
      ctx.logger.warn(`durable-exec: retrying ${exec.name} after a thrown transient failure (attempt ${attempt}/${attempts})`)
      await abortableDelay(backoffDelay(attempt, retry, retryAfterOf(error)), exec.signal)
      attempt += 1
    }
  }
}

async function resumeInterrupted(
  ctx: Context,
  store: LedgerStore,
  config: AutoResumeConfig,
  windows: Map<string, ResumeWindow>,
): Promise<void> {
  if (config.maxSessions <= 0) return
  const rows = store.listInterrupted(config.maxSessions, config.maxAttempts)
  for (const row of rows) {
    if (ctx.agents.get(row.sessionId as unknown as SessionId) !== undefined) continue
    try {
      if (row.status !== 'RUNNING') continue
      store.markInterrupted(row.sessionId, row.turn)
      const handle = await ctx.agents.resume({
        resumeSessionId: row.sessionId as unknown as SessionId,
        ...row.provider === undefined || row.model === undefined ? {} : {
          agentOptions: {
            provider: row.provider,
            model: row.model,
            ...row.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(row.reasoningEffort) },
          },
        },
      })
      const details = [
        `Interrupted checkpoint: turn ${row.turn}, step ${row.step}.`,
        row.goal === undefined ? undefined : `Last recorded goal: ${row.goal}`,
        row.gitHead === undefined ? undefined : `Workspace HEAD at the checkpoint: ${row.gitHead}`,
      ].filter((line): line is string => line !== undefined).join('\n')
      const message = createUserMessage({
        content: [{ type: 'text', text: `${config.prompt}\n\n${details}` }],
        source: {
          kind: 'durable-resume',
          form: 'notice',
          summary: `Resumed after process restart (turn ${row.turn})`,
        },
      })
      handle.agent.followup(message)
      store.markResumed(row.sessionId)
      windows.set(row.sessionId, {
        fromTurn: row.turn,
        untilTurn: row.turn + config.resumeWindowTurns,
      })
      ctx.logger.info(`durable-exec: resumed session ${row.sessionId} from turn ${row.turn}`)
    } catch (error) {
      ctx.logger.warn(`durable-exec: failed to resume session ${row.sessionId}`)
      ctx.logger.warn(error)
      try {
        store.markResumeFailed(row.sessionId)
      } catch {
        // The store may already be closing during shutdown; the checkpoint remains diagnostic.
      }
    }
  }
}
