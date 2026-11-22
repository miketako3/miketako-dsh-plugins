/**
 * Deterministic JSON normalization and hashing for idempotency keys.
 *
 * @module dsh-plugin-durable-exec/hash
 */

import { createHash } from 'node:crypto'

/**
 * Return whether a value can be represented as lossless JSON.
 * @param value - candidate value.
 * @returns true for JSON scalars, arrays, and plain objects with finite numbers.
 */
export function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isJsonValue(item))
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value as Record<string, unknown>).every(entry => isJsonValue(entry))
}

/**
 * Serialize a JSON value with object keys sorted at every depth, so two
 * argument objects that differ only in key insertion order hash identically.
 * @param value - lossless JSON value.
 * @returns canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => {
    return `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  }).join(',')}}`
}

/**
 * Hash canonicalized tool arguments with SHA-256.
 * @param args - parsed tool arguments.
 * @returns lowercase hexadecimal digest.
 */
export function hashArguments(args: unknown): string {
  const canonical = canonicalJson(args)
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Build the deterministic idempotency key for one model-authored tool call.
 *
 * The identity deliberately excludes the model-generated `callId`: a resumed
 * or replayed turn may issue a fresh call id for the same logical operation.
 * @param fields - complete call coordinates.
 * @returns stable key string.
 */
export function idempotencyKey(fields: {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly toolName: string
  readonly argsHash: string
}): string {
  return [fields.sessionId, String(fields.turn), String(fields.step), fields.toolName, fields.argsHash].join('\u0000')
}
