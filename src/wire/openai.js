/**
 * OpenAI Chat Completions wire: request projection and SSE translation.
 *
 * This is the common denominator of every free provider the router can reach
 * directly (NVIDIA NIM, Groq, Cerebras, OpenRouter, Mistral, DeepSeek, and any
 * custom OpenAI-compatible gateway).
 *
 * @module dsh-freeclaudecode-auto/wire/openai
 */

import { ProviderFailure, CODES } from '../failure.js'
import { readSseFrames, jsonFrame } from '../sse.js'
import { openStream } from './http.js'

/** Instruction appended when a cut-off response must continue on another model. */
const CONTINUATION_INSTRUCTION = 'The previous assistant reply was interrupted mid-stream. Continue it from the exact point where it stopped. Do not repeat text that was already produced, do not apologize, and do not add a preamble. Continue with the same formatting and finish the task.'

/** Collect the plain text of one message's content blocks. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

/** Parse a tool-call argument payload; historical malformed JSON becomes `{}`. */
function toolArguments(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // A degraded historical call keeps its identity instead of failing the turn.
    }
  }
  return {}
}

/** Read the call id a tool-role message answers. */
function toolCallId(message) {
  if (typeof message.toolCallId === 'string' && message.toolCallId !== '') return message.toolCallId
  const source = message.source
  return source !== null && typeof source === 'object' && source.kind === 'tool' && typeof source.callId === 'string'
    ? source.callId
    : undefined
}

/**
 * Project harness messages onto OpenAI chat messages.
 * @param {ReadonlyArray<Record<string, any>>} messages - harness request messages.
 * @returns {Array<Record<string, unknown>>} OpenAI-shaped messages.
 */
export function toOpenAiMessages(messages) {
  const out = []
  for (const message of messages) {
    if (message.role === 'developer') {
      const text = textOf(message.content)
      if (text.trim() !== '') out.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text.trim() !== '') out.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      const calls = message.content
        .filter(block => block?.type === 'tool-call' && typeof block.id === 'string' && block.id !== '' && typeof block.name === 'string' && block.name !== '')
        .map(block => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(toolArguments(block.arguments)) },
        }))
      const entry = { role: 'assistant', content: text !== '' ? text : calls.length > 0 ? null : '' }
      if (calls.length > 0) entry.tool_calls = calls
      out.push(entry)
      continue
    }
    const callId = toolCallId(message)
    if (callId !== undefined) {
      const text = textOf(message.content)
      out.push({ role: 'tool', tool_call_id: callId, content: text !== '' ? text : '(no output)' })
      continue
    }
    const text = textOf(message.content)
    out.push({ role: 'user', content: text })
  }
  return out
}

/**
 * Build a chat-completions request body.
 *
 * @param {object} options - harness generate options.
 * @param {object} candidate - the candidate being called.
 * @param {object} [extras] - request-shape controls.
 * @param {string} [extras.continuationText] - partial assistant text to continue.
 * @param {boolean} [extras.simplified] - drop optional fields a gateway rejected.
 * @returns {Record<string, unknown>} the request body.
 */
export function buildBody(options, candidate, extras = {}) {
  const messages = toOpenAiMessages(options.messages ?? [])
  const system = typeof options.system === 'string' && options.system !== '' ? options.system : undefined
  if (!messages.some(message => message.role === 'system') && system !== undefined) {
    messages.unshift({ role: 'system', content: system })
  }

  if (typeof extras.continuationText === 'string' && extras.continuationText !== '') {
    messages.push({ role: 'assistant', content: extras.continuationText })
    messages.push({ role: 'user', content: CONTINUATION_INSTRUCTION })
  }

  const body = {
    model: candidate.upstreamModel,
    messages,
    stream: true,
  }
  if (extras.simplified !== true) body.stream_options = { include_usage: true }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') body.reasoning_effort = options.reasoningEffort
  return body
}

/**
 * Build the HTTP request description for one attempt.
 * @param {object} options - harness generate options.
 * @param {object} candidate - the candidate.
 * @param {object} [extras] - request-shape controls.
 * @returns {{url: string, headers: Record<string, string>, body: Record<string, unknown>}} the request.
 */
export function buildRequest(options, candidate, extras = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...candidate.headers,
  }
  if (typeof candidate.apiKey === 'string' && candidate.apiKey !== '') {
    headers.authorization = `Bearer ${candidate.apiKey}`
  }
  return {
    url: `${candidate.baseUrl}/chat/completions`,
    headers,
    body: buildBody(options, candidate, extras),
  }
}

/**
 * Translate one chat-completions SSE body into wire events.
 *
 * Events are `{type:'start'}`, `{type:'text-delta', text}`,
 * `{type:'reasoning-delta', text}`, `{type:'tool-call', id, name, arguments}`,
 * `{type:'usage', usage}`, and one terminal `{type:'end', finish}`.
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
  let finish = ''
  let usage
  /** @type {Map<number, {id: string, name: string, arguments: string}>} */
  const calls = new Map()
  /** @type {{message: string, code: string} | undefined} */
  let error

  for await (const frame of readSseFrames(body, { signal: context.signal, onActivity: context.onActivity })) {
    if (frame.data === '[DONE]') continue
    const chunk = jsonFrame(frame)

    if (chunk.error !== null && typeof chunk.error === 'object') {
      const detail = chunk.error
      error = {
        message: typeof detail.message === 'string' ? detail.message : 'the provider reported an error mid-stream',
        code: typeof detail.code === 'string' ? detail.code : CODES.SERVER,
      }
      break
    }

    if (!started) {
      started = true
      yield { type: 'start' }
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
    const delta = choice?.delta ?? {}

    const reasoning = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : ''
    if (reasoning !== '') yield { type: 'reasoning-delta', text: reasoning }

    const text = typeof delta.content === 'string' ? delta.content : ''
    if (text !== '') yield { type: 'text-delta', text }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call?.index === 'number' ? call.index : 0
        const slot = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (typeof call?.id === 'string' && call.id !== '') slot.id = call.id
        if (typeof call?.function?.name === 'string' && call.function.name !== '') slot.name = call.function.name
        if (typeof call?.function?.arguments === 'string') slot.arguments += call.function.arguments
        calls.set(index, slot)
      }
    }

    if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') finish = choice.finish_reason
    if (chunk.usage !== null && typeof chunk.usage === 'object') usage = normalizeUsage(chunk.usage)
  }

  if (error !== undefined) {
    throw new ProviderFailure({
      message: `${context.provider ?? 'provider'}/${context.model ?? 'model'}: ${error.message}`,
      code: error.code,
      provider: context.provider,
      model: context.model,
    })
  }

  for (const [index, slot] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (slot.name.trim() === '') {
      throw new ProviderFailure({
        message: `${context.provider ?? 'provider'}/${context.model ?? 'model'}: the model returned an unnamed tool call`,
        code: CODES.MALFORMED_RESPONSE,
        provider: context.provider,
        model: context.model,
      })
    }
    if (slot.arguments.trim() !== '') {
      try {
        JSON.parse(slot.arguments)
      } catch {
        throw new ProviderFailure({
          message: `${context.provider ?? 'provider'}/${context.model ?? 'model'}: the model returned truncated tool-call JSON`,
          code: CODES.MALFORMED_RESPONSE,
          provider: context.provider,
          model: context.model,
        })
      }
    }
    yield {
      type: 'tool-call',
      id: slot.id !== '' ? slot.id : `call_${String(index)}_${Date.now().toString(36)}`,
      name: slot.name,
      arguments: slot.arguments.trim() === '' ? '{}' : slot.arguments,
    }
  }

  if (usage !== undefined) yield { type: 'usage', usage }
  if (finish === '' && calls.size === 0) {
    throw new ProviderFailure({
      message: `${context.provider ?? 'provider'}/${context.model ?? 'model'}: the stream ended without a finish reason`,
      code: CODES.STREAM_CLOSED,
      provider: context.provider,
      model: context.model,
    })
  }
  yield { type: 'end', finish: finish === '' ? 'stop' : finish, sawToolCalls: calls.size > 0 }
}

/**
 * Normalize OpenAI usage counters into the harness shape.
 * @param {Record<string, any>} usage - provider usage object.
 * @returns {{inputTokens: number, outputTokens: number, totalTokens?: number, cacheReadTokens?: number, reasoningTokens?: number}} harness usage.
 */
export function normalizeUsage(usage) {
  const input = Number(usage.prompt_tokens ?? 0)
  const output = Number(usage.completion_tokens ?? 0)
  const result = {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
  }
  const total = Number(usage.total_tokens)
  if (Number.isFinite(total) && total > 0) result.totalTokens = total
  const cached = Number(usage.prompt_tokens_details?.cached_tokens)
  if (Number.isFinite(cached) && cached > 0) result.cacheReadTokens = cached
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens)
  if (Number.isFinite(reasoning) && reasoning > 0) result.reasoningTokens = reasoning
  return result
}

export { openStream }
