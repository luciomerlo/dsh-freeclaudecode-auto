/**
 * Plugin configuration: defaults, validation, and path resolution.
 *
 * Every key is a plain JSON value so a profile patch can override it. Secrets
 * never appear here: provider keys are read from the environment or from
 * Free Claude Code's own `~/.fcc/.env`.
 *
 * @module dsh-freeclaudecode-auto/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default Free Claude Code config directory name below the user's home. */
export const FCC_CONFIG_DIRNAME = '.fcc'

/** Free Claude Code's default local proxy port. */
export const FCC_DEFAULT_PORT = 8082

/** Default plugin configuration. */
export const DEFAULTS = {
  providerId: 'freeclaudecode',
  providerName: 'FreeClaudeCode',
  autoModelId: 'auto',
  autoModelName: 'Auto (FreeClaudeCode)',
  bestModelName: 'FreeClaudeCode - Best Coding',
  fastModelName: 'FreeClaudeCode - Fast / Subagent',

  fcc: {
    enabled: true,
    directory: '',
    baseUrl: '',
    autoStart: true,
    startupTimeoutMs: 20000,
    probeTimeoutMs: 1500,
  },

  ttftTimeoutMs: 8000,
  stallTimeoutMs: 12000,
  maxFailovers: 8,
  requestTimeoutMs: 600000,
  continuation: true,

  autoContextWindow: 131072,
  autoMaxTokens: 32768,

  directProviders: { enabled: true },
  extraProviders: [],
  preferredOrder: [],
  disabledModels: [],

  refreshCatalogOnFailover: true,
  logTurns: true,
  statusRoute: true,
}

/** A finite number at least `min`, or `min` when unusable. */
function positive(value, fallback, min = 1) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
}

/** Coerce a value to a trimmed non-empty string, or the fallback. */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Coerce a value to a string array. */
function stringList(value) {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim()) : []
}

/**
 * Merge the loader row config over the defaults and validate it.
 *
 * @param {Record<string, unknown> | undefined} input - the loader row config.
 * @returns {object} the resolved config, with absolute `fcc.directory` and a
 *   normalized `fcc.baseUrl`.
 * @throws {Error} when a value cannot be used at all and guessing would hide it.
 */
export function resolveConfig(input) {
  const raw = input ?? {}
  const defaults = DEFAULTS
  const fccInput = raw.fcc !== null && typeof raw.fcc === 'object' ? raw.fcc : {}
  const directInput = raw.directProviders !== null && typeof raw.directProviders === 'object' ? raw.directProviders : {}

  const directory = text(fccInput.directory ?? defaults.fcc.directory, '')
  const resolvedDirectory = directory === '' ? join(homedir(), FCC_CONFIG_DIRNAME) : directory

  const configuredBase = text(fccInput.baseUrl ?? defaults.fcc.baseUrl, '')
  const baseUrl = (configuredBase === '' ? `http://127.0.0.1:${FCC_DEFAULT_PORT}` : configuredBase).replace(/\/+$/u, '')

  const providerId = text(raw.providerId, defaults.providerId)
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(providerId)) {
    throw new Error(`freeclaudecode: invalid providerId "${providerId}" (use lowercase letters, digits, dot, dash, underscore)`)
  }

  const extraProviders = Array.isArray(raw.extraProviders)
    ? raw.extraProviders.filter(entry => entry !== null && typeof entry === 'object').map((entry) => {
      const id = text(entry.id, '')
      const base = text(entry.baseUrl, '')
      if (id === '' || base === '') {
        throw new Error('freeclaudecode: every extraProviders entry needs a non-empty id and baseUrl')
      }
      return {
        id,
        baseUrl: base.replace(/\/+$/u, ''),
        apiKeyEnv: stringList([entry.apiKeyEnv]).at(0) ?? '',
        wire: entry.wire === 'anthropic' ? 'anthropic' : 'openai',
        label: text(entry.label, id),
        models: stringList(entry.models),
        contextWindow: Math.round(positive(entry.contextWindow, 131072, 1024)),
        maxTokens: Math.round(positive(entry.maxTokens, 32768, 256)),
        tier: ['coding', 'general', 'fast'].includes(entry.tier) ? entry.tier : 'general',
        tools: entry.tools !== false,
        headers: entry.headers !== null && typeof entry.headers === 'object' ? { ...entry.headers } : {},
      }
    })
    : []

  const resolved = {
    providerId,
    providerName: text(raw.providerName, defaults.providerName),
    autoModelId: text(raw.autoModelId, defaults.autoModelId),
    autoModelName: text(raw.autoModelName, defaults.autoModelName),
    bestModelName: text(raw.bestModelName, defaults.bestModelName),
    fastModelName: text(raw.fastModelName, defaults.fastModelName),

    fcc: {
      enabled: fccInput.enabled !== false,
      directory: resolvedDirectory,
      baseUrl,
      autoStart: fccInput.autoStart !== false,
      startupTimeoutMs: Math.round(positive(fccInput.startupTimeoutMs, defaults.fcc.startupTimeoutMs, 500)),
      probeTimeoutMs: Math.round(positive(fccInput.probeTimeoutMs, defaults.fcc.probeTimeoutMs, 100)),
      binary: text(fccInput.binary, ''),
      envFile: text(fccInput.envFile, ''),
    },

    ttftTimeoutMs: Math.round(positive(raw.ttftTimeoutMs, defaults.ttftTimeoutMs, 100)),
    stallTimeoutMs: Math.round(positive(raw.stallTimeoutMs, defaults.stallTimeoutMs, 100)),
    maxFailovers: Math.round(positive(raw.maxFailovers, defaults.maxFailovers, 1)),
    requestTimeoutMs: Math.round(positive(raw.requestTimeoutMs, defaults.requestTimeoutMs, 1000)),
    continuation: raw.continuation !== false,

    autoContextWindow: Math.round(positive(raw.autoContextWindow, defaults.autoContextWindow, 1024)),
    autoMaxTokens: Math.round(positive(raw.autoMaxTokens, defaults.autoMaxTokens, 256)),

    directProviders: { enabled: directInput.enabled !== false },
    extraProviders,
    preferredOrder: stringList(raw.preferredOrder),
    disabledModels: new Set(stringList(raw.disabledModels)),

    refreshCatalogOnFailover: raw.refreshCatalogOnFailover !== false,
    logTurns: raw.logTurns !== false,
    statusRoute: raw.statusRoute !== false,
  }

  if (resolved.autoModelId === 'best' || resolved.autoModelId === 'fast') {
    throw new Error('freeclaudecode: autoModelId cannot be "best" or "fast" (reserved profile ids)')
  }
  return resolved
}

/**
 * Classify one model id selected in the DSH catalog.
 *
 * @param {string} modelId - the selected model id.
 * @param {object} config - resolved plugin config.
 * @returns {{profile: 'auto' | 'best' | 'fast' | 'explicit', explicitId?: string}}
 *   the routing profile and, for an explicit selection, its catalog id.
 */
export function profileOf(modelId, config) {
  if (modelId === config.autoModelId) return { profile: 'auto' }
  if (modelId === 'best') return { profile: 'best' }
  if (modelId === 'fast') return { profile: 'fast' }
  return { profile: 'explicit', explicitId: modelId }
}

/**
 * The display label for one routing profile.
 *
 * @param {'auto' | 'best' | 'fast' | 'explicit'} profile - the profile.
 * @param {object} config - resolved plugin config.
 * @returns {string} the label.
 */
export function profileLabel(profile, config) {
  if (profile === 'auto') return config.autoModelName
  if (profile === 'best') return config.bestModelName
  if (profile === 'fast') return config.fastModelName
  return 'FreeClaudeCode'
}
