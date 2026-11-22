/**
 * Per-agent deferred tool loading.
 *
 * A large tool registry is expensive to send on every request. This controller
 * keeps a small always-active core visible, hides the rest behind
 * `discover_tools` / `activate_tools`, and re-applies the restriction when the
 * registry changes. Activation lives in plugin state, so it survives
 * compaction and does not depend on message history.
 *
 * @module dsh-plugin-context-longevity/deferred
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DeferredToolsConfig } from './config.ts'

/** Names owned by this plugin; never deferred themselves. */
export const CONTROL_TOOLS = ['discover_tools', 'activate_tools'] as const

/** One discoverable tool summary. */
export interface DiscoveredTool {
  readonly name: string
  readonly description: string
  readonly active: boolean
}

/** Result of one discovery call. */
export interface DiscoveryResult {
  readonly tools: DiscoveredTool[]
  readonly total: number
  readonly activeCount: number
  readonly deferredCount: number
}

/** Result of one activation call. */
export interface ActivationResult {
  readonly activated: string[]
  readonly alreadyActive: string[]
  readonly unknown: string[]
  readonly overLimit: string[]
  readonly activeCount: number
}

interface DeferredState {
  readonly agent: Agent
  readonly all: Set<string>
  readonly active: Set<string>
  readonly always: Set<string>
  enabled: boolean
  restriction?: () => void
  lastAllow?: string | undefined
  section?: () => void
}

/**
 * Rank tools by a case-insensitive query over name and description.
 * @param definitions - candidate definitions.
 * @param query - optional free-text query.
 * @param limit - maximum results.
 * @param exclude - names never returned.
 * @returns matching definitions in relevance order.
 */
export function rankTools(
  definitions: readonly ToolDefinition[],
  query: string | undefined,
  limit: number,
  exclude: readonly string[] = CONTROL_TOOLS,
): ToolDefinition[] {
  const excluded = new Set(exclude)
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(term => term.length > 0)
  const scored: Array<{ definition: ToolDefinition; score: number }> = []
  for (const definition of definitions) {
    if (excluded.has(definition.name)) continue
    const name = definition.name.toLowerCase()
    const description = definition.description.toLowerCase()
    let score = 0
    if (terms.length === 0) {
      score = 1
    } else {
      for (const term of terms) {
        if (name === term) score += 100
        else if (name.startsWith(term)) score += 40
        else if (name.includes(term)) score += 20
        else if (description.includes(term)) score += 5
      }
      if (score === 0) continue
    }
    scored.push({ definition, score })
  }
  scored.sort((left, right) => right.score - left.score || left.definition.name.localeCompare(right.definition.name))
  return scored.slice(0, Math.max(0, limit)).map(entry => entry.definition)
}

/**
 * Compose the visible allow-list from the always-active core and explicit
 * activations, capped by the configured maximum.
 * @param all - every known tool name.
 * @param always - names that are always visible.
 * @param activated - names activated by the model.
 * @param maxActive - visible-tool cap.
 * @returns the allow-list.
 */
export function composeAllowList(
  all: ReadonlySet<string>,
  always: ReadonlySet<string>,
  activated: ReadonlySet<string>,
  maxActive: number,
): string[] {
  const names = new Set<string>()
  for (const name of always) if (all.has(name) && names.size < maxActive) names.add(name)
  for (const name of activated) if (all.has(name) && names.size < maxActive) names.add(name)
  return [...names].sort()
}

/** Controller owning one restriction per agent. */
export class DeferredToolController {
  private readonly states = new Map<string, DeferredState>()

  /**
   * @param ctx - plugin context with the tools service.
   * @param config - deferred-loading options.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: DeferredToolsConfig,
  ) {}

  /**
   * Attach to one newly created agent.
   * @param agent - live agent.
   */
  attach(agent: Agent): void {
    if (this.states.has(agent.session.id)) return
    const all = new Set(this.ctx.tools.definitions().map(definition => definition.name))
    const always = new Set<string>()
    for (const name of this.config.alwaysActive) if (all.has(name)) always.add(name)
    for (const name of CONTROL_TOOLS) if (all.has(name)) always.add(name)
    const state: DeferredState = {
      agent,
      all,
      active: new Set(),
      always,
      enabled: this.config.enabled && all.size > this.config.threshold,
    }
    for (const name of always) state.active.add(name)
    this.states.set(agent.session.id, state)

    if (this.config.prompt) {
      state.section = agent.ctx.systemPrompt.section({
        name: 'context-longevity:deferred-tools',
        order: 950,
        text: () => this.promptText(state),
      })
    }
    if (state.enabled) this.restrict(state)
  }

  /**
   * Release every restriction and prompt section this controller installed.
   * Called on plugin unload so a live agent does not keep a dead allow-list.
   */
  dispose(): void {
    for (const state of [...this.states.values()]) {
      state.restriction?.()
      state.section?.()
    }
    this.states.clear()
  }

  /**
   * Drop all state for a disposed agent.
   * @param agent - disposed agent.
   */
  detach(agent: Agent): void {
    const state = this.states.get(agent.session.id)
    if (state === undefined) return
    state.restriction?.()
    state.section?.()
    this.states.delete(agent.session.id)
  }

  /**
   * Search the full catalog for one agent.
   * @param agent - calling agent, when known.
   * @param query - optional free-text query.
   * @param limit - maximum results.
   * @returns discoverable tools and counts.
   */
  discover(agent: Agent | undefined, query: string | undefined, limit: number): DiscoveryResult {
    const state = agent === undefined ? undefined : this.states.get(agent.session.id)
    const definitions = state === undefined
      ? this.ctx.tools.definitions()
      : this.ctx.tools.definitions().filter(definition => state.all.has(definition.name))
    const effectiveLimit = Math.max(1, Math.min(this.config.discoverLimit, limit))
    const tools = rankTools(definitions, query, effectiveLimit).map((definition): DiscoveredTool => ({
      name: definition.name,
      description: definition.description,
      active: state?.active.has(definition.name) ?? true,
    }))
    const total = state?.all.size ?? definitions.length
    const activeCount = state?.active.size ?? definitions.length
    return { tools, total, activeCount, deferredCount: Math.max(0, total - activeCount) }
  }

  /**
   * Activate tools for one agent.
   * @param agent - calling agent.
   * @param names - requested tool names.
   * @returns the applied and rejected names.
   */
  activate(agent: Agent, names: readonly string[]): ActivationResult {
    const state = this.states.get(agent.session.id)
    if (state === undefined) {
      return { activated: [], alreadyActive: [], unknown: [...names], overLimit: [], activeCount: 0 }
    }
    const activated: string[] = []
    const alreadyActive: string[] = []
    const unknown: string[] = []
    const overLimit: string[] = []
    for (const name of new Set(names)) {
      if (!state.all.has(name)) {
        unknown.push(name)
        continue
      }
      if (state.active.has(name)) {
        alreadyActive.push(name)
        continue
      }
      if (state.active.size >= this.config.maxActive) {
        overLimit.push(name)
        continue
      }
      state.active.add(name)
      activated.push(name)
    }
    if (activated.length > 0 && state.enabled) this.restrict(state)
    return { activated, alreadyActive, unknown, overLimit, activeCount: state.active.size }
  }

  /**
   * Reconcile every attached agent after a registry change. Removed tools leave
   * the active set; newly registered tools stay deferred unless always-active.
   */
  reconcile(): void {
    const global = this.ctx.tools.definitions()
    for (const state of this.states.values()) {
      for (const definition of global) state.all.add(definition.name)
      for (const name of [...state.active]) if (!state.all.has(name)) state.active.delete(name)
      for (const name of state.always) if (state.all.has(name)) state.active.add(name)
      if (state.enabled) this.restrict(state)
    }
  }

  /**
   * Read the active names for one agent.
   * @param agent - agent identity.
   * @returns sorted active names.
   */
  activeTools(agent: Agent): readonly string[] {
    const state = this.states.get(agent.session.id)
    return state === undefined ? [] : [...state.active].sort()
  }

  private restrict(state: DeferredState): void {
    const allow = composeAllowList(state.all, state.always, state.active, this.config.maxActive)
    const key = allow.join('\u0000')
    if (key === state.lastAllow) return
    state.lastAllow = key
    state.restriction?.()
    state.restriction = state.agent.ctx.tools.restrict({ allow })
  }

  private promptText(state: DeferredState): string {
    if (!state.enabled) return ''
    const active = [...state.active].sort().join(', ')
    return [
      `This session keeps ${state.all.size} tools registered but loads only the ones needed to keep context small.`,
      `Currently visible: ${active}.`,
      'Call discover_tools with a short query to search the hidden catalog, then activate_tools with the exact names you need.',
      'Activated tools stay visible for the rest of the session, including after compaction.',
    ].join(' ')
  }
}
