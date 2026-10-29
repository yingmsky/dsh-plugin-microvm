// Config defaults and resolution, kept import-free so tests can use it directly.
// The Schemastery schema DSH validates against lives in index.js and mirrors these.

export const defaults = Object.freeze({
  apiKey: '',
  apiUrl: '',
  domain: 'e2b.app',
  envdUrl: 'https://{port}-{sandboxId}.{domain}',
  envdPort: 49983,
  user: 'user',
  template: 'base',
  sandboxTimeoutSec: 600,
  autoPause: false,
  allowInternetAccess: true,
  execTimeoutMs: 120_000,
  maxExecTimeoutMs: 600_000,
  maxOutputBytes: 32_768,
  maxReadBytes: 262_144,
  maxSandboxesPerAgent: 4,
  maxForkCount: 8,
  enableFork: true,
  keepOnDispose: false,
  requestTimeoutMs: 60_000,
})

/** @typedef {typeof defaults} Config */
/** @typedef {Config & { apiUrl: string }} ResolvedConfig */

/**
 * Fill blanks from the environment the same way the E2B SDK does:
 * E2B_API_KEY, E2B_DOMAIN, E2B_API_URL (default https://api.<domain>).
 * @param {Partial<Config>} input
 * @param {Record<string, string | undefined>} [env]
 * @returns {ResolvedConfig}
 */
export function resolveConfig(input, env = process.env) {
  const c = { ...defaults, ...Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v !== undefined)) }
  c.apiKey ||= env.E2B_API_KEY ?? ''
  if (!input?.domain && env.E2B_DOMAIN) c.domain = env.E2B_DOMAIN
  c.apiUrl ||= env.E2B_API_URL || `https://api.${c.domain}`
  if (c.maxExecTimeoutMs < c.execTimeoutMs) c.maxExecTimeoutMs = c.execTimeoutMs
  return c
}
