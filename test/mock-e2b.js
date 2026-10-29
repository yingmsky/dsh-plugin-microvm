// A small E2B-compatible server for tests: control plane + envd on one port.
// envd routes live under /envd/<sandboxId>/ and really run commands with bash,
// with each sandbox's filesystem rooted in its own temp directory.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { encodeEnvelope } from '../src/e2b.js'

export async function startMockE2B({ apiKey = 'test-key', forkSupported = true } = {}) {
  /** @type {Map<string, { root: string, token: string, timeout: number, procs: Map<number, import('node:child_process').ChildProcess> }>} */
  const sandboxes = new Map()
  const log = []
  let seq = 0

  function newSandbox() {
    const id = `sb${++seq}`
    const root = mkdtempSync(join(tmpdir(), `mock-e2b-${id}-`))
    sandboxes.set(id, { root, token: `tok-${id}`, timeout: 0, procs: new Map() })
    return id
  }

  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const body = await readBody(req)
    log.push({ method: req.method, path: url.pathname, headers: req.headers, body: body.toString('utf8') })

    // ---------------- envd
    const envd = url.pathname.match(/^\/envd\/([^/]+)(\/.*)$/)
    if (envd) {
      const sb = sandboxes.get(envd[1])
      if (!sb) return json(res, 502, { message: 'sandbox not found' })
      if (req.headers['x-access-token'] !== sb.token) return json(res, 401, { message: 'bad access token' })
      const route = envd[2]
      const sbPath = (p) => join(sb.root, p)

      if (route === '/process.Process/Start') {
        const frame = body.subarray(5)
        const msg = JSON.parse(frame.toString('utf8'))
        const { cmd, args, envs, cwd } = msg.process
        const child = spawn(cmd, args, { cwd: cwd ? sbPath(cwd) : sb.root, env: { ...process.env, ...envs, HOME: sb.root } })
        sb.procs.set(child.pid, child)
        res.writeHead(200, { 'Content-Type': 'application/connect+json' })
        res.write(encodeEnvelope({ event: { start: { pid: child.pid } } }))
        child.stdout.on('data', (d) => res.write(encodeEnvelope({ event: { data: { stdout: d.toString('base64') } } })))
        child.stderr.on('data', (d) => res.write(encodeEnvelope({ event: { data: { stderr: d.toString('base64') } } })))
        req.on('close', () => {}) // client may abort; process keeps running until signalled, like real envd
        child.on('close', (code, signal) => {
          sb.procs.delete(child.pid)
          if (res.writableEnded || res.destroyed) return
          const end = { exited: signal === null, status: signal ? `signal: ${signal}` : `exit status ${code}` }
          if (code) end.exitCode = code // proto3 JSON omits zero
          res.write(encodeEnvelope({ event: { end } }))
          res.end(encodeEnvelope({}, 0x02))
        })
        return
      }
      if (route === '/process.Process/SendSignal') {
        const msg = JSON.parse(body.toString('utf8'))
        const child = sb.procs.get(msg.process.pid)
        if (child) child.kill(msg.signal === 'SIGNAL_SIGKILL' ? 'SIGKILL' : 'SIGTERM')
        return json(res, 200, {})
      }
      if (route === '/files' && req.method === 'GET') {
        const p = sbPath(url.searchParams.get('path'))
        if (!existsSync(p)) return json(res, 404, { message: 'file not found' })
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return res.end(readFileSync(p))
      }
      if (route === '/files' && req.method === 'POST') {
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData()
        const file = form.get('file')
        const p = sbPath(url.searchParams.get('path'))
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, Buffer.from(await file.arrayBuffer()))
        return json(res, 200, [{ name: p, type: 'file', path: url.searchParams.get('path') }])
      }
      return json(res, 404, { message: `no envd route ${route}` })
    }

    // ---------------- control plane
    if (req.headers['x-api-key'] !== apiKey) return json(res, 401, { message: 'invalid API key' })
    const parsed = body.length ? JSON.parse(body.toString('utf8')) : {}

    if (req.method === 'POST' && url.pathname === '/v2/sandboxes') {
      if (parsed.templateID === 'missing') return json(res, 404, { message: 'template not found' })
      const id = newSandbox()
      sandboxes.get(id).timeout = parsed.timeout
      return json(res, 201, { sandboxID: id, templateID: parsed.templateID, envdVersion: '0.4.0', envdAccessToken: `tok-${id}`, clientID: 'c', domain: null })
    }
    let m
    if ((m = url.pathname.match(/^\/sandboxes\/([^/]+)\/fork$/)) && req.method === 'POST') {
      if (!forkSupported) return json(res, 404, { message: 'not found' })
      const parent = sandboxes.get(m[1])
      if (!parent) return json(res, 404, { message: 'sandbox not found' })
      const out = []
      for (let i = 0; i < parsed.count; i++) {
        const id = newSandbox()
        // copy the parent's filesystem to simulate a fork
        rmSync(sandboxes.get(id).root, { recursive: true, force: true })
        await new Promise((r) => spawn('cp', ['-a', parent.root, sandboxes.get(id).root]).on('close', r))
        out.push({ sandbox: { sandboxID: id, templateID: 'base', envdVersion: '0.4.0', envdAccessToken: `tok-${id}` } })
      }
      return json(res, 200, out)
    }
    if ((m = url.pathname.match(/^\/sandboxes\/([^/]+)\/timeout$/)) && req.method === 'POST') {
      const sb = sandboxes.get(m[1])
      if (!sb) return json(res, 404, { message: 'sandbox not found' })
      sb.timeout = parsed.timeout
      return json(res, 204)
    }
    if ((m = url.pathname.match(/^\/sandboxes\/([^/]+)$/)) && req.method === 'DELETE') {
      const sb = sandboxes.get(m[1])
      if (!sb) return json(res, 404, { message: 'sandbox not found' })
      for (const p of sb.procs.values()) p.kill('SIGKILL')
      rmSync(sb.root, { recursive: true, force: true })
      sandboxes.delete(m[1])
      return json(res, 204)
    }
    return json(res, 404, { message: `no route ${req.method} ${url.pathname}` })
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    port,
    sandboxes,
    log,
    apiUrl: `http://127.0.0.1:${port}`,
    envdUrl: `http://127.0.0.1:${port}/envd/{sandboxId}`,
    async close() {
      for (const sb of sandboxes.values()) {
        for (const p of sb.procs.values()) p.kill('SIGKILL')
        rmSync(sb.root, { recursive: true, force: true })
      }
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}
