/**
 * Configuration for the Antigravity ACP integration plugin.
 *
 * @module dsh-plugin-antigravity-acp/config
 */

import z from '@deepseek-ai/schemastery'

/** Permission policy forwarded to the official ACP provider. */
export type PermissionPolicy = 'allow' | 'reject'

/** Resolved plugin configuration. */
export interface Config {
  /** `ctx.subagents` provider name registered by the ACP backend. */
  providerName: string
  /** Model-facing tool name for the mounted `dsh-tool-subagent` instance. */
  toolName: string
  /** Executable that starts the ACP server. Prefer the absolute path from `which agy`. */
  command: string
  /** Arguments passed after `command`. */
  args: string[]
  /** Auto-answer ACP permission requests: reject every prompt, or allow the first allow option. */
  permission: PermissionPolicy
  /** Explicit child environment layered over the credential-scrubbed parent environment. */
  env: Record<string, string>
  /** Backend package to import dynamically. */
  backendModule: string
  /** Tool package to import dynamically. */
  toolModule: string
  /** Mount the backend and tool when the optional packages are installed. */
  autoConfigure: boolean
  /** Embedded skill name. */
  skillName: string
  /** Embedded skill routing description. */
  skillDescription: string
  /** EOF-driven quiesce grace forwarded to the ACP backend. */
  disposeEofGraceMs: number
  /** Failure-observation and SIGTERM-to-SIGKILL grace forwarded to the ACP backend. */
  disposeGraceMs: number
}

/** Validated configuration with every default materialized. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('antigravity'),
  toolName: z.string().default('subagent_antigravity'),
  command: z.string().default('agy'),
  args: z.array(z.string()).default(['acp', '--sandbox', '--disable-telemetry']),
  permission: z.union(['allow', 'reject'] as const).default('reject'),
  env: z.dict(z.string()).default({}),
  backendModule: z.string().default('@deepseek-ai/dsh-subagent-acp'),
  toolModule: z.string().default('@deepseek-ai/dsh-tool-subagent'),
  autoConfigure: z.boolean().default(true),
  skillName: z.string().default('antigravity-acp'),
  skillDescription: z.string().default(
    'Delegate a self-contained task to Google Antigravity CLI (`agy acp`) as an isolated DSH subagent; '
    + 'covers DSH ACP config, auth, permissions, prompts, and debugging.',
  ),
  disposeEofGraceMs: z.number().default(6_000),
  disposeGraceMs: z.number().default(3_000),
})
