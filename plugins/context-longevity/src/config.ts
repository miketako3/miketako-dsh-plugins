/**
 * Configuration for deferred tool loading, structured compaction, and cache
 * warming.
 *
 * @module dsh-plugin-context-longevity/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Deferred tool loading options. */
export interface DeferredToolsConfig {
  /** Enable per-agent tool restrictions when the registry is large enough. */
  enabled: boolean
  /** Register a restriction only when the visible tool count exceeds this value. */
  threshold: number
  /** Tools always visible regardless of activation. */
  alwaysActive: string[]
  /** Upper bound on visible tools after activation. */
  maxActive: number
  /** Maximum tools returned by one discovery call. */
  discoverLimit: number
  /** Include a system-prompt section describing deferred loading. */
  prompt: boolean
}

/** Structured compaction options applied by the compaction service row. */
export interface StructuredCompactionConfig {
  /** Insert an explicit output contract into each summarization call. */
  instruction: boolean
  /** Canonical headings the retained summary must contain. */
  requiredHeadings: string[]
  /** Deterministically retain file paths observed in the summarized region. */
  retainFiles: boolean
  /** Deterministically retain shell commands observed in the region. */
  retainCommands: boolean
  /** Maximum file paths appended to a summary. */
  maxRetainedFiles: number
  /** Maximum commands appended to a summary. */
  maxRetainedCommands: number
}

/** Cache warming options. */
export interface CacheWarmingConfig {
  /** Enable cache warming during long tool calls. */
  enabled: boolean
  /** Tool runtime before the first warm request. */
  delayMs: number
  /** Delay between warm requests while the tool is still running. */
  intervalMs: number
  /** Maximum warm requests per tool call. */
  maxWarmingsPerTurn: number
  /** Skip warming when the derived history exceeds this many messages. */
  maxMessages: number
  /** Output cap for a warm request; one token is enough to refresh a prefix. */
  maxTokens: number
}

/** Complete plugin configuration. */
export interface Config {
  /** Deferred tool loading. */
  deferredTools: DeferredToolsConfig
  /** Structured compaction contract. */
  structuredCompaction: StructuredCompactionConfig
  /** Cache warming. */
  cacheWarming: CacheWarmingConfig
}

/** Default output contract for the structured summarizer. */
export const DEFAULT_COMPACTION_INSTRUCTION = [
  'Produce the compaction summary with exactly these level-2 Markdown sections, in this order:',
  '## Primary Request and Intent',
  '## Decisions and Constraints',
  '## Files and Code',
  '## Verification',
  '## Open Issues',
  '## Next Step',
  'Keep exact file paths, commands, error strings, identifiers, and unresolved questions.',
  'Do not invent verification that did not happen; write "none recorded" when it is unknown.',
  'The summary replaces earlier context, so the Next Step must be executable without guessing.',
].join('\n')

const stringList = Schema.array(Schema.string())

/** Runtime configuration schema. */
export const Config: Schema<Config> = Schema.object({
  deferredTools: Schema.object({
    enabled: Schema.boolean().default(true),
    threshold: Schema.number().step(1).min(0).default(20),
    alwaysActive: stringList.default([
      'read',
      'write',
      'edit',
      'bash',
      'glob',
      'grep',
      'todo_write',
      'present',
      'job_list',
      'job_output',
      'job_kill',
      'discover_tools',
      'activate_tools',
    ]),
    maxActive: Schema.number().step(1).min(1).default(28),
    discoverLimit: Schema.number().step(1).min(1).default(25),
    prompt: Schema.boolean().default(true),
  }),
  structuredCompaction: Schema.object({
    instruction: Schema.boolean().default(true),
    requiredHeadings: stringList.default([
      'Primary Request and Intent',
      'Decisions and Constraints',
      'Files and Code',
      'Verification',
      'Open Issues',
      'Next Step',
    ]),
    retainFiles: Schema.boolean().default(true),
    retainCommands: Schema.boolean().default(true),
    maxRetainedFiles: Schema.number().step(1).min(0).default(40),
    maxRetainedCommands: Schema.number().step(1).min(0).default(10),
  }),
  cacheWarming: Schema.object({
    enabled: Schema.boolean().default(false),
    delayMs: Schema.number().step(1).min(0).default(2_000),
    intervalMs: Schema.number().step(1).min(100).default(60_000),
    maxWarmingsPerTurn: Schema.number().step(1).min(0).default(3),
    maxMessages: Schema.number().step(1).min(1).default(400),
    maxTokens: Schema.number().step(1).min(1).default(1),
  }),
})
