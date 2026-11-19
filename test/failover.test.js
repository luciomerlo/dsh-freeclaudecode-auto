/**
 * Zero-drop failover behavior against real local HTTP servers.
 *
 * Every case exercises the full path: HTTP fetch, SSE decoding, wire
 * translation, the watchdogs, the circuit breaker, block assembly, and the
 * terminal finish chunk.
 *
 * @module dsh-freeclaudecode-auto/test/failover
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CODES } from '../src/failure.js'
import {
  anthropicAnswer,
  candidateAt,
  collect,
  finishOf,
  makeRunner,
  openAiAnswer,
  openAiFinish,
  openAiText,
  request,
  sse,
  sseHead,
  startServer,
  textOf,
} from './helpers.js'

/** Every block-start must be closed, exactly once, by block-end. */
function assertBalancedBlocks(chunks) {
  const open = new Set()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      assert.equal(open.has(chunk.index), false, `block ${String(chunk.index)} started twice`)
      open.add(chunk.index)
    }
    if (chunk.type === 'block-end') {
      assert.equal(open.has(chunk.index), true, `block ${String(chunk.index)} ended without start`)
      open.delete(chunk.index)
    }
  }
  assert.equal(open.size, 0, `unclosed blocks: ${[...open].join(',')}`)
}

test('an HTTP 429 switches models and cools the failed one down', async () => {
  const limited = await startServer(({ res }) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded for this model' } }))
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, 'hello from the second model'))
  try {
    const first = candidateAt(limited.baseUrl, { id: 'limited' })
    const second = candidateAt(healthy.baseUrl, { id: 'healthy' })
    const { runner, pool } = makeRunner({ candidates: [first, second] })

    const chunks = await collect(runner.stream(request({ model: first.catalogId })))
    assert.equal(textOf(chunks), 'hello from the second model')
    assert.equal(finishOf(chunks).reason.kind, 'stop')
    assertBalancedBlocks(chunks)
    assert.equal(healthy.requests.length, 1)

    const snapshot = pool.snapshot()
    const blocked = snapshot.candidates.find(entry => entry.catalogId === first.catalogId)
    assert.ok(blocked.cooldownMs > 0, 'the rate-limited candidate is cooling down')
  } finally {
    await limited.close()
    await healthy.close()
  }
})

test('a 503 server error fails over', async () => {
  const broken = await startServer(({ res }) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'service unavailable' } }))
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, 'recovered'))
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(broken.baseUrl, { id: 'broken' }), candidateAt(healthy.baseUrl, { id: 'ok' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/broken' })))
    assert.equal(textOf(chunks), 'recovered')
    assert.equal(finishOf(chunks).reason.kind, 'stop')
  } finally {
    await broken.close()
    await healthy.close()
  }
})

test('a 401 retires the provider for six hours', async () => {
  const unauthorized = await startServer(({ res }) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, 'ok'))
  try {
    const { runner, pool } = makeRunner({
      candidates: [candidateAt(unauthorized.baseUrl, { id: 'bad-key' }), candidateAt(healthy.baseUrl, { id: 'good' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/bad-key' })))
    assert.equal(textOf(chunks), 'ok')
    const snapshot = pool.snapshot()
    const retired = snapshot.candidates.find(entry => entry.catalogId === 'test/bad-key')
    assert.ok(retired.retiredMs > 5 * 60 * 60 * 1000, 'an auth failure retires the candidate')
    assert.equal(snapshot.retired, 1)
  } finally {
    await unauthorized.close()
    await healthy.close()
  }
})

test('a model that never sends its first byte is abandoned at the TTFT deadline', async () => {
  const silent = await startServer(({ res }) => {
    sseHead(res)
    // Headers, then nothing: the client must abort and move on.
    res.on('close', () => {})
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, 'fast enough'))
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(silent.baseUrl, { id: 'silent' }), candidateAt(healthy.baseUrl, { id: 'quick' })],
    })
    const startedAt = Date.now()
    const chunks = await collect(runner.stream(request({ model: 'test/silent' })))
    assert.equal(textOf(chunks), 'fast enough')
    assert.ok(Date.now() - startedAt < 3000, 'the turn did not hang on the silent model')
    assertBalancedBlocks(chunks)
  } finally {
    await silent.close()
    await healthy.close()
  }
})

test('a stalled stream continues the visible text on the next model', async () => {
  const partial = 'x'.repeat(200)
  const stalling = await startServer(({ res }) => {
    sseHead(res)
    openAiText(res, partial)
    // Stall without a finish: the client aborts and continues elsewhere.
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, ' continued'))
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(stalling.baseUrl, { id: 'stalling' }), candidateAt(healthy.baseUrl, { id: 'resuming' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/stalling' })))
    assert.equal(textOf(chunks), `${partial} continued`)
    assert.equal(finishOf(chunks).reason.kind, 'stop')
    assertBalancedBlocks(chunks)
    const textBlocks = chunks.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'text')
    assert.equal(textBlocks.length, 1, 'the continuation appends to the same text block')

    const continuation = healthy.requests.at(-1).body
    const assistant = continuation.messages.find(message => message.role === 'assistant')
    assert.ok(assistant, 'the replacement received the partial assistant turn')
    assert.equal(assistant.content, partial)
    const instruction = continuation.messages.at(-1)
    assert.equal(instruction.role, 'user')
    assert.match(instruction.content, /Continue it from the exact point where it stopped/u)
  } finally {
    await stalling.close()
    await healthy.close()
  }
})

test('a stream that closes without a finish reason is treated as a cut', async () => {
  const cutting = await startServer(({ res }) => {
    sseHead(res)
    openAiText(res, 'y'.repeat(200))
    res.end()
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, 'tail'))
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(cutting.baseUrl, { id: 'cut' }), candidateAt(healthy.baseUrl, { id: 'whole' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/cut' })))
    assert.equal(textOf(chunks), `${'y'.repeat(200)}tail`)
    assert.equal(finishOf(chunks).reason.kind, 'stop')
  } finally {
    await cutting.close()
    await healthy.close()
  }
})

test('a quota notice delivered with HTTP 200 is not surfaced as an answer', async () => {
  const notice = await startServer(({ res }) => openAiAnswer(res, 'Rate limit exceeded. Please try again later.'))
  const healthy = await startServer(({ res }) => openAiAnswer(res, 'the real answer'))
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(notice.baseUrl, { id: 'notice' }), candidateAt(healthy.baseUrl, { id: 'real' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/notice' })))
    assert.equal(textOf(chunks), 'the real answer')
  } finally {
    await notice.close()
    await healthy.close()
  }
})

test('truncated tool-call JSON fails over to a model that returns a valid call', async () => {
  const broken = await startServer(({ res }) => {
    sseHead(res)
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] })
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    sse(res, '[DONE]')
    res.end()
  })
  const healthy = await startServer(({ res }) => {
    sseHead(res)
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] })
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    sse(res, '[DONE]')
    res.end()
  })
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(broken.baseUrl, { id: 'broken-tools' }), candidateAt(healthy.baseUrl, { id: 'good-tools' })],
    })
    const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
    const chunks = await collect(runner.stream(request({ model: 'test/broken-tools', tools })))
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.ok(call, 'a complete tool call was emitted')
    assert.deepEqual(JSON.parse(call.block.arguments), { path: 'a.txt' })
    assert.equal(finishOf(chunks).reason.kind, 'tool-calls')
    assert.equal(healthy.requests.at(-1).body.tools.length, 1)
  } finally {
    await broken.close()
    await healthy.close()
  }
})

test('an empty 200 response fails over', async () => {
  const empty = await startServer(({ res }) => {
    sseHead(res)
    openAiFinish(res, 'stop')
    res.end()
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, 'content'))
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(empty.baseUrl, { id: 'empty' }), candidateAt(healthy.baseUrl, { id: 'full' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/empty' })))
    assert.equal(textOf(chunks), 'content')
  } finally {
    await empty.close()
    await healthy.close()
  }
})

test('an exhausted plan ends with one error finish that names the last failure', async () => {
  const down = await startServer(({ res }) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'boom' } }))
  })
  const limited = await startServer(({ res }) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'slow down' } }))
  })
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(down.baseUrl, { id: 'down' }), candidateAt(limited.baseUrl, { id: 'limited' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/down' })))
    const finishes = chunks.filter(chunk => chunk.type === 'finish')
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].reason.kind, 'error')
    assert.equal(finishes[0].reason.failure.code, CODES.RATE_LIMIT)
    assert.match(finishes[0].reason.failure.message, /exhausted every free model/u)
  } finally {
    await down.close()
    await limited.close()
  }
})

test('a context-window rejection is not failed over', async () => {
  const tooBig = await startServer(({ res }) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'maximum context length exceeded for this model' } }))
  })
  const untouched = await startServer(({ res }) => openAiAnswer(res, 'should not be called'))
  try {
    const { runner } = makeRunner({
      candidates: [candidateAt(tooBig.baseUrl, { id: 'small' }), candidateAt(untouched.baseUrl, { id: 'other' })],
    })
    const chunks = await collect(runner.stream(request({ model: 'test/small' })))
    const finish = finishOf(chunks)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, CODES.INVALID_REQUEST)
    assert.equal(untouched.requests.length, 0, 'the harness owns compaction, so no other model was tried')
  } finally {
    await tooBig.close()
    await untouched.close()
  }
})

test('a continuation-only rejection does not cool the model down', async () => {
  const partial = 'w'.repeat(200)
  const stalling = await startServer(({ res }) => {
    sseHead(res)
    openAiText(res, partial)
  })
  const prefillRejecting = await startServer(({ res }) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid request' } }))
  })
  const healthy = await startServer(({ res }) => openAiAnswer(res, ' tail'))
  try {
    const first = candidateAt(stalling.baseUrl, { id: 'stall' })
    const rejecting = candidateAt(prefillRejecting.baseUrl, { id: 'no-prefill', wire: 'anthropic', source: 'fcc', catalogId: 'fcc:test/no-prefill' })
    const last = candidateAt(healthy.baseUrl, { id: 'tail' })
    const { runner, pool } = makeRunner({ candidates: [first, rejecting, last] })
    const chunks = await collect(runner.stream(request({ model: first.catalogId })))
    assert.equal(textOf(chunks), `${partial} tail`)
    assert.equal(finishOf(chunks).reason.kind, 'stop')
    const snapshot = pool.snapshot()
    const cooled = snapshot.candidates.find(entry => entry.catalogId === rejecting.catalogId)
    assert.equal(cooled.cooldownMs, 0, 'the prefill rejection is not the model\'s fault')
    assert.equal(cooled.retiredMs, 0)
  } finally {
    await stalling.close()
    await prefillRejecting.close()
    await healthy.close()
  }
})

test('an Anthropic wire candidate streams text, usage, and a finish', async () => {
  const fcc = await startServer(({ res }) => anthropicAnswer(res, 'from the fcc proxy'))
  try {
    const candidate = candidateAt(fcc.baseUrl, { id: 'proxy', wire: 'anthropic', source: 'fcc', catalogId: 'fcc:test/proxy' })
    const { runner } = makeRunner({ candidates: [candidate] })
    const chunks = await collect(runner.stream(request({ model: 'fcc:test/proxy' })))
    assert.equal(textOf(chunks), 'from the fcc proxy')
    assert.equal(finishOf(chunks).reason.kind, 'stop')
    const usage = chunks.find(chunk => chunk.type === 'usage')
    assert.equal(usage.usage.inputTokens, 12)
    assert.equal(usage.usage.outputTokens, 7)
    const sent = fcc.requests.at(-1)
    assert.equal(sent.url, '/v1/messages')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
  } finally {
    await fcc.close()
  }
})

test('Anthropic continuation uses an assistant prefill instead of a second user turn', async () => {
  const partial = 'z'.repeat(200)
  const stalling = await startServer(({ res }) => {
    sseHead(res)
    sse(res, { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 3 } } })
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partial } })
    // Stall before message_stop.
  })
  const healthy = await startServer(({ res }) => {
    sseHead(res)
    sse(res, { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 3 } } })
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' finished' } })
    sse(res, { type: 'content_block_stop', index: 0 })
    sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    sse(res, { type: 'message_stop' })
    res.end()
  })
  try {
    const first = candidateAt(stalling.baseUrl, { id: 'one', wire: 'anthropic', source: 'fcc', catalogId: 'fcc:test/one' })
    const second = candidateAt(healthy.baseUrl, { id: 'two', wire: 'anthropic', source: 'fcc', catalogId: 'fcc:test/two' })
    const { runner } = makeRunner({ candidates: [first, second] })
    const chunks = await collect(runner.stream(request({ model: 'fcc:test/one' })))
    assert.equal(textOf(chunks), `${partial} finished`)
    const body = healthy.requests.at(-1).body
    assert.equal(body.messages.at(-1).role, 'assistant')
    assert.equal(body.messages.at(-1).content.at(-1).text, partial)
  } finally {
    await stalling.close()
    await healthy.close()
  }
})
