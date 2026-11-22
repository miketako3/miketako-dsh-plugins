/**
 * Structured audit sink for routing decisions.
 *
 * Every decision is appended as one JSON line (when a path is configured) and
 * kept in a bounded in-memory ring for status tools. A file failure never
 * breaks a model request.
 *
 * @module dsh-plugin-virtual-router/audit
 */

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RouteConfig } from './config.ts'
import type { RoutePhase } from './router.ts'

/** Minimal logger surface accepted by the audit sink. */
export interface LogSink {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

/** One audited routing event. */
export interface AuditRecord {
  readonly ts: number
  readonly event: 'route' | 'fallback' | 'stop' | 'escalate'
  readonly sessionId: string
  readonly turn: number
  readonly phase?: RoutePhase
  readonly purpose?: string
  readonly virtualModel: string
  readonly from?: RouteConfig
  readonly to?: RouteConfig
  readonly reason: string
  readonly failures?: number
  readonly estimatedInputTokens?: number
  readonly estimatedCostDelta?: number
  readonly outcome?: 'success' | 'failure' | 'blocked'
}

/** Bounded audit writer. */
export class AuditSink {
  private readonly recentRecords: AuditRecord[] = []
  private directoryReady = false

  /**
   * @param path - JSONL path; empty disables file output.
   * @param logger - host logger for human-readable events.
   * @param capacity - in-memory ring size.
   */
  constructor(
    private readonly path: string,
    private readonly logger: LogSink,
    private readonly capacity = 500,
  ) {}

  /**
   * Append one record.
   * @param record - structured event.
   */
  write(record: AuditRecord): void {
    this.recentRecords.push(record)
    if (this.recentRecords.length > this.capacity) this.recentRecords.splice(0, this.recentRecords.length - this.capacity)
    if (record.event === 'fallback' || record.event === 'stop' || record.event === 'escalate') {
      this.logger.info(`virtual-router: ${record.event} ${record.reason}`)
    } else {
      this.logger.debug(`virtual-router: route ${record.to?.provider}/${record.to?.model} (${record.reason})`)
    }
    if (this.path.length === 0) return
    try {
      if (!this.directoryReady) {
        mkdirSync(dirname(this.path), { recursive: true })
        this.directoryReady = true
      }
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(this.path, 0o600)
      } catch {
        // A file system without POSIX modes is still usable; keep the audit.
      }
    } catch (error) {
      this.logger.warn('virtual-router: audit append failed', error)
    }
  }

  /**
   * Read the newest in-memory records.
   * @param limit - maximum records.
   * @returns newest first.
   */
  recent(limit = 20): AuditRecord[] {
    return this.recentRecords.slice(-Math.max(1, limit)).reverse()
  }
}
