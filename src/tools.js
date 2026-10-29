// Tool definitions in the shape `defineTool` from @deepseek-ai/dsh-tools expects.
// Kept free of DSH imports so they can be unit-tested without a harness.

/** @param {string} text */
const text = (text) => [{ type: 'text', text }]

const sandboxIdParam = {
  type: 'string',
  required: true,
  description: 'Sandbox id returned by microvm_create or microvm_fork.',
}

const envsParam = {
  type: 'object',
  additionalProperties: true,
  description: 'Environment variables as string key/value pairs.',
}

/** @param {unknown} envs @returns {Record<string,string> | undefined} */
function stringEnvs(envs) {
  if (envs === undefined || envs === null) return undefined
  /** @type {Record<string,string>} */ const out = {}
  for (const [k, v] of Object.entries(/** @type {object} */ (envs))) {
    if (typeof v !== 'string') throw new Error(`envs.${k} must be a string`)
    out[k] = v
  }
  return out
}

/** @param {import('./manager.js').TrackedSandbox} sb */
function summary(sb) {
  return {
    sandboxId: sb.sandboxId,
    template: sb.templateId ?? null,
    label: sb.label ?? null,
    parentId: sb.parentId ?? null,
    createdAt: new Date(sb.createdAt).toISOString(),
    lastUsedAt: new Date(sb.lastUsedAt).toISOString(),
  }
}

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sandboxId: { type: 'string', required: true },
    template: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    label: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    parentId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    createdAt: { type: 'string', required: true },
    lastUsedAt: { type: 'string', required: true },
  },
}

/**
 * @param {import('./manager.js').SandboxManager} manager
 * @param {import('./config.js').ResolvedConfig} config
 */
export function buildTools(manager, config) {
  const client = manager.client

  const create = {
    name: 'microvm_create',
    description:
      'Start a fresh, disposable microVM sandbox (E2B-compatible: E2B, AgentENV). ' +
      'Use it to run untrusted code, install packages, or try risky commands without touching the local machine. ' +
      `It is destroyed automatically ${config.sandboxTimeoutSec}s after its last use, or when this session ends. ` +
      'Returns the sandboxId to pass to the other microvm_* tools.',
    parameters: {
      template: { type: 'string', description: `Sandbox template id. Defaults to "${config.template}".` },
      label: { type: 'string', description: 'Short note to tell sandboxes apart in microvm_list.' },
      envs: envsParam,
    },
    output: {
      schema: summarySchema,
      render: (_args, v) => text(`Created sandbox ${v.sandboxId}${v.template ? ` (template ${v.template})` : ''}.`),
    },
    async execute(args, exec) {
      manager.assertCapacity(exec.agent, 1)
      const handle = await client.create({
        template: args.template || config.template,
        timeoutSec: config.sandboxTimeoutSec,
        autoPause: config.autoPause,
        allowInternetAccess: config.allowInternetAccess,
        envs: stringEnvs(args.envs),
        metadata: { createdBy: 'dsh-plugin-microvm' },
      }, exec.signal)
      const sb = manager.track(exec.agent, handle, { label: args.label })
      sb.templateId ??= args.template || config.template
      return summary(sb)
    },
  }

  const execTool = {
    name: 'microvm_exec',
    description:
      'Run a shell command (bash -l -c) inside a sandbox and wait for it to finish. ' +
      'Returns exit code, stdout and stderr. Long output keeps its head and tail. ' +
      `Default timeout ${config.execTimeoutMs}ms, max ${config.maxExecTimeoutMs}ms; a timed-out command is killed.`,
    parameters: {
      sandboxId: sandboxIdParam,
      command: { type: 'string', required: true, description: 'Shell command to run.' },
      cwd: { type: 'string', description: 'Working directory inside the sandbox.' },
      envs: envsParam,
      timeoutMs: { type: 'integer', description: 'Per-command timeout in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sandboxId: { type: 'string', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => {
        const status = v.timedOut ? `timed out after ${v.durationMs}ms (killed)` : `exit ${v.exitCode} in ${v.durationMs}ms`
        let out = `[${status}]`
        if (v.stdout) out += `\n--- stdout ---\n${v.stdout}`
        if (v.stderr) out += `\n--- stderr ---\n${v.stderr}`
        if (!v.stdout && !v.stderr) out += ' (no output)'
        return text(out)
      },
      presentationMeta: (_args, v) => ({ exitCode: v.exitCode, timedOut: v.timedOut }),
    },
    presentCall: (args) => ({ card: 'terminal', title: args.command, description: `microVM ${args.sandboxId}`, ...(args.cwd ? { cwd: args.cwd } : {}) }),
    presentResult: (_args, result) => {
      const body = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      const meta = /** @type {any} */ (result.meta)
      return {
        card: 'terminal',
        output: body,
        ...(meta && typeof meta.exitCode === 'number' ? { exitCode: meta.exitCode } : {}),
        ...(meta && meta.timedOut ? { signal: 'SIGKILL' } : {}),
      }
    },
    async execute(args, exec) {
      if (!args.command.trim()) throw new Error('command must not be empty')
      const timeoutMs = args.timeoutMs ?? config.execTimeoutMs
      if (!(timeoutMs > 0) || timeoutMs > config.maxExecTimeoutMs) {
        throw new Error(`timeoutMs must be between 1 and ${config.maxExecTimeoutMs}`)
      }
      const sb = manager.get(args.sandboxId)
      await manager.touch(sb)
      const r = await client.exec(sb, {
        command: args.command,
        cwd: args.cwd,
        envs: stringEnvs(args.envs),
        timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      }, exec.signal)
      return {
        sandboxId: sb.sandboxId,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.error ? `${r.stderr}${r.stderr ? '\n' : ''}${r.error}` : r.stderr,
        truncated: r.truncated,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
      }
    },
  }

  const readFile = {
    name: 'microvm_read_file',
    description: `Read a UTF-8 text file from a sandbox (up to ${config.maxReadBytes} bytes; larger files are cut off).`,
    parameters: {
      sandboxId: sandboxIdParam,
      path: { type: 'string', required: true, description: 'Absolute path inside the sandbox.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, v) => text(v.truncated ? `${v.content}\n…[cut off: file is ${v.bytes} bytes]` : v.content),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sb = manager.get(args.sandboxId)
      await manager.touch(sb)
      const r = await client.readFile(sb, args.path, config.maxReadBytes, exec.signal)
      return { path: args.path, ...r }
    },
  }

  const writeFile = {
    name: 'microvm_write_file',
    description: 'Write a text file inside a sandbox, creating parent directories and replacing any existing file.',
    parameters: {
      sandboxId: sandboxIdParam,
      path: { type: 'string', required: true, description: 'Absolute path inside the sandbox.' },
      content: { type: 'string', required: true, description: 'Full file content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true }, bytes: { type: 'integer', required: true } },
      },
      render: (_args, v) => text(`Wrote ${v.bytes} bytes to ${v.path}.`),
    },
    async execute(args, exec) {
      const sb = manager.get(args.sandboxId)
      await manager.touch(sb)
      const r = await client.writeFile(sb, args.path, args.content, exec.signal)
      return { path: args.path, bytes: r.bytes }
    },
  }

  const fork = {
    name: 'microvm_fork',
    description:
      'Clone a running sandbox, memory and disk included, into N independent copies. ' +
      'Use it to try several approaches from the same prepared state (deps installed, repo checked out) in parallel. ' +
      'Needs a backend with the fork endpoint (E2B, AgentENV).',
    parameters: {
      sandboxId: sandboxIdParam,
      count: { type: 'integer', description: `Number of copies (1-${config.maxForkCount}). Default 1.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          parentId: { type: 'string', required: true },
          children: { type: 'array', items: summarySchema, required: true },
          errors: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, v) => text(
        `Forked ${v.parentId} into ${v.children.length} sandbox(es): ${v.children.map((c) => c.sandboxId).join(', ') || 'none'}` +
        (v.errors.length ? `\n${v.errors.length} copy(ies) failed: ${v.errors.join('; ')}` : ''),
      ),
    },
    async execute(args, exec) {
      const count = args.count ?? 1
      if (!Number.isInteger(count) || count < 1 || count > config.maxForkCount) {
        throw new Error(`count must be an integer between 1 and ${config.maxForkCount}`)
      }
      const parent = manager.get(args.sandboxId)
      manager.assertCapacity(exec.agent, count)
      await manager.touch(parent)
      const results = await client.fork(parent.sandboxId, { count, timeoutSec: config.sandboxTimeoutSec }, exec.signal)
      const children = []
      const errors = []
      for (const r of results) {
        if ('error' in r) errors.push(r.error)
        else {
          const child = manager.track(exec.agent, r, { parentId: parent.sandboxId, label: parent.label })
          child.templateId ??= parent.templateId
          children.push(summary(child))
        }
      }
      if (children.length === 0) throw new Error(`fork failed: ${errors.join('; ') || 'no copies started'}`)
      return { parentId: parent.sandboxId, children, errors }
    },
  }

  const destroy = {
    name: 'microvm_destroy',
    description: 'Destroy a sandbox now and free its resources. Do this when you are done with it.',
    parameters: { sandboxId: sandboxIdParam },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sandboxId: { type: 'string', required: true }, destroyed: { type: 'boolean', required: true } },
      },
      render: (_args, v) => text(`Destroyed sandbox ${v.sandboxId}.`),
    },
    async execute(args) {
      await manager.destroy(args.sandboxId)
      return { sandboxId: args.sandboxId, destroyed: true }
    },
  }

  const list = {
    name: 'microvm_list',
    description: 'List the live sandboxes created in this session.',
    parameters: {},
    output: {
      schema: { type: 'array', items: summarySchema },
      render: (_args, v) => text(
        v.length === 0
          ? 'No live sandboxes.'
          : v.map((s) => `${s.sandboxId}${s.label ? ` [${s.label}]` : ''}${s.parentId ? ` (fork of ${s.parentId})` : ''} last used ${s.lastUsedAt}`).join('\n'),
      ),
    },
    isConcurrencySafe: () => true,
    async execute() {
      return [...manager.sandboxes.values()].map(summary)
    },
  }

  const tools = [create, execTool, readFile, writeFile, destroy, list]
  if (config.enableFork) tools.splice(4, 0, fork)
  return tools
}
