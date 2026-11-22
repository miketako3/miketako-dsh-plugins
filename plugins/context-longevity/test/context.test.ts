import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { collectCommands, collectFilePaths, enrichSummary } from '../src/compaction.ts'
import { composeAllowList, DeferredToolController, rankTools } from '../src/deferred.ts'
import type { StructuredCompactionConfig } from '../src/config.ts'

function definition(name: string, description: string): ToolDefinition {
  return { name, description, parameters: {}, output: { schema: { type: 'null' } } } as unknown as ToolDefinition
}

const OPTIONS: StructuredCompactionConfig = {
  instruction: true,
  requiredHeadings: [
    'Primary Request and Intent',
    'Decisions and Constraints',
    'Files and Code',
    'Verification',
    'Open Issues',
    'Next Step',
  ],
  retainFiles: true,
  retainCommands: true,
  maxRetainedFiles: 10,
  maxRetainedCommands: 5,
}

function message(content: ContentBlock[], role: Message['role'] = 'assistant'): Message {
  return { id: `m${Math.random()}`, role, content, source: { kind: 'user' } } as unknown as Message
}

function toolCall(name: string, args: unknown): ContentBlock {
  return { type: 'tool-call', id: `call-${name}`, name, arguments: JSON.stringify(args) } as ContentBlock
}

describe('tool ranking', () => {
  const definitions = [
    definition('read', 'Read a file'),
    definition('web_fetch', 'Fetch a web page'),
    definition('web_search', 'Search the web'),
    definition('bash', 'Run a shell command'),
    definition('discover_tools', 'Search tools'),
  ]

  it('ranks name matches above description matches', () => {
    expect(rankTools(definitions, 'web', 5).map(tool => tool.name)).toEqual(['web_fetch', 'web_search'])
    expect(rankTools(definitions, 'file', 5).map(tool => tool.name)).toEqual(['read'])
  })

  it('excludes the control tools', () => {
    expect(rankTools(definitions, '', 10).map(tool => tool.name)).not.toContain('discover_tools')
  })

  it('returns every non-control tool for an empty query', () => {
    expect(rankTools(definitions, '', 10)).toHaveLength(4)
  })
})

describe('allow-list composition', () => {
  it('keeps the always-active core and applies the cap', () => {
    const all = new Set(['read', 'write', 'bash', 'web_fetch', 'web_search'])
    const always = new Set(['read', 'write'])
    const activated = new Set(['web_fetch', 'web_search'])
    expect(composeAllowList(all, always, activated, 3)).toEqual(['read', 'web_fetch', 'write'])
    expect(composeAllowList(all, always, activated, 10)).toEqual(['read', 'web_fetch', 'web_search', 'write'])
  })
})

describe('deterministic retention', () => {
  it('collects file paths from tool arguments and text', () => {
    const messages = [
      message([toolCall('write', { file_path: 'src/a.ts' })], 'assistant'),
      message([{ type: 'text', text: 'Edited src/b.ts and node_modules/x.ts, see https://example.com/c.ts' }], 'user'),
    ]
    expect(collectFilePaths(messages, 10)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('collects shell commands', () => {
    const messages = [message([toolCall('bash', { command: 'pnpm test' }), toolCall('bash', { command: 'pnpm test' })])]
    expect(collectCommands(messages, 5)).toEqual(['pnpm test'])
  })
})

describe('structured summary enrichment', () => {
  it('appends every missing section with retained facts', () => {
    const messages = [
      message([{ type: 'text', text: 'Implement the parser and run the tests.' }], 'user'),
      message([toolCall('write', { file_path: 'src/parser.ts' }), toolCall('bash', { command: 'pnpm test' })]),
    ]
    const summary: ContentBlock[] = [{ type: 'text', text: '## Key Technical Concepts\nParser design.' }]
    const enriched = enrichSummary(summary, messages, OPTIONS)
    const text = enriched.filter(block => block.type === 'text').map(block => block.text).join('\n')
    for (const heading of OPTIONS.requiredHeadings) expect(text).toContain(`## ${heading}`)
    expect(text).toContain('src/parser.ts')
    expect(text).toContain('pnpm test')
    expect(text).toContain('Implement the parser')
    expect(text).toContain('## Retained Facts')
  })

  it('does not duplicate sections the model already produced', () => {
    const summary: ContentBlock[] = [{
      type: 'text',
      text: [
        '## Primary Request and Intent',
        'Do it.',
        '## Files and Code',
        'src/a.ts',
        '## Verification',
        'pnpm test',
        '## Open Issues',
        'none',
        '## Next Step',
        'ship',
      ].join('\n'),
    }]
    const enriched = enrichSummary(summary, [], OPTIONS)
    const text = enriched.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text.match(/## Files and Code/g)).toHaveLength(1)
    expect(text).not.toContain('## Retained Facts')
  })
})

interface FakeToolRegistry {
  definitions(): ToolDefinition[]
  restrict(filter: { allow?: readonly string[] }): () => void
}

function fakeAgent(id: string, registry: FakeToolRegistry, restrictions: string[][]): Agent {
  return {
    session: { id },
    ctx: {
      tools: {
        restrict(filter: { allow?: readonly string[] }) {
          restrictions.push([...(filter.allow ?? [])])
          return () => {}
        },
      },
      systemPrompt: {
        section() { return () => {} },
      },
    },
  } as unknown as Agent
}

describe('deferred tool controller', () => {
  it('restricts a large registry and activates hidden tools', () => {
    const definitions = Array.from({ length: 30 }, (_, index) => definition(`tool${index}`, `Tool ${index}`))
    definitions[0] = definition('read', 'Read a file')
    definitions[1] = definition('discover_tools', 'Search tools')
    definitions[2] = definition('activate_tools', 'Activate tools')
    const restrictions: string[][] = []
    const registry = {
      definitions: () => definitions,
      restrict: () => () => {},
    }
    const ctx = { tools: registry } as unknown as Context
    const controller = new DeferredToolController(ctx, {
      enabled: true,
      threshold: 10,
      alwaysActive: ['read', 'discover_tools', 'activate_tools'],
      maxActive: 5,
      discoverLimit: 10,
      prompt: false,
    })
    const agent = fakeAgent('session', registry, restrictions)
    controller.attach(agent)

    expect(restrictions).toHaveLength(1)
    expect(restrictions[0]).toEqual(['activate_tools', 'discover_tools', 'read'])

    const result = controller.activate(agent, ['tool3', 'missing', 'read'])
    expect(result.activated).toEqual(['tool3'])
    expect(result.alreadyActive).toEqual(['read'])
    expect(result.unknown).toEqual(['missing'])
    expect(controller.activeTools(agent)).toEqual(['activate_tools', 'discover_tools', 'read', 'tool3'])

    controller.activate(agent, ['tool4', 'tool5', 'tool6'])
    expect(controller.activeTools(agent)).toHaveLength(5)
  })

  it('releases restrictions and prompt sections on dispose', () => {
    const definitions = Array.from({ length: 30 }, (_, index) => definition(`tool${index}`, `Tool ${index}`))
    const released: string[] = []
    let sectionText: (() => string) | undefined
    const registry = { definitions: () => definitions, restrict: () => () => {} }
    const ctx = { tools: registry } as unknown as Context
    const controller = new DeferredToolController(ctx, {
      enabled: true,
      threshold: 10,
      alwaysActive: [],
      maxActive: 5,
      discoverLimit: 10,
      prompt: true,
    })
    const agent = {
      session: { id: 'session' },
      ctx: {
        tools: {
          restrict() {
            return () => released.push('restriction')
          },
        },
        systemPrompt: {
          section(options: { text: () => string }) {
            sectionText = options.text
            return () => released.push('section')
          },
        },
      },
    } as unknown as Agent
    controller.attach(agent)
    expect(sectionText?.()).toContain('discover_tools')
    controller.dispose()
    expect(released.sort()).toEqual(['restriction', 'section'])
    expect(controller.activeTools(agent)).toEqual([])
  })

  it('leaves a small registry unrestricted', () => {
    const restrictions: string[][] = []
    const definitions = [definition('read', 'Read'), definition('write', 'Write')]
    const registry = { definitions: () => definitions, restrict: () => () => {} }
    const ctx = { tools: registry } as unknown as Context
    const controller = new DeferredToolController(ctx, {
      enabled: true,
      threshold: 20,
      alwaysActive: ['read'],
      maxActive: 10,
      discoverLimit: 10,
      prompt: false,
    })
    controller.attach(fakeAgent('session', registry, restrictions))
    expect(restrictions).toHaveLength(0)
    expect(controller.discover(undefined, '', 10).total).toBe(2)
  })
})
