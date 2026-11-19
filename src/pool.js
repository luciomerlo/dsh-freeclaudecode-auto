/**
 * The candidate pool: ordered free models, live health, and the circuit
 * breaker that keeps a failing provider out of the next turn.
 *
 * The pool owns no I/O and no timers beyond reading an injectable clock, so
 * ranking and breaker behavior are directly unit-testable.
 *
 * @module dsh-freeclaudecode-auto/pool
 */

import { classify, CODES } from './failure.js'

/** Cooldown ladder applied to a candidate that keeps failing transiently. */
export const TRANSIENT_LADDER_MS = [30_000, 120_000, 600_000]

/** Base cooldown for a rate-limited candidate. */
export const RATE_LIMIT_BASE_MS = 30_000

/** Longest cooldown a rate-limited candidate can receive. */
export const RATE_LIMIT_MAX_MS = 600_000

/** Time an exhausted or unauthorized provider stays out of rotation. */
export const RETIRED_MS = 6 * 60 * 60 * 1000

/** Time a candidate that rejected tool calling is only used for plain chat. */
export const TOOL_WINDOW_MS = 30 * 60 * 1000

/** A candidate's health record. */
function freshHealth() {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    ewmaSuccess: 0.65,
    ewmaLatencyMs: 2500,
    cooldownUntil: 0,
    cooldownReason: '',
    retiredUntil: 0,
    toolsBrokenUntil: 0,
    lastError: '',
    lastServedAt: 0,
  }
}

/** Tier priority per routing profile. */
const TIER_WEIGHT = {
  auto: { coding: 100, general: 70, fast: 40 },
  best: { coding: 120, general: 50, fast: 10 },
  fast: { fast: 120, general: 70, coding: 20 },
  explicit: { coding: 100, general: 70, fast: 40 },
}

/**
 * The model pool and its routing policy.
 */
export class CandidatePool {
  /** @type {object[]} */
  #candidates = []
  /** @type {Map<string, ReturnType<typeof freshHealth>>} */
  #health = new Map()
  /** @type {object} */
  #config
  /** @type {() => number} */
  #now
  /** @type {object} */
  #logger

  /**
   * @param {object} options - pool dependencies.
   * @param {object} options.config - resolved plugin config.
   * @param {() => number} [options.now] - injectable clock.
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger] - diagnostics sink.
   */
  constructor({ config, now = Date.now, logger }) {
    this.#config = config
    this.#now = now
    this.#logger = logger ?? { warn() {}, info() {}, debug() {} }
  }

  /**
   * Replace the catalog. Health survives across refreshes so a model that
   * failed before the refresh is not retried just because the list changed.
   * @param {object[]} candidates - complete candidate list.
   * @returns {void}
   */
  replace(candidates) {
    this.#candidates = candidates.filter(candidate => typeof candidate?.key === 'string' && candidate.key !== '')
    for (const candidate of this.#candidates) {
      if (!this.#health.has(candidate.key)) this.#health.set(candidate.key, freshHealth())
    }
  }

  /** @returns {object[]} the current catalog. */
  list() {
    return this.#candidates
  }

  /**
   * Find one candidate by its catalog id.
   * @param {string} catalogId - the id shown in the model selector.
   * @returns {object | undefined} the candidate.
   */
  byCatalogId(catalogId) {
    return this.#candidates.find(candidate => candidate.catalogId === catalogId)
  }

  /**
   * Whether a candidate may be attempted now.
   * @param {object} candidate - the candidate.
   * @param {number} now - current time.
   * @param {boolean} needsTools - whether the request declares tools.
   * @returns {string | undefined} a reason when blocked, otherwise undefined.
   */
  blockedReason(candidate, now, needsTools) {
    const health = this.#health.get(candidate.key) ?? freshHealth()
    if (health.retiredUntil > now) {
      return `retired for ${String(Math.ceil((health.retiredUntil - now) / 1000))}s (${health.cooldownReason})`
    }
    if (needsTools && candidate.tools !== true) return 'no verified tool calling'
    if (needsTools && health.toolsBrokenUntil > now) return 'tool calling was rejected recently'
    if (health.cooldownUntil > now) {
      return `cooling down for ${String(Math.ceil((health.cooldownUntil - now) / 1000))}s (${health.cooldownReason})`
    }
    return undefined
  }

  /**
   * Rank one candidate for the current profile.
   * @param {object} candidate - the candidate.
   * @param {'auto' | 'best' | 'fast' | 'explicit'} profile - routing profile.
   * @param {boolean} needsTools - whether tools are required.
   * @param {number} preferenceRank - rank in the explicit preference list, or -1.
   * @returns {number} the score; higher is better.
   */
  score(candidate, profile, needsTools, preferenceRank) {
    const health = this.#health.get(candidate.key) ?? freshHealth()
    const weights = TIER_WEIGHT[profile] ?? TIER_WEIGHT.auto
    let score = weights[candidate.tier] ?? weights.general
    if (needsTools) score += candidate.tools === true ? 20 : -1000
    score += health.ewmaSuccess * 30
    score -= Math.min(health.ewmaLatencyMs / 600, 25)
    if (health.consecutiveFailures > 0) score -= health.consecutiveFailures * 12
    if (preferenceRank >= 0) score += 1000 - preferenceRank
    return score
  }

  /**
   * Build the ordered attempt list for one request.
   *
   * @param {object} request - the routing request.
   * @param {'auto' | 'best' | 'fast' | 'explicit'} request.profile - routing profile.
   * @param {string} [request.explicitId] - catalog id the user selected.
   * @param {object} request.options - harness generate options.
   * @returns {object[]} available candidates, best first.
   */
  plan({ profile, explicitId, options }) {
    const now = this.#now()
    const needsTools = Array.isArray(options.tools) && options.tools.length > 0
    const disabled = this.#config.disabledModels
    const preferred = this.#config.preferredOrder

    const available = this.#candidates.filter((candidate) => {
      if (disabled.has(candidate.key) || disabled.has(candidate.catalogId)) return false
      if (candidate.source !== 'fcc' && (typeof candidate.apiKey !== 'string' || candidate.apiKey === '')) return false
      if (needsTools && candidate.tools !== true) return false
      return this.blockedReason(candidate, now, needsTools) === undefined
    })

    const ranked = available.map((candidate) => {
      const preferenceRank = preferred.indexOf(candidate.catalogId)
      return { candidate, score: this.score(candidate, profile, needsTools, preferenceRank) }
    })
    ranked.sort((left, right) => right.score - left.score || left.candidate.catalogId.localeCompare(right.candidate.catalogId))

    /** @type {object[]} */
    const ordered = []
    if (profile === 'explicit' && explicitId !== undefined) {
      const chosen = this.#candidates.find(candidate => candidate.catalogId === explicitId)
      const health = chosen === undefined ? undefined : this.#health.get(chosen.key)
      if (chosen !== undefined && health !== undefined && health.retiredUntil <= now) {
        ordered.push(chosen)
      }
    }
    for (const entry of ranked) {
      if (ordered.some(candidate => candidate.key === entry.candidate.key)) continue
      ordered.push(entry.candidate)
    }
    if (ordered.length === 0) {
      // Zero-drop fallback: when every candidate is cooling down, attempt the
      // one whose cooldown ends soonest rather than failing the turn outright.
      const fallback = this.#candidates
        .filter(candidate => !disabled.has(candidate.key) && !disabled.has(candidate.catalogId))
        .filter(candidate => candidate.source === 'fcc' || (typeof candidate.apiKey === 'string' && candidate.apiKey !== ''))
        .filter(candidate => !needsTools || candidate.tools === true)
        .filter((candidate) => {
          const health = this.#health.get(candidate.key) ?? freshHealth()
          return health.retiredUntil <= now
        })
        .sort((left, right) => {
          const leftHealth = this.#health.get(left.key) ?? freshHealth()
          const rightHealth = this.#health.get(right.key) ?? freshHealth()
          return leftHealth.cooldownUntil - rightHealth.cooldownUntil
        })
      if (fallback.length > 0) ordered.push(fallback[0])
    }
    return ordered.slice(0, this.#config.maxFailovers)
  }

  /**
   * Record one successful attempt.
   * @param {object} candidate - the candidate that answered.
   * @param {{latencyMs?: number, ttftMs?: number}} metrics - observed timings.
   * @returns {void}
   */
  recordSuccess(candidate, metrics = {}) {
    const health = this.#health.get(candidate.key) ?? freshHealth()
    health.attempts += 1
    health.successes += 1
    health.consecutiveFailures = 0
    health.cooldownUntil = 0
    health.cooldownReason = ''
    health.lastServedAt = this.#now()
    health.ewmaSuccess = health.ewmaSuccess * 0.7 + 0.3
    if (typeof metrics.ttftMs === 'number' && metrics.ttftMs > 0) {
      health.ewmaLatencyMs = health.ewmaLatencyMs * 0.7 + metrics.ttftMs * 0.3
    }
    this.#health.set(candidate.key, health)
  }

  /**
   * Record one failed attempt and apply the reaction its class demands.
   *
   * @param {object} candidate - the candidate that failed.
   * @param {object} failure - normalized failure facts.
   * @returns {{reaction: string, cooldownMs: number}} the applied reaction.
   */
  recordFailure(candidate, failure) {
    const now = this.#now()
    const health = this.#health.get(candidate.key) ?? freshHealth()
    health.attempts += 1
    health.failures += 1
    health.consecutiveFailures += 1
    health.lastError = `${failure.code ?? 'FAILED'}: ${String(failure.message ?? '').slice(0, 200)}`
    health.ewmaSuccess = Math.max(0, health.ewmaSuccess * 0.7)
    const reaction = classify(failure.status, failure.code, failure.message ?? '')

    let cooldownMs = 0
    switch (reaction) {
      case 'auth':
      case 'quota':
      case 'missing':
        health.retiredUntil = now + RETIRED_MS
        health.cooldownReason = reaction
        cooldownMs = RETIRED_MS
        this.#logger.warn(
          `freeclaudecode: retiring ${candidate.catalogId} for 6h (${reaction}: ${String(failure.message ?? '').slice(0, 160)})`,
        )
        break
      case 'rate': {
        const base = Math.min(RATE_LIMIT_BASE_MS * 2 ** Math.min(health.consecutiveFailures - 1, 4), RATE_LIMIT_MAX_MS)
        cooldownMs = typeof failure.providerRetryAfterMs === 'number' && failure.providerRetryAfterMs > 0
          ? Math.min(Math.max(failure.providerRetryAfterMs, 1000), RATE_LIMIT_MAX_MS)
          : base
        health.cooldownUntil = now + cooldownMs
        health.cooldownReason = 'rate limit'
        break
      }
      case 'tool':
        cooldownMs = 120_000
        health.cooldownUntil = now + cooldownMs
        health.cooldownReason = 'tool rejection'
        health.toolsBrokenUntil = now + TOOL_WINDOW_MS
        break
      case 'rejected':
        cooldownMs = 600_000
        health.cooldownUntil = now + cooldownMs
        health.cooldownReason = 'request rejected'
        break
      case 'transient': {
        const step = Math.min(health.consecutiveFailures - 1, TRANSIENT_LADDER_MS.length - 1)
        cooldownMs = TRANSIENT_LADDER_MS[Math.max(0, step)]
        health.cooldownUntil = now + cooldownMs
        health.cooldownReason = failure.code === CODES.TTFT_TIMEOUT
          ? 'slow first token'
          : failure.code === CODES.STALL ? 'stalled stream' : 'transient failure'
        break
      }
      case 'context':
      case 'fatal':
      default:
        // Neither an oversized request nor a filtered response says anything
        // about this candidate's health.
        cooldownMs = 0
        break
    }
    this.#health.set(candidate.key, health)
    return { reaction, cooldownMs }
  }

  /**
   * Explain why one candidate is currently skipped.
   * @param {string} key - candidate key.
   * @param {boolean} [needsTools] - whether tools were required.
   * @returns {string | undefined} the reason, when blocked.
   */
  blockedByKey(key, needsTools = false) {
    const candidate = this.#candidates.find(entry => entry.key === key)
    if (candidate === undefined) return 'not in the current catalog'
    return this.blockedReason(candidate, this.#now(), needsTools)
  }

  /**
   * Freeze the pool state for the status surface.
   * @returns {object} a detached snapshot.
   */
  snapshot() {
    const now = this.#now()
    const candidates = this.#candidates.map((candidate) => {
      const health = this.#health.get(candidate.key) ?? freshHealth()
      return {
        catalogId: candidate.catalogId,
        provider: candidate.provider,
        upstreamModel: candidate.upstreamModel,
        source: candidate.source,
        wire: candidate.wire,
        tier: candidate.tier,
        tools: candidate.tools,
        contextWindow: candidate.contextWindow,
        attempts: health.attempts,
        successes: health.successes,
        failures: health.failures,
        successRate: health.attempts === 0 ? null : Number((health.successes / health.attempts).toFixed(3)),
        ewmaLatencyMs: Math.round(health.ewmaLatencyMs),
        cooldownMs: Math.max(0, health.cooldownUntil - now),
        retiredMs: Math.max(0, health.retiredUntil - now),
        toolsBrokenMs: Math.max(0, health.toolsBrokenUntil - now),
        blocked: this.blockedReason(candidate, now, false) ?? null,
        lastError: health.lastError === '' ? null : health.lastError,
      }
    })
    const ready = candidates.filter(candidate => candidate.blocked === null)
    return {
      size: candidates.length,
      ready: ready.length,
      cooling: candidates.filter(candidate => candidate.cooldownMs > 0).length,
      retired: candidates.filter(candidate => candidate.retiredMs > 0).length,
      byTier: {
        coding: candidates.filter(candidate => candidate.tier === 'coding').length,
        general: candidates.filter(candidate => candidate.tier === 'general').length,
        fast: candidates.filter(candidate => candidate.tier === 'fast').length,
      },
      candidates,
    }
  }
}
