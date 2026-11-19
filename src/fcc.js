/**
 * Free Claude Code (fcc) discovery: its configuration, its catalog, and its
 * local proxy process.
 *
 * The plugin treats fcc as the preferred backend and never edits the user's
 * environment. It reads `~/.fcc/.env`, probes the local proxy, and — only when
 * a `fcc-server` executable is actually installed — starts that daemon in the
 * background with its own copy of the environment.
 *
 * @module dsh-freeclaudecode-auto/fcc
 */

import { access, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { delimiter, join } from 'node:path'

import { sleep, trimSlash } from './util.js'

/** Provider ids fcc uses as model-slug prefixes. */
const FCC_SLUG = /^[a-z0-9_]+\/[^/\s]+(?:\/.*)?$/u

/**
 * Parse a dotenv document without pulling in a dependency.
 * @param {string} text - dotenv contents.
 * @returns {Record<string, string>} the parsed bindings.
 */
export function parseEnvText(text) {
  const values = {}
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/u, '')
    }
    values[match[1]] = value.replace(/\\n/gu, '\n')
  }
  return values
}

/**
 * Normalize an fcc model listing into plain records.
 * @param {unknown} payload - a `/v1/models` payload.
 * @returns {Array<{id: string, name?: string, contextWindow?: number, maxTokens?: number, tools?: boolean}>} the models.
 */
export function normalizeFccModels(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.models) ? payload.models
        : []
  const seen = new Set()
  const models = []
  for (const entry of source) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' && entry.id !== ''
      ? entry.id
      : typeof entry.model === 'string' && entry.model !== '' ? entry.model : ''
    if (id === '' || seen.has(id) || !FCC_SLUG.test(id)) continue
    seen.add(id)
    const contextWindow = Number(entry.context_window ?? entry.context_length ?? entry.contextWindow ?? entry.max_input_tokens)
    const maxTokens = Number(entry.max_tokens ?? entry.max_output_tokens ?? entry.maxTokens)
    const tools = entry.supports_tools ?? entry.tools ?? entry.capabilities?.tools
    models.push({
      id,
      ...typeof entry.display_name === 'string' && entry.display_name !== '' ? { name: entry.display_name } : {},
      ...Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.round(contextWindow) } : {},
      ...Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.round(maxTokens) } : {},
      ...typeof tools === 'boolean' ? { tools } : {},
    })
  }
  return models
}

/**
 * Candidate catalog ids fcc's own environment names directly.
 * @param {Record<string, string>} env - fcc environment.
 * @returns {string[]} ordered model slugs, most preferred first.
 */
export function configuredFccModels(env) {
  const slugs = []
  for (const key of ['MODEL_FABLE', 'MODEL_OPUS', 'MODEL_SONNET', 'MODEL_HAIKU', 'MODEL']) {
    const value = env[key]
    if (typeof value === 'string' && FCC_SLUG.test(value.trim())) slugs.push(value.trim())
  }
  const fallbacks = env.MODEL_FALLBACKS
  if (typeof fallbacks === 'string' && fallbacks.trim() !== '') {
    for (const entry of fallbacks.split(',')) {
      const candidate = entry.trim().split(':')[0].trim()
      if (FCC_SLUG.test(candidate)) slugs.push(candidate)
    }
  }
  return [...new Set(slugs)]
}

/**
 * Locate an fcc server executable on this machine.
 * @param {string} configured - an explicit path from the plugin config, or ''.
 * @returns {Promise<{command: string, args: string[], found: boolean}>} the launch command.
 */
export async function findFccServer(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return { command: configured.trim(), args: [], found: true }
  }
  const names = platform() === 'win32'
    ? ['fcc-server.exe', 'fcc-server.cmd', 'fcc-server.bat']
    : ['fcc-server']
  const directories = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.fcc', 'bin'),
    join(homedir(), '.cargo', 'bin'),
    ...(process.env.LOCALAPPDATA === undefined ? [] : [join(process.env.LOCALAPPDATA, 'Programs', 'free-claude-code')]),
  ].filter(directory => directory !== '')

  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      try {
        await access(candidate, platform() === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
        return { command: candidate, args: [], found: true }
      } catch {
        // Keep looking.
      }
    }
  }
  return { command: '', args: [], found: false }
}

/**
 * The fcc bridge: configuration, reachability, and the background daemon.
 */
export class FccBridge {
  /** @type {object} */
  #config
  /** @type {object} */
  #logger
  /** @type {Record<string, string>} */
  #env = {}
  /** @type {{available: boolean, error: string, checkedAt: number, models: object[], binary: string, startedByPlugin: boolean}} */
  #state = { available: false, error: 'not probed yet', checkedAt: 0, models: [], binary: '', startedByPlugin: false }

  /**
   * @param {object} options - bridge dependencies.
   * @param {object} options.config - resolved plugin config.
   * @param {{info: Function, warn: Function, debug: Function}} options.logger - diagnostics sink.
   */
  constructor({ config, logger }) {
    this.#config = config
    this.#logger = logger
  }

  /** @returns {string} the local proxy root URL. */
  get baseUrl() {
    return trimSlash(this.#config.fcc.baseUrl)
  }

  /** @returns {string} the directory that holds fcc's configuration. */
  get directory() {
    return this.#config.fcc.directory
  }

  /** @returns {Record<string, string>} the environment fcc would read. */
  get env() {
    return this.#env
  }

  /** @returns {string} the proxy token, when fcc has authentication enabled. */
  get token() {
    return (this.#env.ANTHROPIC_AUTH_TOKEN ?? '').trim()
  }

  /**
   * Read fcc's `.env`, so provider keys stored by fcc are reused without
   * copying them into another file.
   * @returns {Promise<Record<string, string>>} the parsed environment.
   */
  async readEnv() {
    const explicit = this.#config.fcc.envFile
    const path = explicit !== '' ? explicit : join(this.directory, '.env')
    try {
      this.#env = { ...parseEnvText(await readFile(path, 'utf8')), ...this.#env }
    } catch {
      this.#env = { ...this.#env }
    }
    return this.#env
  }

  /**
   * Probe the local proxy for its catalog.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{available: boolean, models: object[], error: string}>} probe result.
   */
  async probe(signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#config.fcc.probeTimeoutMs)
    const headers = { accept: 'application/json' }
    if (this.token !== '') headers['x-api-key'] = this.token
    try {
      const response = await fetch(`${this.baseUrl}/v1/models?view=messages`, {
        headers,
        signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
      })
      if (!response.ok) {
        return { available: false, models: [], error: `HTTP ${String(response.status)} from the fcc proxy` }
      }
      const payload = await response.json()
      const models = normalizeFccModels(payload)
      this.#state = {
        ...this.#state,
        available: true,
        error: '',
        checkedAt: Date.now(),
        models,
      }
      return { available: true, models, error: '' }
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'the fcc proxy did not answer in time'
        : `the fcc proxy is unreachable (${error instanceof Error ? error.message : String(error)})`
      this.#state = { ...this.#state, available: false, error: message, checkedAt: Date.now(), models: [] }
      return { available: false, models: [], error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Start the fcc daemon when it is installed but not running.
   *
   * Only a `fcc-server` executable is started: this plugin never launches an
   * agent CLI that would take over the terminal.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{started: boolean, reason: string}>} the outcome.
   */
  async ensureRunning(signal) {
    if (!this.#config.fcc.enabled) return { started: false, reason: 'fcc integration is disabled' }
    const current = await this.probe(signal)
    if (current.available) return { started: false, reason: 'already running' }

    if (!this.#config.fcc.autoStart) return { started: false, reason: 'auto-start is disabled' }

    const located = await findFccServer(this.#config.fcc.binary)
    this.#state.binary = located.command
    if (!located.found) {
      return { started: false, reason: 'no fcc-server executable was found on PATH' }
    }

    try {
      const child = spawn(located.command, located.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env },
      })
      child.unref()
      this.#logger.info(`freeclaudecode: started fcc-server in the background (${located.command})`)
    } catch (error) {
      return { started: false, reason: `fcc-server could not start: ${error instanceof Error ? error.message : String(error)}` }
    }

    const deadline = Date.now() + this.#config.fcc.startupTimeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted === true) return { started: false, reason: 'cancelled while starting fcc-server' }
      await sleep(500, signal)
      const probe = await this.probe(signal)
      if (probe.available) {
        this.#state.startedByPlugin = true
        return { started: true, reason: 'fcc-server answered after being started' }
      }
    }
    return { started: false, reason: `fcc-server did not answer within ${String(this.#config.fcc.startupTimeoutMs)} ms` }
  }

  /**
   * Detect fcc and build its candidate records.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{candidates: object[], available: boolean, error: string}>} the fcc candidates.
   */
  async discover(signal) {
    await this.readEnv()
    if (!this.#config.fcc.enabled) return { candidates: [], available: false, error: 'fcc integration is disabled' }
    const started = await this.ensureRunning(signal)
    const probe = await this.probe(signal)
    if (!probe.available) {
      return { candidates: [], available: false, error: probe.error || started.reason }
    }

    const configured = configuredFccModels(this.#env)
    const models = [...probe.models]
    const seen = new Set(models.map(model => model.id))
    for (const slug of configured) {
      if (seen.has(slug)) continue
      seen.add(slug)
      models.push({ id: slug })
    }

    return {
      candidates: models.map(model => ({
        catalogId: `fcc:${model.id}`,
        key: `fcc:${model.id}`,
        source: 'fcc',
        provider: model.id.split('/')[0],
        upstreamModel: model.id,
        label: model.name ?? model.id,
        wire: 'anthropic',
        baseUrl: this.baseUrl,
        apiKey: this.token,
        tier: null,
        tools: model.tools !== false,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
      available: true,
      error: '',
    }
  }

  /**
   * Freeze the bridge state for the status surface.
   * @returns {object} a detached snapshot.
   */
  snapshot() {
    return {
      enabled: this.#config.fcc.enabled,
      available: this.#state.available,
      baseUrl: this.baseUrl,
      directory: this.directory,
      models: this.#state.models.length,
      error: this.#state.error,
      checkedAt: this.#state.checkedAt,
      binary: this.#state.binary,
      startedByPlugin: this.#state.startedByPlugin,
      autoStart: this.#config.fcc.autoStart,
      authenticated: this.token !== '',
    }
  }
}
