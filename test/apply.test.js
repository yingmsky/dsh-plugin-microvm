import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { startMockE2B } from './mock-e2b.js'

register('./stubs/hooks.mjs', import.meta.url)
const plugin = await import('../src/index.js')

let mock
before(async () => { mock = await startMockE2B() })
after(async () => { await mock.close() })

function fakeCtx() {
  const tools = new Map()
  const listeners = {}
  const disposers = []
  return {
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn) },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    logger: { warn() {}, info() {}, error() {} },
    emit: async (ev, payload) => { for (const fn of listeners[ev] ?? []) fn(payload) },
    unload: () => disposers.forEach((d) => d()),
    registered: tools,
  }
}

const waitFor = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); return cond() }

test('plugin exports the Cordis contract', () => {
  assert.equal(plugin.name, 'dsh-plugin-microvm')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.ok(plugin.Config)
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers every tool through defineTool and cleans up on agent disposal and unload', async () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, { apiKey: 'test-key', apiUrl: mock.apiUrl, envdUrl: mock.envdUrl })
  assert.deepEqual([...ctx.registered.keys()].sort(), [
    'microvm_create', 'microvm_destroy', 'microvm_exec', 'microvm_fork', 'microvm_list', 'microvm_read_file', 'microvm_write_file',
  ])
  assert.ok([...ctx.registered.values()].every((t) => t.__defined))

  const agentA = { id: 'A' }
  const agentB = { id: 'B' }
  const create = ctx.registered.get('microvm_create')
  const a = await create.execute({}, { agent: agentA, signal: new AbortController().signal })
  const b = await create.execute({}, { agent: agentB, signal: new AbortController().signal })

  await ctx.emit('agent/disposed', { agent: agentA })
  assert.ok(await waitFor(() => !mock.sandboxes.has(a.sandboxId)), 'disposed agent\'s sandbox destroyed')
  assert.equal(mock.sandboxes.has(b.sandboxId), true)

  ctx.unload()
  assert.ok(await waitFor(() => !mock.sandboxes.has(b.sandboxId)), 'plugin unload destroys the rest')
})

test('keepOnDispose leaves sandboxes running on unload', async () => {
  const ctx = fakeCtx()
  plugin.apply(ctx, { apiKey: 'test-key', apiUrl: mock.apiUrl, envdUrl: mock.envdUrl, keepOnDispose: true })
  const s = await ctx.registered.get('microvm_create').execute({}, { agent: {}, signal: new AbortController().signal })
  ctx.unload()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(mock.sandboxes.has(s.sandboxId), true)
})
