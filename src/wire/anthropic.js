/**
 * Anthropic Messages wire: request projection and SSE translation.
 *
 * This is the native protocol of Free Claude Code's local proxy, so an fcc
 * candidate keeps the proxy's tool-calling, reasoning, and streaming behavior
 * instead of round-tripping through its OpenAI compatibility layer.
 *
 * @module dsh-freeclaudecode-auto/wire/anthropic
 */

import { ProviderFailure, CODES } from '../failure.js'
import { readSseFrames, jsonFrame } from '../sse.js'

/** Anthropic API version header value the proxy accepts. */
export const ANTHROPIC_VERSION = '2023-06-01'

/** Collect the plain text of one message's content blocks. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

/** Parse a tool-call argument payload into the object Anthropic expects. */
function toolInput(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Degraded history keeps the call identity instead of failing the turn.
    }
  }
  return {}
}

/**
 * Project harness messages onto Anthropic messages plus one system prompt.
 * @param {ReadonlyArray<Record<string, any>>} messages - harness request messages.
 * @returns {{messages: Array<Record<string, any>>, system: string}} the projection.
 */
export function toAnthropicMessages(messages) {
  const systemParts = []
  const out = []

  /** Append content blocks to the previous message when the role matches. */
  const push = (role, blocks) => {
    if (blocks.length === 0) return
    const previous = out.at(-1)
    if (previous !== undefined && previous.role === role) previous.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content)
      if (text.trim() !== '') systemParts.push(text)
      continue
    }

    if (message.role === 'assistant') {
      const blocks = []
      const text = textOf(message.content)
      if (text !== '') blocks.push({ type: 'text', text })
      for (const block of message.content) {
        if (block?.type !== 'tool-call' || typeof block.id !== 'string' || block.id === '') continue
        if (typeof block.name !== 'string' || block.name === '') continue
        blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) })
      }
      push('assistant', blocks)
      continue
    }

    if (message.role === 'tool') {
      const callId = typeof message.toolCallId === 'string'
        ? message.toolCallId
        : message.source?.kind === 'tool' ? message.source.callId : undefined
      if (callId === undefined) continue
      const text = textOf(message.content)
      push('user', [{
        type: 'tool_result',
        tool_use_id: callId,
        content: [{ type: 'text', text: text !== '' ? text : '(no output)' }],
        ...message.isError === true ? { is_error: true } : {},
      }])
      continue
    }

    const text = textOf(message.content)
    if (text !== '') push('user', [{ type: 'text', text }])
  }

  return { messages: out, system: systemParts.join('\n\n') }
}

/**
 * Build an Anthropic Messages request body.
 *
 * @param {object} options - harness generate options.
 * @param {object} candidate - the candidate being called.
 * @param {object} [extras] - request-shape controls.
 * @param {string} [extras.continuationText] - partial assistant text used as a prefill.
 * @returns {Record<string, unknown>} the request body.
 */
export function buildBody(options, candidate, extras = {}) {
  const { messages, system } = toAnthropicMessages(options.messages ?? [])
  const systemText = [system, typeof options.system === 'string' ? options.system : ''].filter(part => part.trim() !== '').join('\n\n')

  if (typeof extras.continuationText === 'string' && extras.continuationText !== '') {
    const previous = messages.at(-1)
    if (previous !== undefined && previous.role === 'assistant') {
      previous.content.push({ type: 'text', text: extras.continuationText })
    } else {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: extras.continuationText }] })
    }
  }

  const body = {
    model: candidate.upstreamModel,
    max_tokens: options.maxTokens ?? candidate.maxTokens ?? 4096,
    messages,
    stream: true,
  }
  if (systemText !== '') body.system = systemText
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop_sequences = options.stop
  return body
}

/**
 * Build the HTTP request description for one Anthropic attempt.
 * @param {object} options - harness generate options.
 * @param {object} candidate - the candidate.
 * @param {object} [extras] - request-shape controls.
 * @returns {{url: string, headers: Record<string, string>, body: Record<string, unknown>}} the request.
 */
export function buildRequest(options, candidate, extras = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': ANTHROPIC_VERSION,
    ...candidate.headers,
  }
  if (typeof candidate.apiKey === 'string' && candidate.apiKey !== '') {
    headers['x-api-key'] = candidate.apiKey
    headers.authorization = `Bearer ${candidate.apiKey}`
  }
  return {
    url: `${candidate.baseUrl}/v1/messages`,
    headers,
    body: buildBody(options, candidate, extras),
  }
}

/**
 * Translate one Anthropic Messages SSE body into wire events.
 *
 * @param {ReadableStream<Uint8Array>} body - response body.
 * @param {object} context - attempt context.
 * @param {AbortSignal} context.signal - cancellation.
 * @param {() => void} [context.onActivity] - watchdog pulse.
 * @param {string} [context.provider] - provider id for diagnostics.
 * @param {string} [context.model] - model id for diagnostics.
 * @returns {AsyncGenerator<Record<string, any>>} wire events.
 */
export async function* parseResponse(body, context) {
  let started = false
  let stopped = false
  let stopReason = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let sawToolCall = false
  /** @type {Map<number, {id: string, name: string, json: string}>} */
  const toolBlocks = new Map()
  /** @type {{message: string, code: string} | undefined} */
  let error

  for await (const frame of readSseFrames(body, { signal: context.signal, onActivity: context.onActivity })) {
    if (frame.data === '[DONE]') continue
    const event = jsonFrame(frame)
    const type = typeof event.type === 'string' ? event.type : frame.event

    if (!started) {
      started = true
      yield { type: 'start' }
    }

    if (type === 'error') {
      const detail = event.error
      error = {
        message: detail !== null && typeof detail === 'object' && typeof detail.message === 'string'
          ? detail.message
          : 'the provider reported an error mid-stream',
        code: detail !== null && typeof detail === 'object' && typeof detail.type === 'string' ? detail.type : CODES.SERVER,
      }
      break
    }
    if (type === 'ping') continue

    if (type === 'message_start') {
      const usage = event.message?.usage
      if (usage !== null && typeof usage === 'object') {
        inputTokens = Number(usage.input_tokens ?? 0) || 0
        cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0) || 0
      }
      continue
    }

    if (type === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0
      const block = event.content_block ?? {}
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolBlocks.set(index, { id: block.id, name: block.name, json: '' })
        if (block.input !== null && typeof block.input === 'object' && Object.keys(block.input).length > 0) {
          toolBlocks.get(index).json = JSON.stringify(block.input)
        }
      }
      continue
    }

    if (type === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0
      const delta = event.delta ?? {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
        yield { type: 'text-delta', text: delta.text }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
        yield { type: 'reasoning-delta', text: delta.thinking }
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const slot = toolBlocks.get(index)
        if (slot !== undefined) slot.json += delta.partial_json
      }
      continue
    }

    if (type === 'content_block_stop') {
      const index = typeof event.index === 'number' ? event.index : 0
      const slot = toolBlocks.get(index)
      if (slot !== undefined) {
        toolBlocks.delete(index)
        sawToolCall = true
        yield {
          type: 'tool-call',
          id: slot.id,
          name: slot.name,
          arguments: slot.json.trim() === '' ? '{}' : slot.json,
        }
      }
      continue
    }

    if (type === 'message_delta') {
      if (typeof event.delta?.stop_reason === 'string' && event.delta.stop_reason !== '') stopReason = event.delta.stop_reason
      if (event.usage !== null && typeof event.usage === 'object') {
        outputTokens = Number(event.usage.output_tokens ?? outputTokens) || outputTokens
      }
      continue
    }

    if (type === 'message_stop') {
      stopped = true
      break
    }
  }

  if (error !== undefined) {
    throw new ProviderFailure({
      message: `${context.provider ?? 'provider'}/${context.model ?? 'model'}: ${error.message}`,
      code: error.code,
      provider: context.provider,
      model: context.model,
    })
  }

  if (!stopped) {
    throw new ProviderFailure({
      message: `${context.provider ?? 'provider'}/${context.model ?? 'model'}: the stream closed before message_stop`,
      code: CODES.STREAM_CLOSED,
      provider: context.provider,
      model: context.model,
    })
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...cacheReadTokens > 0 ? { cacheReadTokens } : {},
      },
    }
  }

  yield { type: 'end', finish: stopReason === '' ? 'end_turn' : stopReason, sawToolCalls: sawToolCall || toolBlocks.size > 0 }
}
