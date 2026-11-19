/**
 * Server-Sent Events reader used by both wire protocols.
 *
 * It decodes incrementally, handles multi-line `data:` fields, ignores
 * comments and `id:`/`retry:` fields, and calls `onActivity` for every frame
 * and heartbeat so the caller's stall watchdog can be re-armed.
 *
 * @module dsh-freeclaudecode-auto/sse
 */

import { ProviderFailure, CODES } from './failure.js'

/**
 * Iterate the data frames of an SSE response body.
 *
 * @param {ReadableStream<Uint8Array>} body - the response body.
 * @param {object} [options] - reader options.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {() => void} [options.onActivity] - called for every frame or comment.
 * @returns {AsyncGenerator<{event: string, data: string}>} decoded frames, in order.
 */
export async function* readSseFrames(body, options = {}) {
  const { signal, onActivity } = options
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** @type {string[]} */
  let dataLines = []
  let eventName = ''
  /** @type {string[]} */
  let pending = []
  let finished = false

  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    while (!finished) {
      if (signal?.aborted === true) {
        throw new ProviderFailure({ message: 'the request was aborted', code: CODES.ABORTED })
      }
      const { value, done } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })

      // Frames end at a blank line; CRLF and LF are both accepted.
      let boundary = buffer.search(/\r?\n\r?\n/u)
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + (buffer.startsWith('\r\n', boundary) ? 4 : 2))
        const event = parseFrame(frame)
        if (event !== undefined) {
          if (event.data === '[DONE]') {
            finished = true
            break
          }
          pending.push(event)
          eventName = ''
        }
        boundary = buffer.search(/\r?\n\r?\n/u)
      }

      while (pending.length > 0) {
        const next = pending.shift()
        yield next
        if (next.data === '[DONE]') {
          finished = true
          break
        }
      }
    }

    // A final frame without a trailing blank line is still a frame when the
    // socket closed cleanly after it.
    if (!finished && buffer.trim() !== '') {
      const event = parseFrame(buffer)
      if (event !== undefined && event.data !== '[DONE]') yield event
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    try {
      await reader.cancel()
    } catch {
      // The socket is already gone; there is nothing to release.
    }
    for (const _ of [eventName, dataLines]) void _
  }

  /**
   * Parse one frame into a data event, updating the frame state.
   * @param {string} frame - raw frame text.
   * @returns {{event: string, data: string} | undefined} the event, when the frame carries data.
   */
  function parseFrame(frame) {
    eventName = ''
    dataLines = []
    let sawField = false
    for (const rawLine of frame.split(/\r?\n/u)) {
      if (rawLine === '' || rawLine.startsWith(':')) {
        if (rawLine.startsWith(':')) onActivity?.()
        continue
      }
      const colon = rawLine.indexOf(':')
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
      const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /u, '')
      if (field === 'data') {
        dataLines.push(value)
        sawField = true
      } else if (field === 'event') {
        eventName = value
      }
    }
    if (!sawField && eventName === '') return undefined
    return { event: eventName, data: dataLines.join('\n') }
  }
}

/**
 * Parse one SSE data payload as JSON.
 * @param {{event: string, data: string}} frame - the frame.
 * @returns {Record<string, unknown>} the decoded object.
 * @throws {ProviderFailure} MALFORMED_RESPONSE when the payload is not a JSON object.
 */
export function jsonFrame(frame) {
  let value
  try {
    value = JSON.parse(frame.data)
  } catch {
    throw new ProviderFailure({
      message: 'the provider sent a malformed SSE payload',
      code: CODES.MALFORMED_RESPONSE,
    })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderFailure({
      message: 'the provider sent a non-object SSE payload',
      code: CODES.MALFORMED_RESPONSE,
    })
  }
  return value
}

/**
 * Race a promise against cancellation so a provider that stops reading its
 * socket cannot hold a turn forever.
 * @template T
 * @param {Promise<T>} promise - the operation.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<T>} the operation result.
 */
export function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(new ProviderFailure({ message: 'the request was aborted', code: CODES.ABORTED }))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderFailure({ message: 'the request was aborted', code: CODES.ABORTED }))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
