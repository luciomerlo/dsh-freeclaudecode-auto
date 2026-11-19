/**
 * Adapter contract and host mounting.
 *
 * @module dsh-freeclaudecode-auto/test/plugin
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, STATUS_ROUTE } from '../index.js'
import { createAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { CandidatePool } from '../src/pool.js'
import { StatusRegistry } from '../src/status.js'

/** One candidate for adapter tests. */
function candidate() {
  return {
    catalogId: 'fcc:groq/llama-3.3-70b-versatile',
    key: 'fcc:groq/llama-3.3-70b-versatile',
    source: 'fcc',
    provider: 'groq',
    upstreamModel: 'groq/llama-3.3-70b-versatile',
    label: 'Groq: llama-3.3-70b-versatile',
    wire: 'anthropic',
    baseUrl: 'http://127.0.0.1:8082',
    apiKey: '',
    tier: 'coding',
    tools: true,
    contextWindow: 131072,
    maxTokens: 8192,
    headers: {},
  }
}

/** Build a fake context that records registrations. */
function fakeContext({ tools, webServer } = {}) {
  const registrations = []
  const cleanups = []
  return {
    registrations,
    cleanups,
    logger: { info() {}, warn() {}, debug() {} },
    llm: {
      registerAdapter(providers, adapter) {
        registrations.push({ providers, adapter })
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    emit() {},
    get(name) {
      if (name === 'tools') return tools
      if (name === 'webServer') return webServer
      return undefined
    },
  }
}

test('the adapter advertises the three routing modes plus discovered models', async () => {
  const config = resolveConfig({ fcc: { enabled: false }, directProviders: { enabled: false } })
  const pool = new CandidatePool({ config })
  pool.replace([candidate()])
  const status = new StatusRegistry()
  const fcc = { snapshot: () => ({ available: true }) }
  const adapter = createAdapter({
    config,
    pool,
    runner: { stream: async function* () {} },
    status,
    fcc,
    version: '1.0.0',
  })

  assert.deepEqual(adapter.providerInfo('freeclaudecode'), { id: 'freeclaudecode', name: 'FreeClaudeCode' })
  const models = await adapter.listModels('freeclaudecode')
  assert.deepEqual(models.slice(0, 3).map(model => model.id), ['auto', 'best', 'fast'])
  assert.equal(models[0].name, 'Auto (FreeClaudeCode)')
  assert.ok(models.some(model => model.id === 'fcc:groq/llama-3.3-70b-versatile'))

  const resolved = await adapter.resolveModel('freeclaudecode', 'auto')
  assert.equal(resolved.provider, 'freeclaudecode')
  assert.equal(resolved.id, 'auto')
  assert.equal(resolved.context.contextWindow, config.autoContextWindow)
  assert.deepEqual(resolved.inputModalities, ['text'])

  const explicit = await adapter.resolveModel('freeclaudecode', 'fcc:groq/llama-3.3-70b-versatile')
  assert.equal(explicit.context.contextWindow, 131072)

  const prepared = await adapter.prepareCall('freeclaudecode', 'auto')
  assert.equal(prepared.model.id, 'auto')
  assert.equal(typeof prepared.stream, 'function')

  const snapshot = adapter.status()
  assert.equal(snapshot.plugin, 'dsh-freeclaudecode-auto')
  assert.equal(snapshot.version, '1.0.0')
  assert.equal(snapshot.routing.providerId, 'freeclaudecode')
  assert.equal(snapshot.pool.size, 1)
})

test('apply registers the provider, the status tool, and the status route', async () => {
  let toolDefinition
  let route
  const tools = {
    register(definition) {
      toolDefinition = definition
      return () => {}
    },
  }
  const webServer = {
    register(candidateRoute) {
      route = candidateRoute
      return () => {}
    },
  }
  const ctx = fakeContext({ tools, webServer })

  apply(ctx, {
    fcc: { enabled: false, autoStart: false },
    directProviders: { enabled: false },
    statusRoute: true,
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(ctx.registrations.length, 1)
  assert.deepEqual(ctx.registrations[0].providers, ['freeclaudecode'])
  assert.equal(ctx.registrations[0].adapter.providerInfo('freeclaudecode').name, 'FreeClaudeCode')

  assert.equal(toolDefinition.name, 'freeclaudecode_status')
  const report = JSON.parse(await toolDefinition.execute({}))
  assert.equal(report.plugin, 'dsh-freeclaudecode-auto')
  assert.equal(report.health, 'offline')
  assert.equal(report.pool.candidates, undefined)

  assert.equal(route.kind, 'exact')
  assert.equal(route.path, STATUS_ROUTE)
  const response = await route.resource()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.plugin, 'dsh-freeclaudecode-auto')
  assert.equal(body.pool.candidates, undefined)

  for (const dispose of ctx.cleanups) dispose()
})

test('apply tolerates a host without the tools and webserver services', async () => {
  const ctx = fakeContext()
  apply(ctx, { fcc: { enabled: false, autoStart: false }, directProviders: { enabled: false } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.registrations.length, 1)
})
