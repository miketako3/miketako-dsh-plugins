import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Config } from '../src/config.ts'
import { AuditSink } from '../src/audit.ts'
import { VirtualModelAdapter } from '../src/adapter.ts'
import { detectPhase, estimateTokens, RouterEngine } from '../src/router.ts'

const LOG = { info() {}, warn() {}, debug() {} }

function config(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'virtual',
    displayName: 'Virtual Router',
    models: [{
      id: 'autonomous',
      name: 'Autonomous',
      contextWindow: 262_144,
      defaultTier: 'cheap',
    }],
    tiers: [
      { id: 'cheap', provider: 'p', model: 'small' },
      { id: 'strong', provider: 'p', model: 'large', inputCostPerMTok: 3 },
    ],
    phaseRoutes: { plan: 'cheap', implement: 'strong', verify: 'cheap', default: 'cheap' },
    escalation: { enabled: true, afterFailures: 2, ladder: ['cheap', 'strong'] },
    fallback: { enabled: true, routes: [{ provider: 'backup', model: 'safe' }], codes: ['RATE_LIMIT', 'SERVER_ERROR'], statuses: [429, 503] },
    budget: { maxTokens: 0, maxRequests: 0, onExhausted: 'stop', downgradeTier: '' },
    sticky: { enabled: true, perTurn: true },
    auditPath: '',
    phaseDetection: {
      enabled: true,
      plan: ['plan', 'design'],
      implement: ['implement', 'fix'],
      verify: ['test', 'verify'],
    },
    ...overrides,
  }
}

function user(text: string): { role: 'user'; content: ContentBlock[] } {
  return { role: 'user', content: [{ type: 'text', text }] }
}

describe('phase detection and estimates', () => {
  it('detects verify before implement', () => {
    const cfg = config().phaseDetection
    expect(detectPhase([user('implement it and run the tests')], cfg)).toBe('verify')
    expect(detectPhase([user('plan the design first')], cfg)).toBe('plan')
    expect(detectPhase([user('fix the parser')], cfg)).toBe('implement')
    expect(detectPhase([user('hello')], cfg)).toBe('default')
    expect(detectPhase([user('anything')], cfg, 'compaction')).toBe('summarize')
  })

  it('estimates input tokens from text and tools', () => {
    const tokens = estimateTokens([user('a'.repeat(400))], [{ name: 'read', description: 'd', parameters: {} }])
    expect(tokens).toBeGreaterThanOrEqual(100)
  })
})

describe('routing rules', () => {
  it('routes by phase', () => {
    const engine = new RouterEngine(config())
    const strong = engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('implement the parser')] })
    expect(strong.kind).toBe('route')
    if (strong.kind === 'route') {
      expect(strong.route.model).toBe('large')
      expect(strong.phase).toBe('implement')
    }
    const cheap = engine.decide({ sessionId: 's2', turn: 1, model: 'autonomous', messages: [user('plan the design')] })
    if (cheap.kind === 'route') expect(cheap.route.model).toBe('small')
  })

  it('keeps the route sticky within a turn and clears it on the next turn', () => {
    const engine = new RouterEngine(config())
    engine.noteTurn('s', 1)
    const first = engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('plan')] })
    if (first.kind !== 'route') throw new Error('expected route')
    engine.recordSuccess('s', first.route)
    const second = engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('implement')] })
    expect(second.kind).toBe('route')
    if (second.kind === 'route') expect(second.reason).toBe('sticky turn')
    engine.noteTurn('s', 2)
    const third = engine.decide({ sessionId: 's', turn: 2, model: 'autonomous', messages: [user('implement')] })
    if (third.kind === 'route') expect(third.route.model).toBe('large')
  })

  it('escalates after repeated failures', () => {
    const engine = new RouterEngine(config())
    const first = engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('plan')] })
    if (first.kind !== 'route') throw new Error('expected route')
    engine.recordFailure('s', first.route)
    engine.recordFailure('s', first.route)
    const escalated = engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('plan')] })
    expect(escalated.kind).toBe('route')
    if (escalated.kind === 'route') {
      expect(escalated.route.model).toBe('large')
      expect(escalated.reason).toContain('failure escalation')
    }
  })

  it('stops when the request budget is exhausted', () => {
    const engine = new RouterEngine(config({ budget: { maxTokens: 0, maxRequests: 1, onExhausted: 'stop', downgradeTier: '' } }))
    expect(engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('plan')] }).kind).toBe('route')
    const stopped = engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('plan')] })
    expect(stopped.kind).toBe('stop')
    if (stopped.kind === 'stop') expect(stopped.reason).toContain('request budget')
  })

  it('downgrades instead of stopping when configured', () => {
    const engine = new RouterEngine(config({
      budget: { maxTokens: 0, maxRequests: 1, onExhausted: 'downgrade', downgradeTier: 'cheap' },
      tiers: [
        { id: 'cheap', provider: 'p', model: 'small', inputCostPerMTok: 1 },
        { id: 'strong', provider: 'p', model: 'large', inputCostPerMTok: 3 },
      ],
    }))
    engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('plan')] })
    const downgraded = engine.decide({ sessionId: 's', turn: 1, model: 'autonomous', messages: [user('plan')] })
    expect(downgraded.kind).toBe('route')
    if (downgraded.kind === 'route') {
      expect(downgraded.route.model).toBe('small')
      expect(downgraded.reason).toContain('downgraded')
    }
  })

  it('matches fallback codes and statuses', () => {
    const engine = new RouterEngine(config())
    expect(engine.shouldFallback('RATE_LIMIT', 429)).toBe(true)
    expect(engine.shouldFallback('UNKNOWN', 503)).toBe(true)
    expect(engine.shouldFallback('AUTH', 401)).toBe(false)
  })
})

function chunking(routes: string[], failFirst: boolean): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  let call = 0
  return () => {
    call += 1
    const shouldFail = failFirst && call === 1
    return (async function* () {
      if (shouldFail) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } },
        } as StreamChunk
        return
      }
      yield { type: 'text-delta', index: 0, text: `from ${routes[call - 1] ?? 'unknown'}` } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    })()
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('virtual adapter', () => {
  it('falls back before any content is emitted', async () => {
    const engine = new RouterEngine(config())
    const adapter = new VirtualModelAdapter(
      { llm: { stream: chunking(['primary', 'backup'], true) } } as unknown as Context,
      engine,
      new AuditSink('', LOG),
      config(),
    )
    const chunks = await collect(adapter.stream({
      provider: 'virtual',
      model: 'autonomous',
      messages: [user('plan')] as never,
    }))
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from backup')).toBe(true)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(engine.snapshot('anonymous').route?.provider).toBe('backup')
  })

  it('does not fall back after content was emitted', async () => {
    let call = 0
    const stream = () => {
      call += 1
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' } as StreamChunk
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'server', code: 'SERVER_ERROR', status: 503 } },
        } as StreamChunk
      })()
    }
    const engine = new RouterEngine(config())
    const adapter = new VirtualModelAdapter(
      { llm: { stream } } as unknown as Context,
      engine,
      new AuditSink('', LOG),
      config(),
    )
    const chunks = await collect(adapter.stream({
      provider: 'virtual',
      model: 'autonomous',
      messages: [user('plan')] as never,
    }))
    expect(call).toBe(1)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(1)
    expect(chunks.at(-1)?.type).toBe('finish')
    if (chunks.at(-1)?.type === 'finish') expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error' } })
  })

  it('emits a budget stop without calling a provider', async () => {
    let calls = 0
    const limited = new RouterEngine(config({ budget: { maxTokens: 0, maxRequests: 1, onExhausted: 'stop', downgradeTier: '' } }))
    limited.recordAttempt('anonymous', 1)
    const adapter = new VirtualModelAdapter(
      { llm: { stream: () => { calls += 1; return (async function* () {})() } } } as unknown as Context,
      limited,
      new AuditSink('', LOG),
      limited.config,
    )
    const chunks = await collect(adapter.stream({
      provider: 'virtual',
      model: 'autonomous',
      messages: [user('plan')] as never,
    }))
    expect(calls).toBe(0)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'BUDGET_EXCEEDED' } } })
    expect(limited.stateOf('anonymous').requests).toBe(1)
  })
})
