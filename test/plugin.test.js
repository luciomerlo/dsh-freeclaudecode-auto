/**
 * Adapter contract and host mounting, including the Settings connection route.
 *
 * @module dsh-freeclaudecode-auto/test/plugin
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'

import { apply, SETTINGS_ROUTE, STATUS_ROUTE } from '../index.js'
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

/** Build a fake context that records registrations and config edits. */
function fakeContext({ tools, webServer } = {}) {
  const registrations = []
  const cleanups = []
  const edits = []
  const editor = {
    async edit(entry, change) {
      const next = change({}, {})
      edits.push({ entry, next })
    },
  }
  const entry = { options: { id: 'llm-freeclaudecode', name: 'dsh-freeclaudecode-auto', config: {} } }
  return {
    registrations,
    cleanups,
    edits,
    logger: { info() {}, warn() {}, debug() {} },
    fiber: { entry },
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
      if (name === 'configEditor') return editor
      return undefined
    },
  }
}

/** Call one registered webserver route with a synthetic request. */
async function callRoute(route, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload)
  req.method = method
  req.headers = headers
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, responseHeaders) {
      this.statusCode = code
      this.headers = responseHeaders ?? {}
    },
    end(text) {
      this.body = text ?? ''
    },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: res.body === '' ? undefined : JSON.parse(res.body) }
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

test('apply registers the provider, the status tool, and both routes', async () => {
  let toolDefinition
  const routes = []
  const tools = {
    register(definition) {
      toolDefinition = definition
      return () => {}
    },
  }
  const webServer = {
    register(candidateRoute) {
      routes.push(candidateRoute)
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

  const statusRoute = routes.find(route => route.path === STATUS_ROUTE)
  assert.equal(statusRoute.kind, 'exact')
  const response = await statusRoute.resource()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.plugin, 'dsh-freeclaudecode-auto')
  assert.equal(body.pool.candidates, undefined)
  assert.equal(body.fcc.directory, undefined, 'the public status carries no local paths')

  assert.ok(routes.some(route => route.path === SETTINGS_ROUTE), 'the Settings route is registered')

  for (const dispose of ctx.cleanups) dispose()
})

test('the settings route refuses a request without the plugin header', async () => {
  const routes = []
  const ctx = fakeContext({ webServer: { register(route) { routes.push(route); return () => {} } } })
  apply(ctx, { fcc: { enabled: false, autoStart: false }, directProviders: { enabled: false } })
  await new Promise(resolve => setImmediate(resolve))

  const route = routes.find(entry => entry.path === SETTINGS_ROUTE)
  const refused = await callRoute(route, { method: 'GET' })
  assert.equal(refused.status, 403)

  const allowed = await callRoute(route, {
    method: 'GET',
    headers: { 'x-dsh-plugin-request': 'freeclaudecode' },
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json.config.providerId, 'freeclaudecode')
  assert.match(allowed.json.config.fcc.directory, /\.fcc$/u)
  assert.equal(allowed.json.capabilities.canSave, true)

  for (const dispose of ctx.cleanups) dispose()
})

test('saving the connection writes the plugin row through the config editor', async () => {
  const routes = []
  const ctx = fakeContext({ webServer: { register(route) { routes.push(route); return () => {} } } })
  apply(ctx, { fcc: { enabled: false, autoStart: false }, directProviders: { enabled: false } })
  await new Promise(resolve => setImmediate(resolve))

  const route = routes.find(entry => entry.path === SETTINGS_ROUTE)
  const saved = await callRoute(route, {
    method: 'POST',
    headers: { 'x-dsh-plugin-request': 'freeclaudecode' },
    body: {
      action: 'save',
      baseUrl: 'http://127.0.0.1:9099/',
      directory: '~/.fcc',
      autoStart: false,
      enabled: true,
    },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.saved, true)
  assert.equal(ctx.edits.length, 1)
  assert.equal(ctx.edits[0].entry.options.id, 'llm-freeclaudecode')
  assert.equal(ctx.edits[0].next.fcc.baseUrl, 'http://127.0.0.1:9099')
  assert.equal(ctx.edits[0].next.fcc.autoStart, false)
  assert.match(ctx.edits[0].next.fcc.directory, /[\\/]\.fcc$/u)

  const invalid = await callRoute(route, {
    method: 'POST',
    headers: { 'x-dsh-plugin-request': 'freeclaudecode' },
    body: { action: 'save', baseUrl: 'ftp://nope' },
  })
  assert.equal(invalid.status, 400)
  assert.equal(ctx.edits.length, 1, 'an invalid draft never reaches the editor')

  for (const dispose of ctx.cleanups) dispose()
})

test('the connection actions report a disabled integration without network I/O', async () => {
  const routes = []
  const ctx = fakeContext({ webServer: { register(route) { routes.push(route); return () => {} } } })
  apply(ctx, { fcc: { enabled: false, autoStart: false }, directProviders: { enabled: false } })
  await new Promise(resolve => setImmediate(resolve))

  const route = routes.find(entry => entry.path === SETTINGS_ROUTE)
  const tested = await callRoute(route, {
    method: 'POST',
    headers: { 'x-dsh-plugin-request': 'freeclaudecode' },
    body: { action: 'test' },
  })
  assert.equal(tested.status, 200)
  assert.equal(tested.json.ok, false)
  assert.match(tested.json.message, /disabled/u)

  const refreshed = await callRoute(route, {
    method: 'POST',
    headers: { 'x-dsh-plugin-request': 'freeclaudecode' },
    body: { action: 'refresh' },
  })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.json.ok, true)
  assert.match(refreshed.json.message, /models loaded/u)

  for (const dispose of ctx.cleanups) dispose()
})

test('apply tolerates a host without the tools and webserver services', async () => {
  const ctx = fakeContext()
  apply(ctx, { fcc: { enabled: false, autoStart: false }, directProviders: { enabled: false } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.registrations.length, 1)
})
