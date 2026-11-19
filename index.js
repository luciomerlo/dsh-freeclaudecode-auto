/**
 * Free Claude Code provider for DeepSeek Harness.
 *
 * The bundle registers one `llm` provider route whose catalog contains the
 * `Auto (FreeClaudeCode)` zero-drop router, two capability profiles, and every
 * free model discovered from the fcc proxy or from the provider keys fcc
 * stores. The adapter delegates each turn to {@link createRunner}, which owns
 * the failover pipeline described in README.md.
 *
 * @module dsh-freeclaudecode-auto
 */

import { readFileSync } from 'node:fs'

import { resolveConfig } from './src/config.js'
import { FccBridge } from './src/fcc.js'
import { CandidatePool } from './src/pool.js'
import { buildDirectCandidates, mergeCatalog } from './src/providers.js'
import { createRunner } from './src/runner.js'
import { createAdapter } from './src/adapter.js'
import { StatusRegistry } from './src/status.js'

/** Plugin version, read from the package manifest so the two cannot drift. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

/** Relative interval at which the free catalog is re-evaluated. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

/** HTTP path the composer badge reads. */
export const STATUS_ROUTE = '/plugin/freeclaudecode/status'

/** Loader row name for this plugin. */
export const name = 'freeclaudecode-auto'

/** The plugin needs the LLM service; tools and the web server are optional. */
export const inject = ['llm']

/**
 * Mount the provider.
 *
 * @param {any} ctx - the plugin context.
 * @param {Record<string, unknown>} [input] - the loader row config.
 * @returns {void}
 */
export function apply(ctx, input) {
  const config = resolveConfig(input)
  const logger = {
    info: (...args) => ctx.logger?.info?.(...args),
    warn: (...args) => ctx.logger?.warn?.(...args),
    debug: (...args) => ctx.logger?.debug?.(...args),
  }

  const status = new StatusRegistry()
  const pool = new CandidatePool({ config, logger })
  const fcc = new FccBridge({ config, logger })

  const lifetime = new AbortController()
  /** @type {Promise<object[]> | null} */
  let refreshing = null

  /**
   * Rebuild the catalog from fcc and the direct providers.
   *
   * A concurrent caller joins the in-flight refresh instead of starting a
   * second one, so a burst of failovers cannot multiply provider requests.
   * @param {'startup' | 'interval' | 'failover' | 'manual'} reason - why the refresh runs.
   * @returns {Promise<object[]>} the merged catalog.
   */
  function refreshCatalog(reason) {
    if (refreshing !== null) return refreshing
    refreshing = (async () => {
      try {
        const fccResult = await fcc.discover(lifetime.signal)
        const env = { ...process.env, ...fcc.env }
        const direct = await buildDirectCandidates({
          config,
          env,
          fetchImpl: globalThis.fetch,
          signal: lifetime.signal,
        })
        const merged = mergeCatalog(fccResult.candidates, direct, config)
        pool.replace(merged)
        try {
          ctx.emit?.('llm/models-updated', config.providerId)
        } catch {
          // The event is advisory; a listener failure must not break routing.
        }
        if (reason === 'startup') {
          logger.info(
            `freeclaudecode: ${String(merged.length)} free models ready `
            + `(${String(fccResult.candidates.length)} via fcc, ${String(direct.length)} direct); `
            + `fcc ${fccResult.available ? 'up' : 'down'}`,
          )
        }
        if (!fccResult.available && direct.length === 0) {
          logger.warn(
            'freeclaudecode: no free model is reachable. Start Free Claude Code, or add a provider key '
            + 'to ~/.fcc/.env. Auto (FreeClaudeCode) reports NO_MODEL_AVAILABLE until then.',
          )
        }
        return merged
      } catch (error) {
        logger.warn('freeclaudecode: catalog refresh failed', error)
        return []
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  const runner = createRunner({
    config,
    pool,
    logger,
    status,
    onFailover: () => {
      if (config.refreshCatalogOnFailover) void refreshCatalog('failover')
    },
  })
  const adapter = createAdapter({ config, pool, runner, status, fcc, version: VERSION })

  // Provider registration is owned by one effect so unloading the plugin (or
  // its bundle) removes the route and every model it advertised.
  ctx.effect(() => {
    const dispose = ctx.llm.registerAdapter([config.providerId], adapter)
    if (typeof dispose !== 'function') {
      throw new Error('freeclaudecode: the llm service refused the adapter registration')
    }
    logger.info(`freeclaudecode: provider "${config.providerId}" registered`)
    return () => dispose()
  }, 'freeclaudecode: provider registration')

  // Startup discovery plus a slow re-evaluation. fcc may start after the
  // harness, and free catalogs change; neither restarts the plugin.
  ctx.effect(() => {
    void refreshCatalog('startup')
    const timer = setInterval(() => { void refreshCatalog('interval') }, REFRESH_INTERVAL_MS)
    timer.unref?.()
    return () => {
      lifetime.abort()
      clearInterval(timer)
    }
  }, 'freeclaudecode: catalog lifecycle')

  // The status tool lets the model explain routing health to the user.
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (tools !== undefined && typeof tools.register === 'function') {
    ctx.effect(() => {
      const definition = {
        name: 'freeclaudecode_status',
        description: 'Report FreeClaudeCode routing health for this profile: the fcc proxy state, each free model\'s circuit-breaker state, and recent failovers. Read-only.',
        parameters: {
          type: 'object',
          properties: {
            includeCandidates: { type: 'boolean', description: 'Include every catalog candidate, not only the summary counts.' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
          const snapshot = adapter.status()
          if (args?.includeCandidates !== true) {
            return JSON.stringify({ ...snapshot, pool: { ...snapshot.pool, candidates: undefined } }, null, 2)
          }
          return JSON.stringify(snapshot, null, 2)
        },
      }
      try {
        return tools.register(definition)
      } catch (error) {
        logger.warn('freeclaudecode: the status tool could not be registered', error)
        return () => {}
      }
    }, 'freeclaudecode: status tool')
  }

  // The composer badge polls this route; it carries no credentials and the
  // same data the status tool returns.
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (config.statusRoute && webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: STATUS_ROUTE,
          resource: async () => {
            const snapshot = adapter.status()
            const body = {
              ...snapshot,
              pool: { ...snapshot.pool, candidates: undefined },
            }
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              },
            })
          },
        })
      } catch (error) {
        logger.warn('freeclaudecode: the status route could not be registered', error)
        return () => {}
      }
    }, 'freeclaudecode: status route')
  }

  // Expose nothing else: the adapter, pool, and status registry stay owned by
  // this closure, so unloading the plugin cannot leave a dangling reference.
}

export { VERSION }
