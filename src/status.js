/**
 * In-memory observability for the provider route.
 *
 * It records one row per turn, one row per silent failover, and the current
 * pool and fcc state. The same snapshot feeds the log line, the
 * `freeclaudecode_status` tool, and the composer badge.
 *
 * @module dsh-freeclaudecode-auto/status
 */

/** Detail retained for recent turns. */
const MAX_TURNS = 50

/** Detail retained for recent failovers. */
const MAX_FAILOVERS = 50

/** Recent-turn and failover history with rolling counters. */
export class StatusRegistry {
  /** @type {object[]} */
  #turns = []
  /** @type {object[]} */
  #failovers = []
  /** @type {object[]} */
  #failures = []
  /** @type {number} */
  #startedAt = Date.now()
  /** @type {() => number} */
  #now

  /**
   * @param {object} [options] - registry options.
   * @param {() => number} [options.now] - injectable clock.
   */
  constructor({ now = Date.now } = {}) {
    this.#now = now
  }

  /**
   * Record one completed turn.
   * @param {object} turn - turn facts.
   * @returns {void}
   */
  recordTurn(turn) {
    this.#turns.push({
      at: turn.at ?? this.#now(),
      label: turn.label,
      requestedModel: turn.requestedModel,
      servedModel: turn.servedModel,
      failovers: turn.failovers ?? 0,
      durationMs: turn.durationMs ?? 0,
      ttftMs: turn.ttftMs ?? null,
      error: turn.error ?? null,
      attempts: Array.isArray(turn.attempts) ? turn.attempts : [],
    })
    if (this.#turns.length > MAX_TURNS) this.#turns.shift()
  }

  /**
   * Record one silent failover.
   * @param {object} step - failover facts.
   * @returns {void}
   */
  recordFailover(step) {
    this.#failovers.push({
      at: step.at ?? this.#now(),
      from: step.from,
      to: step.to,
      reaction: step.reaction,
      code: step.code,
      switchMs: step.switchMs ?? null,
    })
    if (this.#failovers.length > MAX_FAILOVERS) this.#failovers.shift()
  }

  /**
   * Record one candidate failure for the rolling diagnostics.
   * @param {{catalogId: string, failure: object, reaction: string}} entry - failure facts.
   * @returns {void}
   */
  recordFailure(entry) {
    this.#failures.push({
      at: this.#now(),
      catalogId: entry.catalogId,
      code: entry.failure?.code ?? 'FAILED',
      status: entry.failure?.status ?? null,
      reaction: entry.reaction,
      message: String(entry.failure?.message ?? '').slice(0, 300),
    })
    if (this.#failures.length > MAX_FAILOVERS) this.#failures.shift()
  }

  /**
   * Freeze the observability state.
   * @param {object} context - live collaborators.
   * @param {object} context.pool - the candidate pool.
   * @param {object} context.fcc - the fcc bridge snapshot.
   * @param {object} context.config - resolved plugin config.
   * @param {string} context.version - plugin version.
   * @returns {object} a detached snapshot.
   */
  snapshot({ pool, fcc, config, version }) {
    const now = this.#now()
    const turns = [...this.#turns].reverse().slice(0, 10)
    const last = turns[0] ?? null
    const poolSnapshot = pool.snapshot()
    const totalFailovers = this.#turns.reduce((sum, turn) => sum + turn.failovers, 0)
    const health = poolSnapshot.ready === 0
      ? 'offline'
      : fcc.available && last !== null && last.error === null ? 'healthy'
        : last === null || last.error === null ? (fcc.available ? 'healthy' : 'degraded') : 'degraded'
    return {
      plugin: 'dsh-freeclaudecode-auto',
      version,
      now,
      uptimeMs: now - this.#startedAt,
      health,
      routing: {
        providerId: config.providerId,
        providerName: config.providerName,
        modes: {
          auto: config.autoModelName,
          best: config.bestModelName,
          fast: config.fastModelName,
        },
        ttftTimeoutMs: config.ttftTimeoutMs,
        stallTimeoutMs: config.stallTimeoutMs,
        maxFailovers: config.maxFailovers,
        continuation: config.continuation,
      },
      fcc,
      pool: poolSnapshot,
      session: {
        turns: this.#turns.length,
        failovers: totalFailovers,
        lastTurn: last,
        recentTurns: turns,
        recentFailovers: [...this.#failovers].reverse().slice(0, 10),
        recentFailures: [...this.#failures].reverse().slice(0, 10),
      },
    }
  }
}
