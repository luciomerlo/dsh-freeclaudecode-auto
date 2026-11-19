/**
 * Shared test harness: a local streaming server, candidate factories, and a
 * runner wired to a pool the test controls.
 *
 * @module dsh-freeclaudecode-auto/test/helpers
 */

import { createServer } from 'node:http'

import { resolveConfig } from '../src/config.js'
import { CandidatePool } from '../src/pool.js'
import { createRunner } from '../src/runner.js'
import { StatusRegistry } from '../src/status.js'

/** A logger that records instead of printing. */
export function testLogger() {
  const lines = []
  return {
    lines,
    info: (...args) => lines.push(['info', args.join(' ')]),
    warn: (...args) => lines.push(['warn', args.join(' ')]),
    debug: () => {},
  }
}

/**
 * Start a local HTTP server that records every request body.
 * @param {(request: {req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: any, index: number}) => void | Promise<void>} handler
 *   request handler.
 * @returns {Promise<{baseUrl: string, requests: object[], close: () => Promise<void>}>} the server handle.
 */
export async function startServer(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      const entry = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(entry)
      Promise.resolve(handler({ req, res, body, index: requests.length - 1 })).catch(() => {
        try {
          res.destroy()
        } catch {
          // The client already closed the socket.
        }
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/** Write SSE response headers. */
export function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

/** Write one SSE data frame. */
export function sse(res, value) {
  res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)
}

/** Stream one OpenAI text delta. */
export function openAiText(res, text) {
  sse(res, { choices: [{ index: 0, delta: { content: text } }] })
}

/** Stream one OpenAI finish frame. */
export function openAiFinish(res, reason = 'stop', usage) {
  sse(res, {
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...usage === undefined ? {} : { usage },
  })
  sse(res, '[DONE]')
}

/** Stream one complete OpenAI answer. */
export function openAiAnswer(res, text, reason = 'stop') {
  sseHead(res)
  openAiText(res, text)
  openAiFinish(res, reason)
  res.end()
}

/** Stream one Anthropic message using the fcc proxy's wire format. */
export function anthropicAnswer(res, text) {
  sseHead(res)
  sse(res, { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 12 } } })
  sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  sse(res, { type: 'content_block_stop', index: 0 })
  sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })
  sse(res, { type: 'message_stop' })
  res.end()
}

/**
 * Build one candidate record.
 * @param {string} baseUrl - the local server root.
 * @param {object} options - candidate overrides.
 * @returns {object} the candidate.
 */
export function candidateAt(baseUrl, options = {}) {
  const id = options.id ?? 'test-model'
  const source = options.source ?? 'direct'
  return {
    catalogId: options.catalogId ?? (source === 'fcc' ? `fcc:test/${id}` : `test/${id}`),
    key: options.key ?? `direct:test:${id}`,
    source,
    provider: options.provider ?? 'test',
    upstreamModel: options.upstreamModel ?? id,
    label: options.label ?? id,
    wire: options.wire ?? 'openai',
    baseUrl,
    apiKey: options.apiKey ?? 'test-key',
    tier: options.tier ?? 'coding',
    tools: options.tools !== false,
    contextWindow: options.contextWindow ?? 131072,
    maxTokens: options.maxTokens ?? 4096,
    headers: options.headers ?? {},
  }
}

/**
 * Build a runner over the given candidates.
 * @param {object} options - runner options.
 * @param {object[]} options.candidates - candidates in catalog order.
 * @param {Record<string, unknown>} [options.config] - config overrides.
 * @returns {{runner: object, pool: CandidatePool, status: StatusRegistry, logger: object, config: object}} the wired parts.
 */
export function makeRunner({ candidates, config = {} }) {
  const resolved = resolveConfig({
    fcc: { enabled: false, autoStart: false },
    directProviders: { enabled: false },
    ttftTimeoutMs: 150,
    stallTimeoutMs: 150,
    requestTimeoutMs: 5000,
    maxFailovers: 4,
    ...config,
  })
  const logger = testLogger()
  const pool = new CandidatePool({ config: resolved, logger })
  pool.replace(candidates)
  const status = new StatusRegistry()
  const runner = createRunner({ config: resolved, pool, logger, status })
  return { runner, pool, status, logger, config: resolved }
}

/**
 * Collect every chunk of one stream.
 * @param {AsyncIterable<object>} stream - the chunk stream.
 * @returns {Promise<object[]>} the chunks.
 */
export async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * Concatenate the text deltas of one stream.
 * @param {object[]} chunks - chunks.
 * @returns {string} the visible text.
 */
export function textOf(chunks) {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

/**
 * The terminal finish chunk.
 * @param {object[]} chunks - chunks.
 * @returns {object | undefined} the finish chunk.
 */
export function finishOf(chunks) {
  return chunks.findLast(chunk => chunk.type === 'finish')
}

/** A minimal harness request with one user message. */
export function request(overrides = {}) {
  return {
    provider: 'freeclaudecode',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }],
    ...overrides,
  }
}
