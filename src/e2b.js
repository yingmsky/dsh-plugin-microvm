// Minimal, dependency-free client for E2B-compatible sandbox APIs
// (E2B cloud, self-hosted E2B, and AgentENV's E2B-compatible server).
//
// Two planes:
//   control plane  REST on `apiUrl`, `X-API-Key` auth
//   envd           per-sandbox agent; Connect RPC for processes, HTTP for files
//
// Wire details follow the E2B JS SDK and `spec/envd/*.proto` in e2b-dev/E2B.

/** @typedef {{ sandboxId: string, envdAccessToken?: string, domain?: string, templateId?: string, envdVersion?: string }} SandboxHandle */

export class E2BError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [info]
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'E2BError'
    this.status = info.status
    this.code = info.code
  }
}

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

/**
 * Encode one Connect streaming envelope: 1 flag byte, 4-byte big-endian length, payload.
 * @param {unknown} message
 * @param {number} [flags]
 */
export function encodeEnvelope(message, flags = 0) {
  const payload = textEncoder.encode(JSON.stringify(message))
  const out = new Uint8Array(5 + payload.length)
  out[0] = flags
  new DataView(out.buffer).setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}

/**
 * Incrementally decode Connect streaming envelopes from a byte stream.
 * @param {AsyncIterable<Uint8Array>} chunks
 * @returns {AsyncGenerator<{ flags: number, message: any }>}
 */
export async function* decodeEnvelopes(chunks) {
  let buf = new Uint8Array(0)
  for await (const chunk of chunks) {
    const next = new Uint8Array(buf.length + chunk.length)
    next.set(buf, 0)
    next.set(chunk, buf.length)
    buf = next
    while (buf.length >= 5) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false)
      if (buf.length < 5 + len) break
      const flags = buf[0]
      const raw = buf.subarray(5, 5 + len)
      buf = buf.slice(5 + len)
      let message
      try {
        message = raw.length === 0 ? {} : JSON.parse(textDecoder.decode(raw))
      } catch {
        throw new E2BError('envd sent a malformed stream frame')
      }
      yield { flags, message }
    }
  }
  if (buf.length > 0) throw new E2BError('envd stream ended mid-frame')
}

/** @param {string | undefined} b64 */
function fromBase64(b64) {
  return b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0)
}

/**
 * Bounded output collector: keeps the head and tail of a stream, drops the middle.
 */
export class OutputBuffer {
  /** @param {number} limit max bytes kept */
  constructor(limit) {
    this.limit = Math.max(0, limit)
    this.headLimit = Math.ceil(this.limit / 2)
    this.tailLimit = this.limit - this.headLimit
    /** @type {Buffer[]} */ this.head = []
    this.headBytes = 0
    /** @type {Buffer} */ this.tail = Buffer.alloc(0)
    this.total = 0
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.total += chunk.length
    if (this.headBytes < this.headLimit) {
      const take = Math.min(chunk.length, this.headLimit - this.headBytes)
      this.head.push(chunk.subarray(0, take))
      this.headBytes += take
      chunk = chunk.subarray(take)
    }
    if (chunk.length === 0 || this.tailLimit === 0) return
    const joined = Buffer.concat([this.tail, chunk])
    this.tail = joined.length > this.tailLimit ? joined.subarray(joined.length - this.tailLimit) : joined
  }

  get truncated() {
    return this.total > this.limit
  }

  toString() {
    const head = Buffer.concat(this.head).toString('utf8')
    if (!this.truncated) return head + this.tail.toString('utf8')
    const dropped = this.total - this.headBytes - this.tail.length
    return `${head}\n…[${dropped} bytes truncated]…\n${this.tail.toString('utf8')}`
  }
}

/**
 * Combine abort signals; the result aborts when any input aborts.
 * @param {(AbortSignal | undefined)[]} signals
 */
function anySignal(signals) {
  const list = signals.filter(Boolean)
  return list.length === 1 ? list[0] : AbortSignal.any(/** @type {AbortSignal[]} */ (list))
}

export class E2BClient {
  /**
   * @param {{
   *   apiKey: string, apiUrl: string, domain: string, envdUrl: string, envdPort: number,
   *   user: string, requestTimeoutMs: number, fetch?: typeof fetch,
   * }} options
   */
  constructor(options) {
    this.options = options
    this.fetch = options.fetch ?? globalThis.fetch
  }

  // ---------------------------------------------------------------- control plane

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {AbortSignal} [signal]
   */
  async api(method, path, body, signal) {
    const url = this.options.apiUrl.replace(/\/+$/, '') + path
    const res = await this.fetch(url, {
      method,
      headers: {
        'X-API-Key': this.options.apiKey,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: anySignal([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
    })
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = undefined
    }
    if (!res.ok) {
      const detail = (data && (data.message || data.error)) || text.slice(0, 300) || res.statusText
      throw new E2BError(`${method} ${path} failed (${res.status}): ${detail}`, { status: res.status })
    }
    return data
  }

  /**
   * Create a sandbox. `autoPause` is always sent explicitly: AgentENV defaults it to
   * true (unlike E2B), which would leave paused sandboxes behind after the TTL.
   * @param {{ template: string, timeoutSec: number, autoPause: boolean, allowInternetAccess: boolean, envs?: Record<string,string>, metadata?: Record<string,string> }} opts
   * @param {AbortSignal} [signal]
   * @returns {Promise<SandboxHandle>}
   */
  async create(opts, signal) {
    const data = await this.api('POST', '/v2/sandboxes', {
      templateID: opts.template,
      timeout: opts.timeoutSec,
      autoPause: opts.autoPause,
      allow_internet_access: opts.allowInternetAccess,
      ...(opts.envs && Object.keys(opts.envs).length ? { envVars: opts.envs } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    }, signal)
    return toHandle(data)
  }

  /**
   * Fork a running sandbox (memory + disk) into `count` children.
   * @param {string} sandboxId
   * @param {{ count: number, timeoutSec: number }} opts
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<SandboxHandle | { error: string }>>}
   */
  async fork(sandboxId, opts, signal) {
    const data = await this.api('POST', `/sandboxes/${encodeURIComponent(sandboxId)}/fork`, {
      count: opts.count,
      timeout: opts.timeoutSec,
    }, signal)
    if (!Array.isArray(data)) throw new E2BError('fork: unexpected response shape')
    return data.map((r) => {
      if (r && r.sandbox && !r.error) return toHandle(r.sandbox)
      const err = r && r.error
      return { error: err ? `${err.code ?? ''} ${err.message ?? ''}`.trim() : 'fork child failed to start' }
    })
  }

  /** @param {string} sandboxId @param {number} timeoutSec @param {AbortSignal} [signal] */
  async setTimeout(sandboxId, timeoutSec, signal) {
    await this.api('POST', `/sandboxes/${encodeURIComponent(sandboxId)}/timeout`, { timeout: timeoutSec }, signal)
  }

  /** @param {string} sandboxId @param {AbortSignal} [signal] */
  async kill(sandboxId, signal) {
    try {
      await this.api('DELETE', `/sandboxes/${encodeURIComponent(sandboxId)}`, undefined, signal)
    } catch (err) {
      if (err instanceof E2BError && err.status === 404) return // already gone
      throw err
    }
  }

  // ---------------------------------------------------------------- envd

  /** @param {SandboxHandle} sb */
  envdBase(sb) {
    return this.options.envdUrl
      .replaceAll('{port}', String(this.options.envdPort))
      .replaceAll('{sandboxId}', sb.sandboxId)
      .replaceAll('{domain}', sb.domain || this.options.domain)
      .replace(/\/+$/, '')
  }

  /** @param {SandboxHandle} sb */
  envdHeaders(sb) {
    /** @type {Record<string,string>} */
    const h = {
      'E2b-Sandbox-Id': sb.sandboxId,
      'E2b-Sandbox-Port': String(this.options.envdPort),
    }
    if (sb.envdAccessToken) h['X-Access-Token'] = sb.envdAccessToken
    if (this.options.user) h.Authorization = `Basic ${Buffer.from(`${this.options.user}:`).toString('base64')}`
    return h
  }

  /**
   * Run a command through `/bin/bash -l -c` and wait for it to exit.
   * @param {SandboxHandle} sb
   * @param {{ command: string, cwd?: string, envs?: Record<string,string>, timeoutMs: number, maxOutputBytes: number }} opts
   * @param {AbortSignal} [signal] caller cancellation
   */
  async exec(sb, opts, signal) {
    const started = Date.now()
    const deadline = AbortSignal.timeout(opts.timeoutMs)
    const combined = anySignal([signal, deadline])
    const stdout = new OutputBuffer(opts.maxOutputBytes)
    const stderr = new OutputBuffer(opts.maxOutputBytes)
    /** @type {number | undefined} */ let pid
    /** @type {any} */ let end
    try {
      const res = await this.fetch(`${this.envdBase(sb)}/process.Process/Start`, {
        method: 'POST',
        headers: {
          ...this.envdHeaders(sb),
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'Keepalive-Ping-Interval': '30',
        },
        body: encodeEnvelope({
          process: {
            cmd: '/bin/bash',
            args: ['-l', '-c', opts.command],
            envs: opts.envs ?? {},
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
          },
          stdin: false,
        }),
        signal: combined,
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new E2BError(`envd Start failed (${res.status}): ${text.slice(0, 300) || res.statusText}`, { status: res.status })
      }
      for await (const { flags, message } of decodeEnvelopes(/** @type {any} */ (res.body))) {
        if (flags & 0x02) {
          if (message && message.error) {
            throw new E2BError(`envd: ${message.error.message || message.error.code}`, { code: message.error.code })
          }
          break
        }
        const ev = message && message.event
        if (!ev) continue
        if (ev.start) pid = ev.start.pid
        else if (ev.data) {
          if (ev.data.stdout) stdout.push(fromBase64(ev.data.stdout))
          if (ev.data.stderr) stderr.push(fromBase64(ev.data.stderr))
        } else if (ev.end) end = ev.end
      }
    } catch (err) {
      if (!combined.aborted) throw err
    }

    const timedOut = deadline.aborted && !end
    if (!end && pid !== undefined) {
      // The stream was cut (timeout or cancel): don't leave the process running.
      await this.signalProcess(sb, pid, 'SIGNAL_SIGKILL').catch(() => {})
    }
    if (!end && signal?.aborted && !timedOut) {
      throw signal.reason ?? new Error('aborted')
    }
    if (!end && !timedOut) throw new E2BError('envd stream closed before the process ended')

    return {
      // proto3 JSON omits zero values, so a missing exit_code means 0.
      exitCode: end ? (end.exitCode ?? 0) : null,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
      durationMs: Date.now() - started,
      ...(end && end.error ? { error: String(end.error) } : {}),
    }
  }

  /** @param {SandboxHandle} sb @param {number} pid @param {'SIGNAL_SIGKILL'|'SIGNAL_SIGTERM'} sig */
  async signalProcess(sb, pid, sig) {
    const res = await this.fetch(`${this.envdBase(sb)}/process.Process/SendSignal`, {
      method: 'POST',
      headers: { ...this.envdHeaders(sb), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ process: { pid }, signal: sig }),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    })
    await res.arrayBuffer()
  }

  /**
   * @param {SandboxHandle} sb
   * @param {string} path
   * @param {number} maxBytes
   * @param {AbortSignal} [signal]
   */
  async readFile(sb, path, maxBytes, signal) {
    const q = new URLSearchParams({ path })
    if (this.options.user) q.set('username', this.options.user)
    const res = await this.fetch(`${this.envdBase(sb)}/files?${q}`, {
      headers: this.envdHeaders(sb),
      signal: anySignal([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new E2BError(`read ${path} failed (${res.status}): ${envdMessage(text) || res.statusText}`, { status: res.status })
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const truncated = buf.length > maxBytes
    const slice = truncated ? buf.subarray(0, maxBytes) : buf
    return { content: slice.toString('utf8'), bytes: buf.length, truncated }
  }

  /**
   * @param {SandboxHandle} sb
   * @param {string} path
   * @param {string} content
   * @param {AbortSignal} [signal]
   */
  async writeFile(sb, path, content, signal) {
    const q = new URLSearchParams({ path })
    if (this.options.user) q.set('username', this.options.user)
    const form = new FormData()
    form.append('file', new Blob([content]), path)
    const res = await this.fetch(`${this.envdBase(sb)}/files?${q}`, {
      method: 'POST',
      headers: this.envdHeaders(sb),
      body: form,
      signal: anySignal([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new E2BError(`write ${path} failed (${res.status}): ${envdMessage(text) || res.statusText}`, { status: res.status })
    }
    await res.arrayBuffer()
    return { bytes: Buffer.byteLength(content) }
  }
}

/** @param {string} text */
function envdMessage(text) {
  try {
    const j = JSON.parse(text)
    return j.message || j.error || text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

/** @param {any} data @returns {SandboxHandle} */
function toHandle(data) {
  if (!data || typeof data.sandboxID !== 'string') throw new E2BError('create: response has no sandboxID')
  return {
    sandboxId: data.sandboxID,
    envdAccessToken: data.envdAccessToken ?? undefined,
    domain: data.domain ?? undefined,
    templateId: data.templateID ?? undefined,
    envdVersion: data.envdVersion ?? undefined,
  }
}
