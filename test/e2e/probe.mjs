// E2E probe mounted next to the plugin inside a real DSH profile.
// It waits for the microvm_* tools, drives them through DSH's own tool pipeline
// (ctx.tools.execute: arg validation, policy, output-schema validation, render),
// writes a JSON report, and exits the process.

import { writeFileSync } from 'node:fs'

export const name = 'microvm-e2e-probe'
export const inject = ['tools']

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'microvm-e2e',
    validate: (value) => ({ value: value ?? {} }),
  },
}

const EXPECTED = ['microvm_create', 'microvm_exec', 'microvm_read_file', 'microvm_write_file', 'microvm_fork', 'microvm_destroy', 'microvm_list']

export function apply(ctx, config) {
  const reportPath = config.report ?? process.env.MICROVM_E2E_REPORT
  const report = { steps: [], ok: false }
  const done = (code) => {
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    setTimeout(() => process.exit(code), 50)
  }

  // ToolBatchResult is { results: [{ callId, result }] } on DSH main; tolerate other
  // release shapes, and record the raw shape when it is unrecognised.
  function firstOutcome(res) {
    const list = Array.isArray(res) ? res : res?.results ?? res?.outcomes ?? res?.calls
    const first = Array.isArray(list) ? list[0] : undefined
    const outcome = first?.result ?? first?.outcome ?? first
    if (!outcome || typeof outcome.isError !== 'boolean') {
      const shape = (v, d = 0) => v === null || typeof v !== 'object' || d > 3 ? typeof v
        : Array.isArray(v) ? [v.length ? shape(v[0], d + 1) : 'empty'] : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, d + 1)]))
      report.rawShape = shape(res)
      throw new Error(`unrecognised ctx.tools.execute result: ${JSON.stringify(report.rawShape)}`)
    }
    return outcome
  }

  let n = 0
  async function call(name, args) {
    const res = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `e2e-${++n}`, name, arguments: JSON.stringify(args) }],
      signal: AbortSignal.timeout(60_000),
    })
    const outcome = firstOutcome(res)
    const text = (outcome.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    report.steps.push({ name, args, isError: outcome.isError, text, value: outcome.value ?? null })
    if (outcome.isError) throw new Error(`${name} failed: ${text}`)
    return outcome.value
  }

  async function run() {
    const deadline = Date.now() + 60_000
    while (!EXPECTED.every((t) => ctx.tools.get(t)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    report.registered = EXPECTED.filter((t) => ctx.tools.get(t))
    if (report.registered.length !== EXPECTED.length) throw new Error(`missing tools: ${EXPECTED.filter((t) => !ctx.tools.get(t)).join(', ')}`)

    const sb = await call('microvm_create', { label: 'e2e' })
    const ex = await call('microvm_exec', { sandboxId: sb.sandboxId, command: 'echo from-dsh; exit 7' })
    if (ex.stdout !== 'from-dsh\n' || ex.exitCode !== 7) throw new Error(`unexpected exec value ${JSON.stringify(ex)}`)
    await call('microvm_write_file', { sandboxId: sb.sandboxId, path: '/e2e/hello.txt', content: 'hi' })
    const rd = await call('microvm_read_file', { sandboxId: sb.sandboxId, path: '/e2e/hello.txt' })
    if (rd.content !== 'hi') throw new Error('read/write mismatch')
    const fk = await call('microvm_fork', { sandboxId: sb.sandboxId, count: 2 })
    if (fk.children.length !== 2) throw new Error('fork did not produce 2 children')
    const ls = await call('microvm_list', {})
    if (ls.length !== 3) throw new Error(`expected 3 sandboxes, got ${ls.length}`)
    // invalid args must be rejected by DSH's validator before the tool runs
    const bad = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'e2e-bad', name: 'microvm_exec', arguments: JSON.stringify({ sandboxId: sb.sandboxId }) }],
      signal: AbortSignal.timeout(10_000),
    })
    const badOutcome = firstOutcome(bad)
    report.steps.push({ name: 'microvm_exec (missing command)', isError: badOutcome.isError })
    if (!badOutcome.isError) throw new Error('missing required arg was not rejected')
    for (const s of ls) await call('microvm_destroy', { sandboxId: s.sandboxId })
    report.ok = true
  }

  ctx.effect(() => {
    run().then(() => done(0), (err) => {
      report.error = String(err && err.stack || err)
      done(1)
    })
    return () => {}
  })
}
