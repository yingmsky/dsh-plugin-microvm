// dsh-plugin-microvm: disposable microVM sandbox tools for DeepSeek Harness.
//
// Registers microvm_* tools backed by any E2B-compatible API (E2B cloud,
// self-hosted E2B, AgentENV). Sandboxes are tracked per agent, refreshed on use,
// and destroyed when their agent is disposed or the plugin unloads.

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { E2BClient } from './e2b.js'
import { SandboxManager } from './manager.js'
import { buildTools } from './tools.js'
import { defaults, resolveConfig } from './config.js'

export const name = 'dsh-plugin-microvm'
export const inject = ['tools']

export const Config = Schema.object({
  apiKey: Schema.string().role('secret').default(defaults.apiKey)
    .description('API key sent as X-API-Key. Empty: read E2B_API_KEY from the environment.'),
  apiUrl: Schema.string().default(defaults.apiUrl)
    .description('Control-plane URL. Empty: E2B_API_URL, else https://api.<domain>. AgentENV: http://127.0.0.1:8000'),
  domain: Schema.string().default(defaults.domain)
    .description('Sandbox domain used when the API response does not name one.'),
  envdUrl: Schema.string().default(defaults.envdUrl)
    .description('envd base URL template; {port}, {sandboxId}, {domain} are substituted.'),
  envdPort: Schema.natural().default(defaults.envdPort).description('envd port inside the sandbox.'),
  user: Schema.string().default(defaults.user).description('Sandbox user for commands and files. Empty: envd default.'),
  template: Schema.string().default(defaults.template).description('Default sandbox template.'),
  sandboxTimeoutSec: Schema.natural().min(30).default(defaults.sandboxTimeoutSec)
    .description('Idle TTL: a sandbox is killed this long after its last use.'),
  autoPause: Schema.boolean().default(defaults.autoPause)
    .description('Pause instead of kill on TTL. Sent explicitly because AgentENV defaults it to true.'),
  allowInternetAccess: Schema.boolean().default(defaults.allowInternetAccess),
  execTimeoutMs: Schema.natural().min(1000).default(defaults.execTimeoutMs),
  maxExecTimeoutMs: Schema.natural().min(1000).default(defaults.maxExecTimeoutMs),
  maxOutputBytes: Schema.natural().min(1024).default(defaults.maxOutputBytes)
    .description('Per-stream cap for stdout/stderr returned to the model (head + tail kept).'),
  maxReadBytes: Schema.natural().min(1024).default(defaults.maxReadBytes),
  maxSandboxesPerAgent: Schema.natural().min(1).default(defaults.maxSandboxesPerAgent),
  maxForkCount: Schema.natural().min(1).max(16).default(defaults.maxForkCount),
  enableFork: Schema.boolean().default(defaults.enableFork),
  keepOnDispose: Schema.boolean().default(defaults.keepOnDispose)
    .description('Leave sandboxes running when the plugin unloads (they still die at their TTL).'),
  requestTimeoutMs: Schema.natural().min(1000).default(defaults.requestTimeoutMs),
})

/**
 * @param {any} ctx Cordis context
 * @param {Partial<import('./config.js').Config>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger && typeof ctx.logger.warn === 'function' ? ctx.logger : console
  if (!config.apiKey) {
    logger.warn('[microvm] no API key configured (config.apiKey or E2B_API_KEY); sandbox calls will be rejected by the API')
  }

  const client = new E2BClient(config)
  const manager = new SandboxManager(client, { ...config, logger })

  for (const spec of buildTools(manager, config)) {
    ctx.tools.register(defineTool(spec))
  }

  // An agent's sandboxes die with it.
  ctx.on('agent/disposed', ({ agent }) => {
    void manager.destroyOwnedBy(agent)
  })

  // Plugin unload / HMR config change: clean up everything we started.
  ctx.effect(() => () => {
    if (!config.keepOnDispose) void manager.destroyAll()
  })
}
