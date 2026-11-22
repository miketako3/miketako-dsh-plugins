/**
 * Shared host service for the context-longevity plugin.
 *
 * The deferred-tool row and the compaction row are separate loader rows so a
 * user may install either independently. This service is the bridge: the
 * compaction backend reads the structured-compaction contract from it.
 *
 * @module dsh-plugin-context-longevity/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { StructuredCompactionConfig } from './config.ts'

/** Immutable options published to the compaction row. */
export interface ContextLongevityOptions {
  readonly structuredCompaction: StructuredCompactionConfig
}

/** Host service exposed as `ctx.contextLongevity`. */
export class ContextLongevityService extends Service {
  readonly options: ContextLongevityOptions

  /**
   * @param ctx - owning plugin context.
   * @param options - resolved structured-compaction options.
   */
  constructor(ctx: Context, options: ContextLongevityOptions) {
    super(ctx, 'contextLongevity')
    this.options = options
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Structured-compaction contract shared with the compaction row. */
    contextLongevity: ContextLongevityService
  }
}
