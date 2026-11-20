/**
 * The `llm`-service adapter: a duck-typed LLM adapter that exposes the
 * FreeClaudeCode routing modes and delegates every turn to the runner.
 *
 * The adapter deliberately imports nothing from `@deepseek-ai/*`. The service
 * validates a registration through `providerInfo`, `providerRetryPolicy`, and
 * the adapter methods below, so a plain object satisfies the contract and the
 * bundle stays loadable without resolving a harness package.
 *
 * @module dsh-freeclaudecode-auto/adapter
 */

import { profileLabel } from './config.js'

/** Model id of the Best Coding profile. */
export const BEST_ID = 'best'

/** Model id of the Fast / Subagent profile. */
export const FAST_ID = 'fast'

/**
 * A retry policy that disables harness-level retries.
 *
 * Failover happens inside the adapter, so a harness retry would replay a whole
 * turn against a model the router already retired and could duplicate work.
 * @returns {object} a normal policy with no retries.
 */
export function noHarnessRetryPolicy() {
  return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }
}

/**
 * Build the adapter registered for this provider route.
 *
 * @param {object} parts - adapter dependencies.
 * @param {object} parts.config - resolved plugin config.
 * @param {import('./pool.js').CandidatePool} parts.pool - the candidate pool.
 * @param {{stream: (options: object) => AsyncGenerator<object>}} parts.runner - the turn runner.
 * @param {object} parts.status - status registry.
 * @param {object} parts.fcc - the fcc bridge.
 * @param {string} parts.version - plugin version.
 * @returns {object} the duck-typed adapter.
 */
export function createAdapter({ config, pool, runner, status, fcc, version }) {
  /** @type {Map<string, object>} */
  const profileModels = new Map()

  /** Rebuild the advertised profile models from the live config. */
  function profiles() {
    return [
      {
        id: config.autoModelId,
        name: config.autoModelName,
        description: 'Zero-drop router: the best available free model answers, and another model takes over if it fails, stalls, or is cut off mid-stream.',
        badge: { text: 'zero-drop', tone: 'success' },
      },
      {
        id: BEST_ID,
        name: config.bestModelName,
        description: 'Prefers coding and reasoning models with verified tool calling, then falls back across the pool.',
        badge: { text: 'coding', tone: 'info' },
      },
      {
        id: FAST_ID,
        name: config.fastModelName,
        description: 'Prefers low-latency models, for subagents and short turns, then falls back across the pool.',
        badge: { text: 'fast', tone: 'neutral' },
      },
    ]
  }

  /**
   * Resolve the display name for one selected model id.
   * @param {string} modelId - selected catalog id.
   * @returns {string} the label.
   */
  function labelFor(modelId) {
    const profile = profiles().find(entry => entry.id === modelId)
    if (profile !== undefined) return profile.name
    return pool.byCatalogId(modelId)?.label ?? modelId
  }

  const adapter = {
    /**
     * @param {string} provider - the route this adapter owns.
     * @returns {{id: string, name: string}} provider metadata.
     */
    providerInfo(provider) {
      return { id: provider, name: config.providerName }
    },

    /** @returns {object} the harness retry policy for this route. */
    providerRetryPolicy() {
      return noHarnessRetryPolicy()
    },

    /**
     * Preserve normalized image dimensions; the route is text-only and the
     * runtime substitutes placeholders before dispatch.
     * @param {string} _provider - route.
     * @param {string} _model - model id.
     * @param {{width: number, height: number, bytes: number}} image - normalized image.
     * @returns {{width: number, height: number, maxBytes: number}} the request projection.
     */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    /**
     * Declare no provider-side image pricing.
     *
     * The runtime calls this on every registered adapter while measuring a
     * context (including the compaction that precedes a model switch), so an
     * adapter without the method would crash that measurement. A text-only
     * route prices images through the caller's neutral estimate.
     * @param {string} _provider - route.
     * @param {string} _model - model id.
     * @returns {undefined} no route-owned pricing.
     */
    imageRequestPricing(_provider, _model) {
      return undefined
    },

    /**
     * Advertise the routing modes plus every discovered model.
     * @param {string} provider - the route.
     * @returns {Promise<object[]>} the selector catalog.
     */
    async listModels(provider) {
      const models = profiles().map(profile => ({
        provider,
        id: profile.id,
        name: profile.name,
        description: profile.description,
        inputModalities: ['text'],
        badge: profile.badge,
      }))
      for (const candidate of pool.list()) {
        models.push({
          provider,
          id: candidate.catalogId,
          name: candidate.label,
          description: `${candidate.source === 'fcc' ? 'Free Claude Code' : 'direct'} · ${candidate.tier}${candidate.tools ? ' · tools' : ''}`,
          inputModalities: ['text'],
          badge: {
            text: candidate.source === 'fcc' ? 'fcc' : candidate.provider,
            tone: candidate.tier === 'coding' ? 'info' : 'neutral',
          },
        })
      }
      return models
    },

    /**
     * Describe one exact model route.
     * @param {string} provider - the route.
     * @param {string} modelId - selected catalog id.
     * @returns {Promise<object>} resolved metadata.
     */
    async resolveModel(provider, modelId) {
      const profile = profiles().find(entry => entry.id === modelId)
      if (profile !== undefined) {
        profileModels.set(modelId, profile)
        return {
          provider,
          id: modelId,
          name: profile.name,
          description: profile.description,
          context: { contextWindow: config.autoContextWindow },
          defaultMaxTokens: config.autoMaxTokens,
          inputModalities: ['text'],
        }
      }
      const candidate = pool.byCatalogId(modelId)
      if (candidate === undefined) {
        return {
          provider,
          id: modelId,
          name: labelFor(modelId),
          context: { contextWindow: 32768 },
          defaultMaxTokens: 8192,
          inputModalities: ['text'],
        }
      }
      return {
        provider,
        id: modelId,
        name: candidate.label,
        description: `${candidate.source === 'fcc' ? 'Free Claude Code' : 'direct'} · ${candidate.tier}`,
        context: { contextWindow: candidate.contextWindow },
        defaultMaxTokens: candidate.maxTokens,
        inputModalities: ['text'],
      }
    },

    /**
     * Bind resolution and dispatch to one adapter generation.
     * @param {string} provider - the route.
     * @param {string} modelId - selected catalog id.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<{model: object, stream: (options: object) => AsyncGenerator<object>}>} the prepared call.
     */
    async prepareCall(provider, modelId, signal) {
      const model = await adapter.resolveModel(provider, modelId, signal)
      return { model, stream: options => adapter.stream(options) }
    },

    /**
     * Stream one model call through the failover runner.
     * @param {object} options - harness generate options.
     * @returns {AsyncGenerator<object>} harness chunks.
     */
    stream(options) {
      return runner.stream(options)
    },

    /**
     * Freeze the routing and observability state.
     * @returns {object} a detached snapshot.
     */
    status() {
      return status.snapshot({ pool, fcc: fcc.snapshot(), config, version })
    },
  }

  return adapter
}

export { profileLabel }
