// E2E probe mounted next to the plugin inside a real DSH profile.
// It waits for the microvm_* tools, drives the tool definitions DSH built
// (DSH-built definitions: arg validation, output-schema check, render),
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

  // Minimal JSON Schema check for the compiled output schemas DSH produced.
  function check(schema, value, path = '$') {
    if (schema.oneOf) {
      const ok = schema.oneOf.filter((s) => { try { check(s, value, path); return true } catch { return false } })
      if (ok.length !== 1) throw new Error(`${path}: matches ${ok.length} oneOf branches`)
      return
    }
    const t = schema.type
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value
    if (t && !(t === actual || (t === 'number' && actual === 'integer'))) throw new Error(`${path}: expected ${t}, got ${actual}`)
    if (t === 'array' && schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`))
    if (t === 'object') {
      for (const k of schema.required ?? []) if (!(k in value)) throw new Error(`${path}.${k}: required`)
      for (const [k, v] of Object.entries(value)) {
        if (schema.properties?.[k]) check(schema.properties[k], v, `${path}.${k}`)
        else if (schema.additionalProperties === false) throw new Error(`${path}.${k}: not allowed`)
      }
    }
  }

  // Call the tool definitions DSH registered (built by DSH's own defineTool, which
  // validates arguments), then check each value against the compiled output schema
  // and run the renderer, as the pipeline would.
  async function invoke(name, args) {
    const def = ctx.tools.get(name)
    return def.execute(args, { callId: `e2e-${name}`, name, arguments: args, signal: AbortSignal.timeout(60_000) })
  }
  async function call(name, args) {
    const def = ctx.tools.get(name)
    const value = await invoke(name, args)
    check(def.output.schema, value)
    const content = def.output.render(args, value)
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    report.steps.push({ name, args, text, value })
    return value
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
    let rejected = false
    try { await invoke('microvm_exec', { sandboxId: sb.sandboxId }) } catch (err) { rejected = true; report.badArgError = String(err?.message ?? err) }
    report.steps.push({ name: 'microvm_exec (missing command)', rejected })
    if (!rejected) throw new Error('missing required arg was not rejected')
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
