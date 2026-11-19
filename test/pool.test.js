/**
 * Pool ranking, circuit-breaker timing, and plan construction.
 *
 * @module dsh-freeclaudecode-auto/test/pool
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { CandidatePool, RETIRED_MS } from '../src/pool.js'

/** Build a candidate for pool tests. */
function candidate(id, overrides = {}) {
  return {
    catalogId: `test/${id}`,
    key: `direct:test:${id}`,
    source: 'direct',
    provider: 'test',
    upstreamModel: id,
    label: id,
    wire: 'openai',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'key',
    tier: 'coding',
    tools: true,
    contextWindow: 131072,
    maxTokens: 4096,
    headers: {},
    ...overrides,
  }
}

/** Build a pool with an injectable clock. */
function makePool(candidates, configInput = {}) {
  let clock = 1_000_000
  const config = resolveConfig({
    fcc: { enabled: false, autoStart: false },
    directProviders: { enabled: false },
    ...configInput,
  })
  const pool = new CandidatePool({ config, now: () => clock })
  pool.replace(candidates)
  return { pool, advance: (ms) => { clock += ms }, config }
}

test('the best profile ranks coding models above fast ones', () => {
  const { pool } = makePool([
    candidate('fast-model', { tier: 'fast' }),
    candidate('coding-model', { tier: 'coding' }),
    candidate('general-model', { tier: 'general' }),
  ])
  const plan = pool.plan({ profile: 'best', options: { model: 'best', messages: [] } })
  assert.deepEqual(plan.map(entry => entry.upstreamModel), ['coding-model', 'general-model', 'fast-model'])
})

test('the fast profile ranks fast models above coding ones', () => {
  const { pool } = makePool([
    candidate('coding-model', { tier: 'coding' }),
    candidate('fast-model', { tier: 'fast' }),
  ])
  const plan = pool.plan({ profile: 'fast', options: { model: 'fast', messages: [] } })
  assert.deepEqual(plan.map(entry => entry.upstreamModel), ['fast-model', 'coding-model'])
})

test('a rate-limited candidate backs off 30s, then 2m, then 10m', () => {
  const { pool, advance } = makePool([candidate('a')])
  const target = pool.list()[0]
  const facts = { status: 429, code: 'RATE_LIMIT', message: 'rate limit exceeded' }

  assert.equal(pool.recordFailure(target, facts).cooldownMs, 30_000)
  assert.ok(pool.blockedReason(target, 1_000_000, false)?.includes('cooling down'))

  advance(30_000)
  assert.equal(pool.blockedReason(target, 1_030_000, false), undefined)
  assert.equal(pool.recordFailure(target, facts).cooldownMs, 60_000)

  advance(60_000)
  assert.equal(pool.recordFailure(target, facts).cooldownMs, 120_000)

  advance(120_000)
  assert.equal(pool.recordFailure(target, facts).cooldownMs, 240_000)
})

test('a provider-retry-after delay is honored within the cap', () => {
  const { pool } = makePool([candidate('a')])
  const result = pool.recordFailure(pool.list()[0], {
    status: 429,
    code: 'RATE_LIMIT',
    message: 'slow down',
    providerRetryAfterMs: 5000,
  })
  assert.equal(result.cooldownMs, 5000)
})

test('an authentication failure retires the candidate for six hours', () => {
  const { pool } = makePool([candidate('a')])
  const target = pool.list()[0]
  const result = pool.recordFailure(target, { status: 401, code: 'AUTH', message: 'invalid api key' })
  assert.equal(result.reaction, 'auth')
  assert.equal(result.cooldownMs, RETIRED_MS)
  assert.ok(pool.blockedReason(target, 1_000_000, false)?.includes('retired'))
})

test('a context overflow does not penalize the candidate', () => {
  const { pool } = makePool([candidate('a')])
  const target = pool.list()[0]
  const result = pool.recordFailure(target, {
    status: 400,
    code: 'INVALID_REQUEST',
    message: 'maximum context length exceeded',
  })
  assert.equal(result.reaction, 'context')
  assert.equal(result.cooldownMs, 0)
  assert.equal(pool.blockedReason(target, 1_000_000, false), undefined)
})

test('a tool rejection keeps the candidate for plain chat but not for tools', () => {
  const { pool } = makePool([candidate('a')])
  const target = pool.list()[0]
  const result = pool.recordFailure(target, {
    status: 400,
    code: 'INVALID_REQUEST',
    message: 'tools are not supported by this model',
  })
  assert.equal(result.reaction, 'tool')
  assert.ok(pool.blockedReason(target, 1_000_000, true)?.includes('tool'))
})

test('a candidate without verified tool calling is skipped when tools are declared', () => {
  const { pool } = makePool([candidate('no-tools', { tools: false }), candidate('tools')])
  const plan = pool.plan({ profile: 'auto', options: { model: 'auto', messages: [], tools: [{ name: 'x' }] } })
  assert.deepEqual(plan.map(entry => entry.upstreamModel), ['tools'])
})

test('a fully cooling pool still attempts the least-cool candidate', () => {
  const { pool } = makePool([candidate('a'), candidate('b')], { maxFailovers: 2 })
  for (const target of pool.list()) {
    pool.recordFailure(target, { status: 500, code: 'SERVER', message: 'boom' })
  }
  const plan = pool.plan({ profile: 'auto', options: { model: 'auto', messages: [] } })
  assert.equal(plan.length, 1, 'the pool never gives up while a candidate could recover')
})

test('the explicit selection is attempted first, then the ranked fallbacks', () => {
  const { pool } = makePool([
    candidate('fast-model', { tier: 'fast' }),
    candidate('coding-model', { tier: 'coding' }),
  ])
  const plan = pool.plan({
    profile: 'explicit',
    explicitId: 'test/fast-model',
    options: { model: 'test/fast-model', messages: [] },
  })
  assert.equal(plan[0].upstreamModel, 'fast-model')
  assert.ok(plan.some(entry => entry.upstreamModel === 'coding-model'))
})

test('preferredOrder overrides the tier score', () => {
  const { pool } = makePool(
    [candidate('coding-model'), candidate('general-model', { tier: 'general' })],
    { preferredOrder: ['test/general-model'] },
  )
  const plan = pool.plan({ profile: 'auto', options: { model: 'auto', messages: [] } })
  assert.equal(plan[0].upstreamModel, 'general-model')
})

test('disabledModels keeps a model out of the plan', () => {
  const { pool } = makePool([candidate('a'), candidate('b')], { disabledModels: ['test/a'] })
  const plan = pool.plan({ profile: 'auto', options: { model: 'auto', messages: [] } })
  assert.deepEqual(plan.map(entry => entry.upstreamModel), ['b'])
})

test('a candidate without a credential is never planned', () => {
  const { pool } = makePool([candidate('keyless', { apiKey: '' })])
  const plan = pool.plan({ profile: 'auto', options: { model: 'auto', messages: [] } })
  assert.equal(plan.length, 0)
})

test('success resets the failure streak and improves the success estimate', () => {
  const { pool } = makePool([candidate('a')])
  const target = pool.list()[0]
  pool.recordFailure(target, { status: 500, code: 'SERVER', message: 'boom' })
  pool.recordSuccess(target, { ttftMs: 200 })
  const snapshot = pool.snapshot()
  assert.equal(snapshot.candidates[0].successes, 1)
  assert.equal(snapshot.candidates[0].successRate, 0.5)
  assert.equal(snapshot.candidates[0].cooldownMs, 0)
})
