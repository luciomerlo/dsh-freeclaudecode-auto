/**
 * Configuration, environment parsing, fcc model normalization, SSE framing,
 * and degeneracy detection.
 *
 * @module dsh-freeclaudecode-auto/test/parsing
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { profileOf, resolveConfig } from '../src/config.js'
import { configuredFccModels, normalizeFccModels, parseEnvText } from '../src/fcc.js'
import { isDegenerateResponse } from '../src/failure.js'
import { readSseFrames } from '../src/sse.js'
import { normalizeUsage, toOpenAiMessages } from '../src/wire/openai.js'
import { toAnthropicMessages } from '../src/wire/anthropic.js'

test('configuration defaults point at the local fcc proxy and ~/.fcc', () => {
  const config = resolveConfig({})
  assert.equal(config.providerId, 'freeclaudecode')
  assert.equal(config.autoModelName, 'Auto (FreeClaudeCode)')
  assert.equal(config.fcc.baseUrl, 'http://127.0.0.1:8082')
  assert.match(config.fcc.directory, /\.fcc$/u)
  assert.equal(config.ttftTimeoutMs, 8000)
  assert.equal(config.stallTimeoutMs, 12000)
})

test('configuration rejects a provider id the loader could not mount', () => {
  assert.throws(() => resolveConfig({ providerId: 'Bad Id' }), /invalid providerId/u)
})

test('a selected catalog id maps to its routing profile', () => {
  const config = resolveConfig({})
  assert.equal(profileOf('auto', config).profile, 'auto')
  assert.equal(profileOf('best', config).profile, 'best')
  assert.equal(profileOf('fast', config).profile, 'fast')
  const explicit = profileOf('fcc:groq/llama-3.3-70b-versatile', config)
  assert.equal(explicit.profile, 'explicit')
  assert.equal(explicit.explicitId, 'fcc:groq/llama-3.3-70b-versatile')
})

test('the fcc dotenv parser handles quotes, comments, and export', () => {
  const env = parseEnvText([
    '# comment',
    'MODEL=nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b',
    'export NVIDIA_NIM_API_KEY="nvapi-secret"',
    "GROQ_API_KEY='gsk-value'",
    'EMPTY=',
    'TRAILING=value # note',
  ].join('\n'))
  assert.equal(env.MODEL, 'nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b')
  assert.equal(env.NVIDIA_NIM_API_KEY, 'nvapi-secret')
  assert.equal(env.GROQ_API_KEY, 'gsk-value')
  assert.equal(env.EMPTY, '')
  assert.equal(env.TRAILING, 'value')
})

test('fcc model listings are normalized from every documented shape', () => {
  const fromData = normalizeFccModels({
    data: [
      { id: 'nvidia_nim/meta/llama-3.3-70b-instruct', display_name: 'Llama 3.3', context_window: 131072, supports_tools: true },
      { id: 'not-a-slug' },
      { id: 'groq/llama-3.3-70b-versatile' },
    ],
  })
  assert.deepEqual(fromData.map(model => model.id), ['nvidia_nim/meta/llama-3.3-70b-instruct', 'groq/llama-3.3-70b-versatile'])
  assert.equal(fromData[0].name, 'Llama 3.3')
  assert.equal(fromData[0].contextWindow, 131072)
  assert.equal(fromData[0].tools, true)

  const fromModels = normalizeFccModels({ models: [{ name: 'open_router/deepseek/deepseek-r1:free' }] })
  assert.equal(fromModels.length, 0, 'an entry without an id is skipped')

  const fromArray = normalizeFccModels([{ id: 'cerebras/gpt-oss-120b' }])
  assert.equal(fromArray[0].id, 'cerebras/gpt-oss-120b')
})

test('fcc configuration names preferred models, including fallbacks', () => {
  const slugs = configuredFccModels({
    MODEL: 'nvidia_nim/meta/llama-3.3-70b-instruct',
    MODEL_SONNET: 'groq/llama-3.3-70b-versatile',
    MODEL_FALLBACKS: 'cerebras/gpt-oss-120b:high, nvidia_nim/qwen/qwen3-coder-480b-a35b-instruct:off',
  })
  assert.deepEqual(slugs, [
    'groq/llama-3.3-70b-versatile',
    'nvidia_nim/meta/llama-3.3-70b-instruct',
    'cerebras/gpt-oss-120b',
    'nvidia_nim/qwen/qwen3-coder-480b-a35b-instruct',
  ])
})

test('degenerate quota notices are detected without flagging normal prose', () => {
  assert.equal(isDegenerateResponse('Rate limit exceeded. Please try again later.'), true)
  assert.equal(isDegenerateResponse('Insufficient credits for this request.'), true)
  assert.equal(isDegenerateResponse('Invalid API key provided.'), true)
  assert.equal(isDegenerateResponse('Here is how to handle a rate limit in your code:\n\n```js\nretry()\n```'), false)
  assert.equal(isDegenerateResponse('The build finished successfully.'), false)
})

test('SSE framing survives multi-line data, CRLF, comments, and a final frame', async () => {
  const text = ': keepalive\r\nevent: message\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: [DONE]\r\n\r\n'
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  const frames = []
  for await (const frame of readSseFrames(body, { onActivity: () => {} })) frames.push(frame)
  assert.equal(frames.length, 1, 'the DONE sentinel terminates the stream without being yielded')
  assert.equal(frames[0].data, '{"a":\n1}')
})

test('OpenAI usage counters are normalized', () => {
  const usage = normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 5 },
  })
  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 40,
    reasoningTokens: 5,
  })
})

test('OpenAI projection keeps tool calls and results correlated', () => {
  const messages = toOpenAiMessages([
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'hello' }] },
  ])
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[2].tool_calls[0].id, 'call_1')
  assert.equal(messages[2].content, 'Reading.')
  assert.equal(messages[3].role, 'tool')
  assert.equal(messages[3].tool_call_id, 'call_1')
})

test('Anthropic projection keeps tool results in a user turn and merges roles', () => {
  const { messages, system } = toAnthropicMessages([
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'hello' }] },
    { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'second' }] },
  ])
  assert.equal(system, 'be brief')
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].content[0].type, 'tool_use')
  assert.equal(messages[2].role, 'user')
  assert.equal(messages[2].content.length, 2, 'consecutive tool results share one user turn')
  assert.equal(messages[2].content[0].tool_use_id, 'call_1')
})
