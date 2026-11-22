/**
 * SQLite-backed idempotency ledger and checkpoint store.
 *
 * `node:sqlite` is part of the Node.js standard library, so the plugin adds no
 * native dependency. WAL keeps a synchronous write cheap and durable enough for
 * a crash immediately after a tool returns.
 *
 * @module dsh-plugin-durable-exec/store
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ToolPolicy } from './config.ts'

/** Lifecycle state of one recorded tool execution. */
export type LedgerStatus = 'PENDING' | 'COMPLETED' | 'FAILED'

/** One idempotency-ledger row. */
export interface LedgerEntry {
  readonly key: string
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly toolName: string
  readonly argsHash: string
  readonly policy: ToolPolicy
  readonly status: LedgerStatus
  readonly callId: string
  readonly ownerInstance: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly resultKind?: 'success' | 'error'
  readonly valueJson?: string
  readonly contentJson?: string
  readonly errorJson?: string
  readonly outputHash?: string
  readonly errorCode?: string
}

/** Durable checkpoint for one session. */
export interface CheckpointRecord {
  readonly sessionId: string
  readonly status: 'RUNNING' | 'IDLE'
  readonly turn: number
  readonly step: number
  readonly goal?: string
  readonly cwd?: string
  readonly gitHead?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly origin?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly resumeCount: number
  readonly lastResumedAt?: number
}

/** Tool result shape persisted for replay. */
export interface PersistedResult {
  readonly kind: 'success' | 'error'
  readonly value?: unknown
  readonly content: readonly unknown[]
  readonly error?: { readonly message: string; readonly info?: { readonly name: string; readonly code: string; readonly reason?: string } }
  readonly errorCode?: string
}

/** Input fields needed to open a ledger row. */
export interface BeginInput {
  readonly key: string
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly toolName: string
  readonly argsHash: string
  readonly policy: ToolPolicy
  readonly callId: string
  readonly ownerInstance: string
}

/** Checkpoint upsert fields. */
export interface CheckpointInput {
  readonly sessionId: string
  readonly status: 'RUNNING' | 'IDLE'
  readonly turn: number
  readonly step: number
  readonly goal?: string
  readonly cwd?: string
  readonly gitHead?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly origin?: string
}

type Row = Record<string, unknown>

function textOf(row: Row, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' ? value : undefined
}

function numberOf(row: Row, key: string): number | undefined {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function entryOf(row: Row): LedgerEntry {
  const entry: {
    -readonly [K in keyof LedgerEntry]: LedgerEntry[K]
  } = {
    key: String(row['idempotency_key']),
    sessionId: String(row['session_id']),
    turn: Number(row['turn']),
    step: Number(row['step']),
    toolName: String(row['tool_name']),
    argsHash: String(row['args_hash']),
    policy: String(row['policy']) as ToolPolicy,
    status: String(row['status']) as LedgerStatus,
    callId: String(row['call_id']),
    ownerInstance: String(row['owner_instance']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  }
  const resultKind = textOf(row, 'result_kind')
  if (resultKind !== undefined) entry.resultKind = resultKind as 'success' | 'error'
  const valueJson = textOf(row, 'value_json')
  if (valueJson !== undefined) entry.valueJson = valueJson
  const contentJson = textOf(row, 'content_json')
  if (contentJson !== undefined) entry.contentJson = contentJson
  const errorJson = textOf(row, 'error_json')
  if (errorJson !== undefined) entry.errorJson = errorJson
  const outputHash = textOf(row, 'output_hash')
  if (outputHash !== undefined) entry.outputHash = outputHash
  const errorCode = textOf(row, 'error_code')
  if (errorCode !== undefined) entry.errorCode = errorCode
  return entry
}

function checkpointOf(row: Row): CheckpointRecord {
  const checkpoint: {
    -readonly [K in keyof CheckpointRecord]: CheckpointRecord[K]
  } = {
    sessionId: String(row['session_id']),
    status: String(row['status']) as 'RUNNING' | 'IDLE',
    turn: Number(row['turn']),
    step: Number(row['step']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    resumeCount: Number(row['resume_count']),
  }
  const goal = textOf(row, 'goal')
  if (goal !== undefined) checkpoint.goal = goal
  const cwd = textOf(row, 'cwd')
  if (cwd !== undefined) checkpoint.cwd = cwd
  const gitHead = textOf(row, 'git_head')
  if (gitHead !== undefined) checkpoint.gitHead = gitHead
  const provider = textOf(row, 'provider')
  if (provider !== undefined) checkpoint.provider = provider
  const model = textOf(row, 'model')
  if (model !== undefined) checkpoint.model = model
  const reasoningEffort = textOf(row, 'reasoning_effort')
  if (reasoningEffort !== undefined) checkpoint.reasoningEffort = reasoningEffort
  const origin = textOf(row, 'origin')
  if (origin !== undefined) checkpoint.origin = origin
  const lastResumedAt = numberOf(row, 'last_resumed_at')
  if (lastResumedAt !== undefined) checkpoint.lastResumedAt = lastResumedAt
  return checkpoint
}

/** Durable ledger opened for one plugin lifecycle. */
export class LedgerStore {
  private readonly db: DatabaseSync

  /**
   * Open or create the ledger database.
   * @param path - absolute or user-relative SQLite file path.
   */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // A file system without POSIX modes is still usable; keep the ledger.
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tool_executions (
        idempotency_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        step INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        policy TEXT NOT NULL,
        status TEXT NOT NULL,
        call_id TEXT NOT NULL,
        owner_instance TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        result_kind TEXT,
        value_json TEXT,
        content_json TEXT,
        error_json TEXT,
        output_hash TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS tool_executions_semantic
        ON tool_executions (session_id, tool_name, args_hash, turn);
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        turn INTEGER NOT NULL,
        step INTEGER NOT NULL,
        goal TEXT,
        cwd TEXT,
        git_head TEXT,
        provider TEXT,
        model TEXT,
        reasoning_effort TEXT,
        origin TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resume_count INTEGER NOT NULL DEFAULT 0,
        last_resumed_at INTEGER
      );
    `)
  }

  /**
   * Insert a PENDING row unless the exact key already exists.
   * @param input - call coordinates.
   * @returns the row that now owns the key.
   */
  begin(input: BeginInput): LedgerEntry {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO tool_executions (
        idempotency_key, session_id, turn, step, tool_name, args_hash, policy,
        status, call_id, owner_instance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      input.key, input.sessionId, input.turn, input.step, input.toolName,
      input.argsHash, input.policy, input.callId, input.ownerInstance, now, now,
    )
    return this.get(input.key) ?? this.fallbackEntry(input, now)
  }

  /** Build a detached row when the insert was rejected by a concurrent owner. */
  private fallbackEntry(input: BeginInput, now: number): LedgerEntry {
    return {
      ...input,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Read one row by idempotency key.
   * @param key - exact key.
   * @returns the row, or undefined.
   */
  get(key: string): LedgerEntry | undefined {
    const row = this.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key = ?').get(key) as Row | undefined
    return row === undefined ? undefined : entryOf(row)
  }

  /**
   * Persist the final outcome of one call.
   * @param key - exact key.
   * @param result - lossless result projection.
   */
  complete(key: string, result: PersistedResult): void {
    const hash = createHash('sha256')
      .update(result.kind === 'success' ? JSON.stringify(result.value ?? null) : JSON.stringify(result.error ?? null))
      .digest('hex')
    this.db.prepare(`
      UPDATE tool_executions SET
        status = ?, result_kind = ?, value_json = ?, content_json = ?, error_json = ?,
        output_hash = ?, error_code = ?, updated_at = ?
      WHERE idempotency_key = ?
    `).run(
      result.kind === 'success' ? 'COMPLETED' : 'FAILED',
      result.kind,
      result.kind === 'success' ? JSON.stringify(result.value ?? null) : null,
      JSON.stringify(result.content),
      result.error === undefined ? null : JSON.stringify(result.error),
      hash,
      result.errorCode ?? null,
      Date.now(),
      key,
    )
  }

  /**
   * Find the newest prior row for the same logical call.
   * @param sessionId - session identity.
   * @param toolName - tool name.
   * @param argsHash - canonical argument digest.
   * @param turn - exact turn to search.
   * @returns the newest matching row, or undefined.
   */
  findSemantic(sessionId: string, toolName: string, argsHash: string, turn: number): LedgerEntry | undefined {
    const row = this.db.prepare(`
      SELECT * FROM tool_executions
      WHERE session_id = ? AND tool_name = ? AND args_hash = ? AND turn = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId, toolName, argsHash, turn) as Row | undefined
    return row === undefined ? undefined : entryOf(row)
  }


  /**
   * Read the newest ledger rows for one session.
   * @param sessionId - session identity.
   * @param limit - maximum rows.
   * @returns newest rows first.
   */
  recent(sessionId: string, limit: number): LedgerEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM tool_executions
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit) as Row[]
    return rows.map(entryOf)
  }

  /**
   * Upsert the current session checkpoint.
   * @param input - checkpoint fields.
   */
  checkpoint(input: CheckpointInput): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO checkpoints (
        session_id, status, turn, step, goal, cwd, git_head, provider, model,
        reasoning_effort, origin, created_at, updated_at, resume_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        turn = excluded.turn,
        step = excluded.step,
        goal = COALESCE(excluded.goal, checkpoints.goal),
        cwd = COALESCE(excluded.cwd, checkpoints.cwd),
        git_head = COALESCE(excluded.git_head, checkpoints.git_head),
        provider = COALESCE(excluded.provider, checkpoints.provider),
        model = COALESCE(excluded.model, checkpoints.model),
        reasoning_effort = COALESCE(excluded.reasoning_effort, checkpoints.reasoning_effort),
        origin = COALESCE(excluded.origin, checkpoints.origin),
        updated_at = excluded.updated_at
    `).run(
      input.sessionId, input.status, input.turn, input.step,
      input.goal ?? null, input.cwd ?? null, input.gitHead ?? null,
      input.provider ?? null, input.model ?? null, input.reasoningEffort ?? null,
      input.origin ?? null, now, now,
    )
  }

  /**
   * Read one session checkpoint.
   * @param sessionId - session identity.
   * @returns the checkpoint, or undefined.
   */
  getCheckpoint(sessionId: string): CheckpointRecord | undefined {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE session_id = ?').get(sessionId) as Row | undefined
    return row === undefined ? undefined : checkpointOf(row)
  }

  /**
   * List sessions that were mid-turn when the previous process died.
   * @param limit - maximum rows.
   * @param maxAttempts - exclude rows already resumed at least this many times.
   * @returns interrupted root-session checkpoints, newest first.
   */
  listInterrupted(limit: number, maxAttempts: number): CheckpointRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE status = 'RUNNING'
        AND (origin IS NULL OR origin <> 'subagent')
        AND resume_count < ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(maxAttempts, limit) as Row[]
    return rows.map(checkpointOf)
  }

  /**
   * Remove a pending row for a call that never reached execution (denied,
   * cancelled, or awaiting approval). A later execution begins a fresh row.
   * @param key - idempotency key.
   */
  discard(key: string): void {
    this.db.prepare("DELETE FROM tool_executions WHERE idempotency_key = ? AND status = 'PENDING'").run(key)
  }

  /**
   * Resolve every in-flight call of an interrupted turn as an unknown outcome.
   * A side effect whose completion was never observed must not be replayed as a
   * success, and leaving it PENDING would make every later retry ambiguous.
   * @param sessionId - crashed session.
   * @param turn - highest interrupted turn to resolve.
   */
  markInterrupted(sessionId: string, turn: number): void {
    const message = [
      'The harness process stopped while this tool call was in flight, so whether',
      'its side effect was applied is unknown. Inspect the external state before',
      'repeating, compensating, or continuing.',
    ].join(' ')
    this.db.prepare(`
      UPDATE tool_executions SET
        status = 'FAILED', result_kind = 'error', error_json = ?,
        error_code = 'TOOL_OUTCOME_UNKNOWN', updated_at = ?
      WHERE session_id = ? AND status = 'PENDING' AND turn <= ?
    `).run(
      JSON.stringify({ message, info: { name: 'InterruptedToolError', code: 'TOOL_OUTCOME_UNKNOWN' } }),
      Date.now(), sessionId, turn,
    )
  }

  /**
   * Record one automatic resume attempt.
   * @param sessionId - resumed session.
   */
  markResumed(sessionId: string): void {
    this.db.prepare(`
      UPDATE checkpoints SET resume_count = resume_count + 1, last_resumed_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(Date.now(), Date.now(), sessionId)
  }

  /**
   * Mark a session idle after a failed resume attempt so it is not retried.
   * @param sessionId - session identity.
   */
  markResumeFailed(sessionId: string): void {
    this.db.prepare(`
      UPDATE checkpoints SET status = 'IDLE', updated_at = ? WHERE session_id = ?
    `).run(Date.now(), sessionId)
  }

  /** Close the database handle. */
  close(): void {
    this.db.close()
  }
}
