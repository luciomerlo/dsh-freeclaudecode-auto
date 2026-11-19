/**
 * Provider-failure taxonomy for the failover router.
 *
 * Every recoverable provider error becomes a `ProviderFailure` carrying plain
 * facts. The router routes on those facts — never on message text alone — to
 * decide cooldown length, retirement, or an immediate switch.
 *
 * @module dsh-freeclaudecode-auto/failure
 */

/** Failure codes this plugin raises or forwards. */
export const CODES = Object.freeze({
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  TTFT_TIMEOUT: 'TTFT_TIMEOUT',
  STALL: 'STALL',
  TRANSPORT: 'TRANSPORT',
  SERVER: 'SERVER',
  INVALID_REQUEST: 'INVALID_REQUEST',
  TOOL_UNSUPPORTED: 'TOOL_UNSUPPORTED',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  MODEL_MISSING: 'MODEL_MISSING',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  STREAM_CLOSED: 'STREAM_CLOSED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  DEGENERATE_RESPONSE: 'DEGENERATE_RESPONSE',
  CONTENT_FILTERED: 'CONTENT_FILTERED',
  ABORTED: 'ABORTED',
  NO_MODEL_AVAILABLE: 'NO_MODEL_AVAILABLE',
  CONFIGURATION: 'CONFIGURATION',
})

/** One provider failure, as the router observes it. */
export class ProviderFailure extends Error {
  /**
   * @param {object} failure - normalized facts.
   * @param {string} failure.message - human-readable summary.
   * @param {string} failure.code - one of {@link CODES} or a provider code.
   * @param {number} [failure.status] - HTTP status, when a response carried one.
   * @param {number} [failure.providerRetryAfterMs] - provider-requested delay.
   * @param {string} [failure.provider] - upstream provider id, for diagnostics.
   * @param {string} [failure.model] - upstream model id, for diagnostics.
   */
  constructor(failure) {
    super(failure.message)
    this.name = 'ProviderFailure'
    this.failure = {
      message: failure.message,
      code: failure.code,
      ...failure.status === undefined ? {} : { status: failure.status },
      ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
      ...failure.provider === undefined ? {} : { provider: failure.provider },
      ...failure.model === undefined ? {} : { model: failure.model },
    }
  }
}

const QUOTA_WORDS = /(quota|insufficient|credit|balance|exhausted|allowance|daily limit|monthly limit|out of funds)/iu
const AUTH_WORDS = /(invalid api key|api key|unauthori[sz]ed|forbidden|authentication|permission denied|token expired)/iu
const TOOL_WORDS = /(tool_choice|tool call|tool_calls|function call|tools? (?:are|is) not supported|does not support (?:tools|function))/iu
const CONTEXT_WORDS = /(context (?:window|length|limit)|maximum context|too many tokens|prompt is too long|input is too long)/iu

/**
 * Whether a message reads as an exhausted allowance rather than a transient limit.
 * @param {string} text - provider message.
 * @returns {boolean} true when it mentions quota or credit exhaustion.
 */
export function looksLikeQuota(text) {
  return QUOTA_WORDS.test(text)
}

/**
 * Whether a message reads as an authentication or permission problem.
 * @param {string} text - provider message.
 * @returns {boolean} true for auth wording.
 */
export function looksLikeAuth(text) {
  return AUTH_WORDS.test(text)
}

/**
 * Whether a rejected request is about tool calling rather than about the model
 * or the conversation.
 * @param {string} text - provider message.
 * @returns {boolean} true for tool-related wording.
 */
export function looksLikeToolRejection(text) {
  return TOOL_WORDS.test(text)
}

/**
 * Whether a failure is the oversized-context rejection the harness compactor
 * can repair. The router never fails over on this one.
 * @param {string} text - provider message.
 * @returns {boolean} true for context-overflow wording.
 */
export function looksLikeContextOverflow(text) {
  return CONTEXT_WORDS.test(text)
}

/**
 * Classify an HTTP status and message into one router reaction.
 *
 * @param {number | undefined} status - HTTP status.
 * @param {string} code - normalized failure code.
 * @param {string} message - provider message.
 * @returns {'auth' | 'quota' | 'rate' | 'tool' | 'rejected' | 'missing' | 'transient' | 'context' | 'fatal'}
 *   the reaction.
 */
export function classify(status, code, message = '') {
  const text = `${code} ${message}`
  if (code === CODES.CONTEXT_WINDOW_EXCEEDED || looksLikeContextOverflow(text)) return 'context'
  if (status === 401 || code === CODES.AUTH) return looksLikeQuota(text) ? 'quota' : 'auth'
  if (status === 402) return 'quota'
  if (status === 403) return looksLikeQuota(text) ? 'quota' : looksLikeAuth(text) ? 'auth' : 'quota'
  if (status === 404) return 'missing'
  if (status === 408) return 'transient'
  if (status === 429) return looksLikeQuota(text) ? 'quota' : 'rate'
  if (status === 400 || status === 413 || status === 422) {
    return looksLikeToolRejection(text) || code === CODES.TOOL_UNSUPPORTED ? 'tool' : 'rejected'
  }
  if (status !== undefined && status >= 500) return 'transient'
  if (code === CODES.RATE_LIMIT) return 'rate'
  if (code === CODES.QUOTA) return 'quota'
  if (code === CODES.MODEL_MISSING) return 'missing'
  if (code === CODES.CONTENT_FILTERED) return 'fatal'
  if (code === CODES.MALFORMED_RESPONSE || code === CODES.EMPTY_RESPONSE || code === CODES.DEGENERATE_RESPONSE) return 'transient'
  return 'transient'
}

/**
 * Parse a `Retry-After` header into milliseconds.
 * @param {string | null | undefined} value - header value (seconds or HTTP date).
 * @returns {number | undefined} a positive delay in milliseconds.
 */
export function retryAfterMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const seconds = Number(trimmed)
    return seconds > 0 ? Math.round(seconds * 1000) : undefined
  }
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  const delay = at - Date.now()
  return delay > 0 ? delay : undefined
}

/**
 * Build the failure facts for a thrown value.
 *
 * @param {unknown} error - the thrown value.
 * @param {AbortSignal | undefined} signal - the caller's signal, for ABORTED.
 * @param {{timeoutCode?: string, timeoutMs?: number}} [wake] - the watchdog that fired.
 * @returns {ProviderFailure['failure']} normalized facts.
 */
export function failureOf(error, signal, wake = {}) {
  if (error instanceof ProviderFailure) return error.failure
  if (signal?.aborted === true && wake.timeoutCode === undefined) {
    return { message: 'the request was cancelled', code: CODES.ABORTED }
  }
  if (wake.timeoutCode !== undefined) {
    return {
      message: wake.timeoutCode === CODES.TTFT_TIMEOUT
        ? `no response byte within ${String(wake.timeoutMs ?? 0)} ms`
        : `the response stalled for more than ${String(wake.timeoutMs ?? 0)} ms`,
      code: wake.timeoutCode,
    }
  }
  if (error !== null && typeof error === 'object') {
    const anyError = /** @type {any} */ (error)
    if (anyError.name === 'AbortError' || anyError.name === 'TimeoutError') {
      return { message: 'the request was aborted', code: CODES.TIMEOUT }
    }
    if (anyError.failure !== undefined && typeof anyError.failure === 'object') {
      const failure = anyError.failure
      return {
        message: typeof failure.message === 'string' ? failure.message : 'provider failure',
        code: typeof failure.code === 'string' ? failure.code : CODES.TRANSPORT,
        ...typeof failure.status === 'number' ? { status: failure.status } : {},
        ...typeof failure.providerRetryAfterMs === 'number' ? { providerRetryAfterMs: failure.providerRetryAfterMs } : {},
      }
    }
    const message = typeof anyError.message === 'string' ? anyError.message : String(error)
    const code = typeof anyError.code === 'string' && anyError.code.length > 0 ? anyError.code : CODES.TRANSPORT
    return { message, code, ...typeof anyError.status === 'number' ? { status: anyError.status } : {} }
  }
  return { message: String(error), code: CODES.TRANSPORT }
}

/**
 * Detect a refusal, quota notice, or gateway error delivered as ordinary
 * assistant text with HTTP 200.
 *
 * Providers behind free tiers do this often: the HTTP layer reports success
 * while the body says the account is out of credit. Treating that text as a
 * normal answer would silently replace the user's task with an error message,
 * so the router switches models instead.
 *
 * @param {string} text - accumulated assistant text.
 * @returns {boolean} true when the text is a degenerate provider notice.
 */
export function isDegenerateResponse(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 400) return false
  if (/```/u.test(trimmed)) return false
  return /(rate limit (?:exceeded|reached)|too many requests|quota (?:exceeded|exhausted|reached)|insufficient (?:quota|credit|balance|funds)|out of credits|credit balance|no (?:available )?(?:model|capacity)|model (?:is )?overloaded|service (?:is )?unavailable|temporarily unavailable|please try again later|invalid api key|unauthorized|api key (?:is )?(?:invalid|expired|missing))/iu.test(trimmed)
}
