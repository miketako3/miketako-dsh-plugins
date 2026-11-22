/**
 * Structured compaction backend.
 *
 * `BasicCompactionEngine` already produces a durable summary with a strict
 * template. This subclass adds two guarantees:
 *
 * 1. the summarization call receives an explicit output contract with the
 *    sections a long-running task needs (request, decisions, files,
 *    verification, open issues, next step), and
 * 2. the returned summary is enriched deterministically with file paths and
 *    shell commands observed in the summarized region, so a model omission
 *    cannot silently drop the facts a resumed run needs.
 *
 * @module dsh-plugin-context-longevity/compaction
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { DEFAULT_COMPACTION_INSTRUCTION } from './config.ts'
import type { StructuredCompactionConfig } from './config.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Summarization-only instruction appended by structured compaction. */
    'context-longevity': {
      kind: 'context-longevity'
      form: 'notice'
      summary: string
    }
  }
}

/** Fallback contract when the host service is not mounted. */
const FALLBACK_OPTIONS: StructuredCompactionConfig = {
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
  maxRetainedFiles: 40,
  maxRetainedCommands: 10,
}

/** Canonical heading aliases used to decide whether a section already exists. */
const HEADING_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'Primary Request and Intent': ['primary request', 'request and intent', '目的', '依頼'],
  'Decisions and Constraints': ['decision', 'decided', 'constraint', '決定', '制約'],
  'Files and Code': ['files and code', 'files', 'changed files', 'files touched', '変更ファイル'],
  'Verification': ['verification', 'verified', 'verification state', '検証', 'テスト'],
  'Open Issues': ['open issue', 'unresolved', 'pending task', 'remaining issue', '未解決', '課題'],
  'Next Step': ['next step', 'next action', 'optional next', '次アクション', '次の'],
}

const FILE_PATH_PATTERN = /(?:[A-Za-z]:\\|\/|\.{1,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,10}/g

/** Tools whose arguments carry a target path. */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multi_edit', 'apply_patch', 'notebook_edit'])

/** Tools whose arguments carry a shell command. */
const COMMAND_TOOLS = new Set(['bash', 'shell', 'exec_command', 'run_command'])

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function extractPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 1 && !trimmed.includes('://') ? trimmed : undefined
}

/**
 * Collect file paths named in tool arguments or visible text.
 * @param messages - summarized conversation region.
 * @param limit - maximum paths.
 * @returns unique paths in first-seen order.
 */
export function collectFilePaths(messages: readonly Message[], limit: number): string[] {
  const found = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value === undefined || found.size >= limit) return
    if (value.startsWith('http') || value.includes('node_modules/')) return
    found.add(value)
  }
  for (const message of messages) {
    const sourceKind = (message.source as { kind?: string } | undefined)?.kind
    const authored = message.role === 'assistant'
      || (message.role === 'user' && (sourceKind === undefined || ['user', 'durable-resume', 'agent', 'hook', 'parent'].includes(sourceKind)))
    for (const block of message.content) {
      if (block.type === 'tool-call' && FILE_TOOLS.has(block.name)) {
        const args = parseArguments(block.arguments)
        if (args !== undefined) {
          add(extractPath(args['file_path']))
          add(extractPath(args['path']))
          add(extractPath(args['notebook_path']))
        }
      } else if (block.type === 'text' && authored) {
        const withoutUrls = block.text.replace(/https?:\/\/\S+/g, ' ')
        for (const match of withoutUrls.matchAll(FILE_PATH_PATTERN)) {
          add(match[0]?.replace(/[),.;:]+$/, ''))
        }
      }
    }
  }
  return [...found].slice(0, limit)
}

/**
 * Collect shell commands issued in the summarized region.
 * @param messages - summarized conversation region.
 * @param limit - maximum commands.
 * @returns unique commands in first-seen order.
 */
export function collectCommands(messages: readonly Message[], limit: number): string[] {
  const found = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-call' || !COMMAND_TOOLS.has(block.name)) continue
      const args = parseArguments(block.arguments)
      const command = args === undefined ? undefined : args['command']
      if (typeof command !== 'string') continue
      const trimmed = command.trim().replace(/\s+/g, ' ')
      if (trimmed.length > 0) found.add(trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed)
      if (found.size >= limit) return [...found]
    }
  }
  return [...found]
}

function hasHeading(text: string, heading: string): boolean {
  const aliases = HEADING_ALIASES[heading] ?? [heading.toLowerCase()]
  const lines = text.split('\n')
  for (const line of lines) {
    if (!/^\s*#{1,6}\s+/.test(line)) continue
    const normalized = line.replace(/^\s*#{1,6}\s+/, '').toLowerCase()
    if (aliases.some(alias => normalized.includes(alias))) return true
  }
  return false
}

function lastUserText(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = textOf(message.content).trim()
    if (text.length > 0) return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text
  }
  return undefined
}

function decisionLines(text: string): string[] {
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => /decision|decided|constraint|決定|制約/i.test(line) && line.length < 300)
    .slice(0, 8)
}

function bulletList(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.map(item => `- \`${item}\``).join('\n')
}

/**
 * Guarantee the required sections and deterministic facts in a summary.
 * Existing sections are never rewritten; missing ones are appended.
 * @param summary - model-produced summary blocks.
 * @param messages - the summarized conversation region.
 * @param options - structured-compaction options.
 * @returns summary blocks with retained facts and required sections.
 */
export function enrichSummary(
  summary: readonly ContentBlock[],
  messages: readonly Message[],
  options: StructuredCompactionConfig,
): ContentBlock[] {
  const text = textOf(summary)
  const files = options.retainFiles ? collectFilePaths(messages, options.maxRetainedFiles) : []
  const commands = options.retainCommands ? collectCommands(messages, options.maxRetainedCommands) : []
  const sections: string[] = []

  for (const heading of options.requiredHeadings) {
    if (hasHeading(text, heading)) continue
    let body: string
    switch (heading) {
      case 'Primary Request and Intent':
        body = lastUserText(messages) ?? 'Preserve the original request from the retained conversation.'
        break
      case 'Decisions and Constraints':
        body = decisionLines(text).join('\n') || 'No explicit decision list was emitted; preserve the constraints above.'
        break
      case 'Files and Code':
        body = bulletList(files, 'No file paths were observed in the summarized region.')
        break
      case 'Verification':
        body = bulletList(commands, 'No verification command was observed; verification state is unrecorded.')
        break
      case 'Open Issues':
        body = 'Not recorded by the summarizer; inspect the latest tool result and the pending tasks above.'
        break
      case 'Next Step':
        body = 'Not recorded by the summarizer; derive the next action from the open issues and the latest result.'
        break
      default:
        body = 'Not recorded by the summarizer.'
        break
    }
    sections.push(`## ${heading}\n${body}`)
  }

  const retained: string[] = []
  if (files.length > 0) {
    const missing = files.filter(file => !text.includes(file))
    if (missing.length > 0) retained.push(`Files observed:\n${bulletList(missing, '')}`)
  }
  if (commands.length > 0) {
    const missing = commands.filter(command => !text.includes(command))
    if (missing.length > 0) retained.push(`Commands observed:\n${bulletList(missing, '')}`)
  }
  if (retained.length > 0) sections.push(`## Retained Facts\n${retained.join('\n\n')}`)

  if (sections.length === 0) return [...summary]
  return [...summary, { type: 'text', text: `\n\n${sections.join('\n\n')}` }]
}

/** Options passed to the base summarizer input. */
interface SummarizationInputLike {
  readonly tools?: readonly unknown[]
  readonly messages: readonly Message[]
}

/**
 * Compaction backend with a structured output contract and deterministic
 * retention of files and verification commands.
 */
export class StructuredCompactionEngine extends BasicCompactionEngine {
  static override inject = BasicCompactionEngine.inject
  static override Config = BasicCompactionEngine.Config

  /**
   * Summarize with the structured contract, then enrich the result.
   * @param input - replayed conversation prefix.
   * @param agent - agent owning the conversation.
   * @param signal - cancellation.
   * @returns the base summary result with an enriched summary.
   */
  protected override async summarize(
    input: SummarizationInputLike,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<any> {
    const options = this.ctx.get('contextLongevity')?.options.structuredCompaction ?? FALLBACK_OPTIONS
    const augmented: SummarizationInputLike = options.instruction
      ? {
        ...input,
        messages: [
          ...input.messages,
          createUserMessage({
            content: [{ type: 'text', text: DEFAULT_COMPACTION_INSTRUCTION }],
            source: {
              kind: 'context-longevity',
              form: 'notice',
              summary: 'Structured compaction output contract',
            },
          }),
        ],
      }
      : input
    const result = await super.summarize(augmented as never, agent, signal) as unknown as {
      summary: ContentBlock[]
    } & Record<string, unknown>
    return {
      ...result,
      summary: enrichSummary(result.summary, input.messages, options),
    }
  }
}

export type { BasicCompactionConfig }

/** Plugin name for the standalone compaction row. */
export const name = 'compaction-longevity'

/** Services required by the base engine. */
export const inject = BasicCompactionEngine.inject

/** Base compaction schema; the row accepts the same keys as `compaction-basic`. */
export const Config = BasicCompactionEngine.Config

/**
 * Mount the structured compaction backend as its own loader row.
 * @param ctx - plugin context.
 * @param config - base compaction configuration.
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context, config: BasicCompactionConfig): void {
  try {
    new StructuredCompactionEngine(ctx, config)
  } catch (error) {
    ctx.logger.error('context-longevity: structured compaction failed to mount')
    ctx.logger.error(error)
    throw error
  }
}
