/**
 * Shared HTTP boundary: one streaming POST normalized into either a response
 * body or a `ProviderFailure` carrying the provider's status and retry delay.
 *
 * @module dsh-freeclaudecode-auto/wire/http
 */

import { ProviderFailure, CODES, retryAfterMs } from '../failure.js'

/**
 * Merge cancellation signals without requiring `AbortSignal.any`.
 * @param {AbortSignal[]} signals - signals to combine.
 * @returns {AbortSignal} a signal aborted when any input aborts.
 */
export function mergeSignals(signals) {
  const live = signals.filter(signal => signal !== undefined)
  if (live.length === 1) return live[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(live)
  const controller = new AbortController()
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * Read at most `limit` characters of an error body.
 * @param {Response} response - the failed response.
 * @returns {Promise<string>} the body text.
 */
async function errorText(response) {
  try {
    const text = await response.text()
    return text.length > 8000 ? text.slice(0, 8000) : text
  } catch {
    return ''
  }
}

/**
 * Pull a provider message out of an error body.
 * @param {string} text - raw body.
 * @returns {string} the most specific message available.
 */
export function providerMessage(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  try {
    const value = JSON.parse(text)
    const error = value?.error
    if (typeof error === 'string') return error
    if (error !== null && typeof error === 'object') {
      const parts = [error.type, error.code, error.message].filter(part => typeof part === 'string' && part !== '')
      if (parts.length > 0) return parts.join(': ')
    }
    if (typeof value?.message === 'string') return value.message
  } catch {
    // A gateway that does not answer JSON still has a useful status line.
  }
  return text.trim().slice(0, 500)
}

/**
 * POST a streaming request and return its body.
 *
 * @param {Function} fetchImpl - the fetch implementation.
 * @param {object} request - the request.
 * @param {string} request.url - absolute URL.
 * @param {Record<string, string>} request.headers - request headers.
 * @param {unknown} request.body - JSON-serializable body.
 * @param {AbortSignal} request.signal - cancellation, including the watchdogs.
 * @param {string} request.provider - provider id for diagnostics.
 * @param {string} request.model - model id for diagnostics.
 * @returns {Promise<ReadableStream<Uint8Array>>} the streaming body.
 * @throws {ProviderFailure} for a non-success status or a missing body.
 */
export async function openStream(fetchImpl, request) {
  const who = request.label ?? `${request.provider}/${request.model}`
  let response
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
      redirect: 'error',
    })
  } catch (error) {
    if (request.signal.aborted) {
      throw new ProviderFailure({ message: 'the request was aborted', code: CODES.ABORTED, provider: request.provider, model: request.model })
    }
    throw new ProviderFailure({
      message: error instanceof Error ? error.message : 'the provider could not be reached',
      code: CODES.TRANSPORT,
      provider: request.provider,
      model: request.model,
    })
  }

  if (!response.ok) {
    const text = await errorText(response)
    const message = providerMessage(text)
    throw new ProviderFailure({
      message: `${who}: HTTP ${String(response.status)}${message === '' ? '' : ` — ${message}`}`,
      code: response.status === 401 || response.status === 403
        ? CODES.AUTH
        : response.status === 402
          ? CODES.QUOTA
          : response.status === 429
            ? CODES.RATE_LIMIT
            : response.status >= 500
              ? CODES.SERVER
              : CODES.INVALID_REQUEST,
      status: response.status,
      ...retryAfterMs(response.headers.get('retry-after')) === undefined
        ? {}
        : { providerRetryAfterMs: retryAfterMs(response.headers.get('retry-after')) },
      provider: request.provider,
      model: request.model,
    })
  }

  if (response.body === null) {
    throw new ProviderFailure({
      message: `${who}: the response carried no body`,
      code: CODES.EMPTY_RESPONSE,
      status: response.status,
      provider: request.provider,
      model: request.model,
    })
  }
  return response.body
}
