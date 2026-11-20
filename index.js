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
import { homedir } from 'node:os'
import { join } from 'node:path'

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

// 1.0.2 adds the Settings connection page; the constant above keeps the
// catalog refresh cheap while the page can force one on demand.

/** HTTP path the composer badge reads. */
export const STATUS_ROUTE = '/plugin/freeclaudecode/status'

/** HTTP path the Settings section reads and writes. */
export const SETTINGS_ROUTE = '/plugin/freeclaudecode/settings'

/** Request header a same-origin page sets; a cross-origin form cannot. */
const REQUEST_HEADER = 'x-dsh-plugin-request'

/** Marker value for {@link REQUEST_HEADER}. */
const REQUEST_MARKER = 'freeclaudecode'

/** Error carrying the HTTP status an action should answer with. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

/** Answer one request with JSON. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Read a small JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw httpError(413, 'Request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'Request body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'Request body must be a JSON object')
  }
  return value
}

/** Whether a request came from the plugin's own same-origin page. */
function isPluginRequest(req) {
  return req.headers?.[REQUEST_HEADER] === REQUEST_MARKER
}

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

  // The Settings section persists through the config editor, which owns the
  // profile patch. It is optional: a host without it still routes models, and
  // the page reports that saving is unavailable instead of pretending.
  const entry = ctx.fiber?.entry
  const configEditor = ctx.get?.('configEditor')
  const canSave = entry !== undefined && configEditor !== undefined

  /** The public status, without local filesystem paths. */
  function publicStatus() {
    const snapshot = adapter.status()
    return {
      ...snapshot,
      fcc: {
        ...snapshot.fcc,
        directory: undefined,
        binary: undefined,
      },
      pool: {
        ...snapshot.pool,
        candidates: undefined,
      },
    }
  }

  /** What the Settings section reads. */
  function settingsPayload() {
    return {
      plugin: 'dsh-freeclaudecode-auto',
      version: VERSION,
      config: {
        providerId: config.providerId,
        providerName: config.providerName,
        fcc: {
          enabled: config.fcc.enabled,
          baseUrl: config.fcc.baseUrl,
          directory: config.fcc.directory,
          autoStart: config.fcc.autoStart,
        },
      },
      capabilities: {
        canSave,
        reason: canSave ? null : 'The profile configuration editor is not mounted in this host.',
      },
      status: publicStatus(),
    }
  }

  /** Validate the connection fields the page submits. */
  function validatedSettings(body) {
    const rawUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/u, '') : ''
    if (rawUrl !== '' && !/^https?:\/\/[^\s]+$/u.test(rawUrl)) {
      throw httpError(400, 'The proxy URL must start with http:// or https://')
    }
    let directory = typeof body.directory === 'string' ? body.directory.trim() : ''
    if (directory.startsWith('~')) {
      directory = join(homedir(), directory.replace(/^~[\\/]?/u, ''))
    }
    if (directory !== '' && !/^(?:[A-Za-z]:[\\/]|\/)/u.test(directory)) {
      throw httpError(400, 'The configuration directory must be an absolute path')
    }
    return {
      enabled: body.enabled !== false,
      baseUrl: rawUrl,
      directory,
      autoStart: body.autoStart !== false,
    }
  }

  /**
   * Persist the connection fields into the plugin's own profile row and let
   * the config editor restart exactly this plugin.
   */
  async function saveSettings(body) {
    if (!canSave) throw httpError(409, 'Saving is unavailable: the profile configuration editor is not mounted in this host.')
    const next = validatedSettings(body)
    await configEditor.edit(entry, (current) => {
      const fccCurrent = current.fcc !== null && typeof current.fcc === 'object' ? current.fcc : {}
      return {
        ...current,
        fcc: {
          ...fccCurrent,
          enabled: next.enabled,
          baseUrl: next.baseUrl,
          directory: next.directory,
          autoStart: next.autoStart,
        },
      }
    })
  }

  /** Answer one Settings-section request. */
  async function handleSettings(req, res) {
    if (!isPluginRequest(req)) {
      sendJson(res, 403, { error: 'Forbidden' })
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, settingsPayload())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, error.status ?? 400, { error: error.message })
      return
    }

    const action = typeof body.action === 'string' ? body.action : 'status'
    try {
      if (action === 'save') {
        await saveSettings(body)
        sendJson(res, 200, { ok: true, saved: true, restarting: true, message: 'Saved. The plugin restarts to apply the connection.' })
        return
      }
      if (action === 'test') {
        if (!config.fcc.enabled) {
          sendJson(res, 200, { ok: false, message: 'Free Claude Code integration is disabled in this profile.' })
          return
        }
        await fcc.readEnv()
        const probe = await fcc.probe()
        sendJson(res, 200, {
          ok: probe.available,
          message: probe.available
            ? `Connected: ${String(probe.models.length)} models advertised by the fcc proxy.`
            : probe.error,
          status: publicStatus(),
        })
        return
      }
      if (action === 'refresh') {
        const models = await refreshCatalog('manual')
        sendJson(res, 200, { ok: true, message: `${String(models.length)} models loaded.`, status: publicStatus() })
        return
      }
      if (action === 'start') {
        const result = await fcc.ensureRunning(lifetime.signal)
        await refreshCatalog('manual')
        sendJson(res, 200, {
          ok: result.started || result.reason === 'already running',
          message: result.started ? 'fcc-server started in the background.' : result.reason,
          status: publicStatus(),
        })
        return
      }
      if (action === 'status') {
        sendJson(res, 200, { ok: true, status: publicStatus() })
        return
      }
      sendJson(res, 400, { error: `Unknown action "${action}"` })
    } catch (error) {
      sendJson(res, error.status ?? 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

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
            return new Response(JSON.stringify(publicStatus()), {
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

  // The Settings section reads and writes the connection through this route;
  // the header requirement keeps a cross-origin form from changing it.
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => {
      try {
        return webServer.register({
          kind: 'exact',
          path: SETTINGS_ROUTE,
          handler: handleSettings,
        })
      } catch (error) {
        logger.warn('freeclaudecode: the settings route could not be registered', error)
        return () => {}
      }
    }, 'freeclaudecode: settings route')
  }

  // Expose nothing else: the adapter, pool, and status registry stay owned by
  // this closure, so unloading the plugin cannot leave a dangling reference.
}

export { VERSION }
