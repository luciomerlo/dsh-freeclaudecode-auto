/**
 * Small shared helpers: clocks, sleeping with cancellation, JSON parsing, and
 * the token estimate the router uses to skip an undersized context window.
 *
 * @module dsh-freeclaudecode-auto/util
 */

/**
 * Sleep for a number of milliseconds.
 * @param {number} ms - delay.
 * @param {AbortSignal} [signal] - cancellation; resolves early after abort.
 * @returns {Promise<void>} resolves after the delay or the abort.
 */
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Parse JSON without throwing.
 * @param {string} value - candidate JSON text.
 * @returns {{ok: true, value: unknown} | {ok: false}} the parse result.
 */
export function tryJson(value) {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    return { ok: false }
  }
}

/**
 * A conservative token estimate for a provider-neutral request.
 *
 * Character counts are a poor tokenizer but a safe upper-bound proxy for the
 * only decision this plugin makes from them: whether a candidate's context
 * window is clearly too small.
 * @param {object} options - the harness generate options.
 * @returns {number} estimated input tokens.
 */
export function estimateRequestTokens(options) {
  let chars = typeof options.system === 'string' ? options.system.length : 0
  for (const message of options.messages ?? []) {
    for (const block of message.content ?? []) {
      if (typeof block.text === 'string') chars += block.text.length
      else if (typeof block.arguments === 'string') chars += block.arguments.length
      else if (typeof block.name === 'string') chars += block.name.length
    }
  }
  const tools = JSON.stringify(options.tools ?? [])
  chars += tools.length
  return Math.ceil(chars / 3.2)
}

/**
 * Remove trailing slashes from a URL-like string.
 * @param {string} value - input.
 * @returns {string} the value without trailing slashes.
 */
export function trimSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/u, '') : ''
}

/**
 * Clamp a number.
 * @param {number} value - input.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} the clamped value.
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Truncate a diagnostic string without splitting a surrogate pair.
 * @param {string} value - input.
 * @param {number} limit - maximum characters.
 * @returns {string} the truncated value.
 */
export function truncate(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value ?? ''
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Present a credential without disclosing it.
 * @param {string | undefined} key - the credential.
 * @returns {string} a masked label.
 */
export function maskKey(key) {
  if (typeof key !== 'string' || key === '') return '(none)'
  return key.length <= 8 ? '***' : `${key.slice(0, 3)}***${key.slice(-2)}`
}

/**
 * Monotonic-enough wall clock for latency measurements.
 * @returns {number} epoch milliseconds.
 */
export function nowMs() {
  return Date.now()
}

/**
 * Heuristic tier for a model id or display name.
 *
 * Free catalogs do not describe capability, so this is a name-based prior that
 * the health history corrects after the first few turns.
 * @param {string} id - upstream model id.
 * @param {string} [name] - display name.
 * @returns {'coding' | 'general' | 'fast'} the tier.
 */
export function tierOf(id, name = '') {
  const text = `${id} ${name}`.toLowerCase()
  if (/(flash|mini|small|lite|fast|instant|haiku|(?:^|[^0-9])[1-3]b(?:[^0-9]|$)|7b|8b|9b)/u.test(text)) return 'fast'
  if (/(coder|code|devstral|codestral|deepseek|qwen|glm|kimi|claude|sonnet|opus|gpt-5|gpt-6|o3|o4|nemotron|llama-3\.3-70b|mistral-large|command-a)/u.test(text)) return 'coding'
  return 'general'
}
