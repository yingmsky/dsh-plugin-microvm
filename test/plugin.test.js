import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { startMockE2B } from './mock-e2b.js'
import { E2BClient, encodeEnvelope, decodeEnvelopes, OutputBuffer } from '../src/e2b.js'
import { SandboxManager } from '../src/manager.js'
import { buildTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'

let mock

before(async () => { mock = await startMockE2B() })
after(async () => { await mock.close() })

function setup(overrides = {}) {
  const config = resolveConfig({ apiKey: 'test-key', apiUrl: mock.apiUrl, envdUrl: mock.envdUrl, ...overrides }, {})
  const client = new E2BClient(config)
  const manager = new SandboxManager(client, { ...config, logger: { warn() {} } })
  const tools = Object.fromEntries(buildTools(manager, config).map((t) => [t.name, t]))
  const agent = { id: 'agent-1' }
  const call = (name, args, exec = {}) => tools[name].execute(args, { agent, signal: new AbortController().signal, ...exec })
  return { config, client, manager, tools, agent, call }
}

// ------------------------------------------------------------ wire helpers

test('Connect envelopes survive arbitrary chunk boundaries', async () => {
  const bytes = Buffer.concat([encodeEnvelope({ a: 1 }), encodeEnvelope({ b: 'x'.repeat(100) }), encodeEnvelope({}, 0x02)])
  async function* chunks() { for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3) }
  const out = []
  for await (const f of decodeEnvelopes(chunks())) out.push(f)
  assert.deepEqual(out.map((f) => f.flags), [0, 0, 2])
  assert.equal(out[0].message.a, 1)
  assert.equal(out[1].message.b.length, 100)
})

test('OutputBuffer keeps head and tail and reports dropped bytes', () => {
  const b = new OutputBuffer(10)
  b.push(Buffer.from('0123456789abcdefghij'))
  assert.equal(b.truncated, true)
  assert.match(b.toString(), /^01234\n…\[10 bytes truncated\]…\nfghij$/)
  const small = new OutputBuffer(10)
  small.push(Buffer.from('abc'))
  small.push(Buffer.from('def'))
  assert.equal(small.toString(), 'abcdef')
  assert.equal(small.truncated, false)
})

test('config falls back to E2B env vars like the E2B SDK', () => {
  const c = resolveConfig({}, { E2B_API_KEY: 'k', E2B_DOMAIN: 'example.dev' })
  assert.equal(c.apiKey, 'k')
  assert.equal(c.domain, 'example.dev')
  assert.equal(c.apiUrl, 'https://api.example.dev')
  assert.equal(resolveConfig({ apiUrl: 'http://127.0.0.1:8000' }, {}).apiUrl, 'http://127.0.0.1:8000')
  assert.equal(resolveConfig({}, { E2B_API_URL: 'http://x' }).apiUrl, 'http://x')
})

// ------------------------------------------------------------ tools end to end

test('create sends auth and explicit autoPause=false; exec returns output and exit 0', async () => {
  const { call } = setup()
  const sb = await call('microvm_create', { label: 'first' })
  assert.match(sb.sandboxId, /^sb\d+$/)
  assert.equal(sb.label, 'first')
  const createReq = mock.log.findLast((r) => r.path === '/v2/sandboxes')
  assert.equal(createReq.headers['x-api-key'], 'test-key')
  const body = JSON.parse(createReq.body)
  assert.equal(body.autoPause, false, 'autoPause must be sent explicitly (AgentENV defaults to true)')
  assert.equal(body.templateID, 'base')
  assert.equal(body.timeout, 600)

  const r = await call('microvm_exec', { sandboxId: sb.sandboxId, command: 'echo hello; echo oops >&2' })
  assert.equal(r.exitCode, 0, 'missing exitCode in proto3 JSON means 0')
  assert.equal(r.stdout, 'hello\n')
  assert.equal(r.stderr, 'oops\n')
  assert.equal(r.timedOut, false)
  const startReq = mock.log.findLast((x) => x.path.endsWith('/process.Process/Start'))
  assert.equal(startReq.headers['x-access-token'], `tok-${sb.sandboxId}`)
  assert.equal(startReq.headers.authorization, `Basic ${Buffer.from('user:').toString('base64')}`)
  assert.equal(startReq.headers['content-type'], 'application/connect+json')
  // exec refreshes the TTL
  assert.ok(mock.log.some((x) => x.path === `/sandboxes/${sb.sandboxId}/timeout`))
})

test('exec reports non-zero exit codes, env vars and cwd', async () => {
  const { call } = setup()
  const { sandboxId } = await call('microvm_create', {})
  await call('microvm_exec', { sandboxId, command: 'mkdir -p work' })
  const r = await call('microvm_exec', { sandboxId, command: 'pwd | xargs basename; echo "$GREETING"; exit 3', cwd: 'work', envs: { GREETING: 'hi' } })
  assert.equal(r.exitCode, 3)
  assert.equal(r.stdout, 'work\nhi\n')
})

test('a timed-out command is reported and killed', async () => {
  const { call } = setup()
  const { sandboxId } = await call('microvm_create', {})
  const r = await call('microvm_exec', { sandboxId, command: 'echo started; sleep 30', timeoutMs: 700 })
  assert.equal(r.timedOut, true)
  assert.equal(r.exitCode, null)
  assert.equal(r.stdout, 'started\n')
  assert.ok(mock.log.some((x) => x.path.endsWith('/process.Process/SendSignal') && x.body.includes('SIGNAL_SIGKILL')))
  for (let i = 0; i < 20 && mock.sandboxes.get(sandboxId).procs.size > 0; i++) await sleep(50)
  assert.equal(mock.sandboxes.get(sandboxId).procs.size, 0, 'process must not be left running')
})

test('caller cancellation aborts exec and kills the process', async () => {
  const { call } = setup()
  const { sandboxId } = await call('microvm_create', {})
  const ac = new AbortController()
  const p = call('microvm_exec', { sandboxId, command: 'sleep 30' }, { signal: ac.signal })
  await sleep(300)
  ac.abort(new Error('user cancelled'))
  await assert.rejects(p, /user cancelled/)
  for (let i = 0; i < 20 && mock.sandboxes.get(sandboxId).procs.size > 0; i++) await sleep(50)
  assert.equal(mock.sandboxes.get(sandboxId).procs.size, 0)
})

test('large output is capped head+tail', async () => {
  const { call } = setup({ maxOutputBytes: 2048 })
  const { sandboxId } = await call('microvm_create', {})
  const r = await call('microvm_exec', { sandboxId, command: 'seq 1 20000' })
  assert.equal(r.truncated, true)
  assert.ok(r.stdout.startsWith('1\n2\n3\n'))
  assert.ok(r.stdout.trimEnd().endsWith('20000'))
  assert.ok(r.stdout.length < 2200)
})

test('write_file then read_file round-trips, with nested dirs and read cap', async () => {
  const { call } = setup({ maxReadBytes: 1024 })
  const { sandboxId } = await call('microvm_create', {})
  const w = await call('microvm_write_file', { sandboxId, path: '/home/user/proj/a.py', content: 'print("héllo")\n' })
  assert.equal(w.bytes, Buffer.byteLength('print("héllo")\n'))
  const r = await call('microvm_read_file', { sandboxId, path: '/home/user/proj/a.py' })
  assert.equal(r.content, 'print("héllo")\n')
  assert.equal(r.truncated, false)
  await call('microvm_write_file', { sandboxId, path: '/big.txt', content: 'x'.repeat(5000) })
  const big = await call('microvm_read_file', { sandboxId, path: '/big.txt' })
  assert.equal(big.truncated, true)
  assert.equal(big.bytes, 5000)
  assert.equal(big.content.length, 1024)
  await assert.rejects(call('microvm_read_file', { sandboxId, path: '/nope' }), /404.*file not found/)
})

test('fork clones state into tracked children and respects the per-agent limit', async () => {
  const { call, manager, agent } = setup({ maxSandboxesPerAgent: 4 })
  const { sandboxId } = await call('microvm_create', { label: 'base-env' })
  await call('microvm_write_file', { sandboxId, path: '/state.txt', content: 'prepared' })
  const f = await call('microvm_fork', { sandboxId, count: 2 })
  assert.equal(f.children.length, 2)
  assert.deepEqual(f.errors, [])
  for (const c of f.children) {
    assert.equal(c.parentId, sandboxId)
    assert.equal(c.label, 'base-env')
    const r = await call('microvm_read_file', { sandboxId: c.sandboxId, path: '/state.txt' })
    assert.equal(r.content, 'prepared')
  }
  assert.equal(manager.ownedBy(agent).length, 3)
  await assert.rejects(call('microvm_fork', { sandboxId, count: 2 }), /sandbox limit reached/)
  await assert.rejects(call('microvm_fork', { sandboxId, count: 99 }), /count must be an integer between 1 and 8/)
})

test('only sandboxes created by the plugin can be addressed', async () => {
  const { call } = setup()
  await assert.rejects(call('microvm_exec', { sandboxId: 'someone-elses', command: 'id' }), /unknown sandbox "someone-elses"/)
})

test('destroy and list', async () => {
  const { call } = setup()
  const a = await call('microvm_create', { label: 'a' })
  const b = await call('microvm_create', { label: 'b' })
  let list = await call('microvm_list', {})
  assert.deepEqual(list.map((s) => s.label).sort(), ['a', 'b'])
  await call('microvm_destroy', { sandboxId: a.sandboxId })
  assert.equal(mock.sandboxes.has(a.sandboxId), false)
  list = await call('microvm_list', {})
  assert.deepEqual(list.map((s) => s.sandboxId), [b.sandboxId])
  await assert.rejects(call('microvm_exec', { sandboxId: a.sandboxId, command: 'true' }), /unknown sandbox/)
})

test('a sandbox that expired server-side is reported clearly', async () => {
  const { call, client } = setup()
  const { sandboxId } = await call('microvm_create', {})
  await client.kill(sandboxId) // simulate TTL expiry behind the plugin's back
  await assert.rejects(call('microvm_exec', { sandboxId, command: 'true' }), /no longer exists/)
  await assert.rejects(call('microvm_exec', { sandboxId, command: 'true' }), /unknown sandbox/)
})

test('agent disposal destroys only that agent\'s sandboxes; destroyAll cleans the rest', async () => {
  const { tools, manager } = setup()
  const exec = (agent) => ({ agent, signal: new AbortController().signal })
  const a1 = { id: 'a1' }
  const a2 = { id: 'a2' }
  const s1 = await tools.microvm_create.execute({}, exec(a1))
  const s2 = await tools.microvm_create.execute({}, exec(a2))
  assert.deepEqual(await manager.destroyOwnedBy(a1), [])
  assert.equal(mock.sandboxes.has(s1.sandboxId), false)
  assert.equal(mock.sandboxes.has(s2.sandboxId), true)
  await manager.destroyAll()
  assert.equal(mock.sandboxes.has(s2.sandboxId), false)
  assert.equal(manager.sandboxes.size, 0)
})

test('API errors surface the server message', async () => {
  const { call } = setup({ apiKey: 'wrong' })
  await assert.rejects(call('microvm_create', {}), /POST \/v2\/sandboxes failed \(401\): invalid API key/)
  const ok = setup()
  await assert.rejects(ok.call('microvm_create', { template: 'missing' }), /\(404\): template not found/)
})

test('fork is omitted when disabled', () => {
  const { tools } = setup({ enableFork: false })
  assert.equal(tools.microvm_fork, undefined)
  assert.ok(tools.microvm_exec)
})

// ------------------------------------------------------------ schema shape (DSH DSL rules)

test('tool schemas follow the DSH ParameterSchemaSpec / ValueSchemaSpec rules', () => {
  const { tools } = setup()
  const scalar = new Set(['string', 'number', 'integer', 'boolean', 'null', 'json'])
  function checkValue(node, where) {
    if (node.oneOf) {
      assert.ok(node.oneOf.length >= 2, `${where}: oneOf needs 2+ branches`)
      node.oneOf.forEach((n, i) => checkValue(n, `${where}.oneOf[${i}]`))
      return
    }
    if (scalar.has(node.type)) return
    if (node.type === 'array') { if (node.items) checkValue(node.items, `${where}.items`); return }
    if (node.type === 'object') {
      assert.equal(typeof node.additionalProperties, 'boolean', `${where}: object nodes must declare additionalProperties`)
      if (node.properties) checkParams(node.properties, where)
      return
    }
    assert.fail(`${where}: unknown node ${JSON.stringify(node)}`)
  }
  function checkParams(map, where) {
    for (const [k, v] of Object.entries(map)) {
      if (v.required !== undefined) assert.equal(v.required, true, `${where}.${k}: required must be true or absent`)
      checkValue(v, `${where}.${k}`)
    }
  }
  for (const t of Object.values(tools)) {
    assert.match(t.name, /^microvm_[a-z_]+$/)
    assert.ok(t.description.length > 20)
    checkParams(t.parameters, `${t.name}.parameters`)
    checkValue(t.output.schema, `${t.name}.output.schema`)
    assert.equal(typeof t.output.render, 'function')
  }
})

test('renderers and presenters are pure and produce text blocks', () => {
  const { tools } = setup()
  const v = { sandboxId: 'sb1', exitCode: 1, stdout: 'out', stderr: 'err', truncated: false, timedOut: false, durationMs: 5 }
  const blocks = tools.microvm_exec.output.render({}, v)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /exit 1 in 5ms[\s\S]*stdout[\s\S]*out[\s\S]*stderr[\s\S]*err/)
  assert.deepEqual(tools.microvm_exec.presentCall({ sandboxId: 'sb1', command: 'ls' }), { card: 'terminal', title: 'ls', description: 'microVM sb1' })
  const view = tools.microvm_exec.presentResult({}, { content: blocks, isError: false, meta: { exitCode: 1, timedOut: false } })
  assert.equal(view.card, 'terminal')
  assert.equal(view.exitCode, 1)
})
