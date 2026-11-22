import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backoffDelay, isRetryableFailure } from '../src/index.ts'
import type { RetryConfig } from '../src/config.ts'
import { canonicalJson, hashArguments, idempotencyKey } from '../src/hash.ts'
import { LedgerStore } from '../src/store.ts'

const roots: string[] = []

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'durable-exec-'))
  roots.push(root)
  return join(root, 'ledger.db')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonical hashing', () => {
  it('ignores object key insertion order', () => {
    const a = { z: 1, a: { y: [2, 3], b: true } }
    const b = { a: { b: true, y: [2, 3] }, z: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(hashArguments(a)).toBe(hashArguments(b))
  })

  it('keeps array order significant', () => {
    expect(hashArguments([1, 2])).not.toBe(hashArguments([2, 1]))
  })

  it('builds a stable key from call coordinates', () => {
    const base = { sessionId: 's', turn: 1, step: 2, toolName: 'write', argsHash: 'h' }
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }))
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, step: 3 }))
  })
})

describe('retry classification', () => {
  const retry: RetryConfig = {
    enabled: true,
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 2_000,
    jitterRatio: 0,
    retryableCodes: ['RATE_LIMIT', 'TIMEOUT'],
  }

  it('matches stable codes, HTTP status, and nested causes', () => {
    expect(isRetryableFailure(Object.assign(new Error('x'), { code: 'RATE_LIMIT' }), retry)).toBe(true)
    expect(isRetryableFailure(Object.assign(new Error('x'), { status: 503 }), retry)).toBe(true)
    expect(isRetryableFailure(new Error('x', { cause: Object.assign(new Error('y'), { code: 'TIMEOUT' }) }), retry)).toBe(true)
    expect(isRetryableFailure(new Error('bad'), retry)).toBe(false)
    expect(isRetryableFailure(Object.assign(new Error('x'), { code: 'INVALID_CREDENTIAL' }), retry)).toBe(false)
  })

  it('does not treat AbortError as retryable', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(isRetryableFailure(error, retry)).toBe(false)
  })

  it('grows backoff exponentially and honors provider delay within the ceiling', () => {
    expect(backoffDelay(1, retry)).toBe(100)
    expect(backoffDelay(2, retry)).toBe(200)
    expect(backoffDelay(3, retry)).toBe(400)
    expect(backoffDelay(1, retry, 5_000)).toBe(5_000)
  })
})

describe('ledger store', () => {
  it('records a pending call and replays its completed value', () => {
    const store = new LedgerStore(tempDb())
    const input = {
      key: 'k1',
      sessionId: 'session',
      turn: 1,
      step: 1,
      toolName: 'write',
      argsHash: 'args',
      policy: 'side-effect' as const,
      callId: 'call',
      ownerInstance: 'pid-1',
    }
    expect(store.begin(input).status).toBe('PENDING')
    expect(store.begin(input).ownerInstance).toBe('pid-1')
    store.complete('k1', {
      kind: 'success',
      value: { path: 'a.txt' },
      content: [{ type: 'text', text: 'wrote a.txt' }],
    })
    const entry = store.get('k1')
    expect(entry?.status).toBe('COMPLETED')
    expect(entry?.valueJson).toBe('{"path":"a.txt"}')
    expect(entry?.outputHash).toHaveLength(64)
    expect(store.recent('session', 10)).toHaveLength(1)
    store.close()
  })

  it('survives a process death with an ambiguous pending row', () => {
    const path = tempDb()
    const first = new LedgerStore(path)
    first.begin({
      key: 'k1',
      sessionId: 'session',
      turn: 1,
      step: 1,
      toolName: 'bash',
      argsHash: 'args',
      policy: 'side-effect',
      callId: 'call',
      ownerInstance: 'pid-1',
    })
    first.close()

    const second = new LedgerStore(path)
    const reused = second.begin({
      key: 'k1',
      sessionId: 'session',
      turn: 1,
      step: 1,
      toolName: 'bash',
      argsHash: 'args',
      policy: 'side-effect',
      callId: 'call',
      ownerInstance: 'pid-2',
    })
    expect(reused.status).toBe('PENDING')
    expect(reused.ownerInstance).toBe('pid-1')
    second.close()
  })

  it('resolves in-flight calls to an unknown-outcome failure before resume', () => {
    const store = new LedgerStore(tempDb())
    store.begin({
      key: 'k1', sessionId: 's', turn: 1, step: 1, toolName: 'write',
      argsHash: 'a', policy: 'side-effect', callId: 'c', ownerInstance: 'p',
    })
    store.begin({
      key: 'k2', sessionId: 's', turn: 2, step: 1, toolName: 'bash',
      argsHash: 'b', policy: 'side-effect', callId: 'd', ownerInstance: 'p',
    })
    store.markInterrupted('s', 2)
    expect(store.get('k2')?.errorCode).toBe('TOOL_OUTCOME_UNKNOWN')
    const entry = store.get('k1')
    expect(entry?.status).toBe('FAILED')
    expect(entry?.errorCode).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(entry?.errorJson).toContain('side effect')
    store.close()
  })

  it('finds a semantic match from the interrupted turn only', () => {
    const store = new LedgerStore(tempDb())
    for (const [turn, step, key] of [[1, 1, 'a'], [2, 1, 'b']] as const) {
      store.begin({
        key,
        sessionId: 's',
        turn,
        step,
        toolName: 'write',
        argsHash: 'same',
        policy: 'side-effect',
        callId: key,
        ownerInstance: 'p',
      })
      store.complete(key, { kind: 'success', value: turn, content: [] })
    }
    expect(store.findSemantic('s', 'write', 'same', 1)?.turn).toBe(1)
    expect(store.findSemantic('s', 'write', 'same', 2)?.turn).toBe(2)
    expect(store.findSemantic('s', 'write', 'same', 3)).toBeUndefined()
    store.close()
  })

  it('lists interrupted root sessions only and tracks resume attempts', () => {
    const store = new LedgerStore(tempDb())
    store.checkpoint({ sessionId: 'root', status: 'RUNNING', turn: 4, step: 2, goal: 'finish' })
    store.checkpoint({ sessionId: 'child', status: 'RUNNING', turn: 1, step: 1, origin: 'subagent' })
    expect(store.listInterrupted(10, 1)).toHaveLength(1)
    expect(store.listInterrupted(10, 1)[0]?.sessionId).toBe('root')

    store.markResumed('root')
    expect(store.getCheckpoint('root')?.resumeCount).toBe(1)
    expect(store.listInterrupted(10, 1)).toHaveLength(0)

    store.markResumeFailed('root')
    expect(store.getCheckpoint('root')?.status).toBe('IDLE')
    store.close()
  })

  it('keeps the original goal when a step checkpoint has no goal', () => {
    const store = new LedgerStore(tempDb())
    store.checkpoint({ sessionId: 's', status: 'RUNNING', turn: 1, step: 0, goal: 'original' })
    store.checkpoint({ sessionId: 's', status: 'RUNNING', turn: 1, step: 1 })
    expect(store.getCheckpoint('s')?.goal).toBe('original')
    store.close()
  })
})
