// Tracks which sandboxes this plugin created, for which agent, and cleans them up.
//
// Only sandboxes created through this plugin instance can be addressed by the
// model; an id from elsewhere on the same account is rejected. That keeps one
// agent from driving (or killing) sandboxes it doesn't own.

import { E2BError } from './e2b.js'

const GLOBAL_OWNER = Symbol('dsh-plugin-microvm/global-owner')

/**
 * @typedef {import('./e2b.js').SandboxHandle & {
 *   owner: unknown, createdAt: number, lastUsedAt: number, parentId?: string, label?: string
 * }} TrackedSandbox
 */

export class SandboxManager {
  /**
   * @param {import('./e2b.js').E2BClient} client
   * @param {{ maxSandboxesPerAgent: number, sandboxTimeoutSec: number, logger?: { warn(...a: unknown[]): void } }} config
   */
  constructor(client, config) {
    this.client = client
    this.config = config
    /** @type {Map<string, TrackedSandbox>} */
    this.sandboxes = new Map()
  }

  /** @param {unknown} agent */
  ownerKey(agent) {
    return agent ?? GLOBAL_OWNER
  }

  /** @param {unknown} agent */
  ownedBy(agent) {
    const key = this.ownerKey(agent)
    return [...this.sandboxes.values()].filter((s) => s.owner === key)
  }

  /** @param {unknown} agent @param {number} adding */
  assertCapacity(agent, adding) {
    const have = this.ownedBy(agent).length
    if (have + adding > this.config.maxSandboxesPerAgent) {
      throw new E2BError(
        `sandbox limit reached: this agent has ${have} live sandbox(es), limit is ${this.config.maxSandboxesPerAgent}. ` +
        'Destroy one with microvm_destroy first.',
      )
    }
  }

  /**
   * @param {unknown} agent
   * @param {import('./e2b.js').SandboxHandle} handle
   * @param {{ parentId?: string, label?: string }} [extra]
   */
  track(agent, handle, extra = {}) {
    const now = Date.now()
    /** @type {TrackedSandbox} */
    const entry = { ...handle, owner: this.ownerKey(agent), createdAt: now, lastUsedAt: now, ...extra }
    this.sandboxes.set(handle.sandboxId, entry)
    return entry
  }

  /**
   * Look up a sandbox the calling agent may use. Subagents and the parent agent are
   * distinct owners in DSH; to let a parent hand a sandbox to a subagent, ownership
   * is checked per plugin instance rather than per agent.
   * @param {string} sandboxId
   */
  get(sandboxId) {
    const sb = this.sandboxes.get(sandboxId)
    if (!sb) {
      throw new E2BError(
        `unknown sandbox "${sandboxId}". Only sandboxes created with microvm_create or microvm_fork in this session can be used; ` +
        'call microvm_list to see them.',
      )
    }
    return sb
  }

  /**
   * Mark a sandbox as used and push its auto-kill deadline out (best effort).
   * @param {TrackedSandbox} sb
   */
  async touch(sb) {
    sb.lastUsedAt = Date.now()
    try {
      await this.client.setTimeout(sb.sandboxId, this.config.sandboxTimeoutSec)
    } catch (err) {
      if (err instanceof E2BError && err.status === 404) {
        this.sandboxes.delete(sb.sandboxId)
        throw new E2BError(`sandbox "${sb.sandboxId}" no longer exists (it timed out or was killed). Create a new one.`, { status: 404 })
      }
      // Other failures (e.g. a backend without the timeout endpoint) are non-fatal.
    }
  }

  /** @param {string} sandboxId */
  async destroy(sandboxId) {
    const sb = this.get(sandboxId)
    await this.client.kill(sb.sandboxId)
    this.sandboxes.delete(sb.sandboxId)
  }

  /**
   * Kill every sandbox matching `filter`. Never throws; returns the ids that failed.
   * @param {(sb: TrackedSandbox) => boolean} filter
   */
  async destroyWhere(filter) {
    const victims = [...this.sandboxes.values()].filter(filter)
    const results = await Promise.allSettled(victims.map((sb) => this.client.kill(sb.sandboxId)))
    /** @type {string[]} */ const failed = []
    results.forEach((r, i) => {
      const id = victims[i].sandboxId
      if (r.status === 'fulfilled') this.sandboxes.delete(id)
      else {
        failed.push(id)
        this.config.logger?.warn(`[microvm] failed to destroy sandbox ${id}:`, r.reason)
      }
    })
    return failed
  }

  /** @param {unknown} agent */
  destroyOwnedBy(agent) {
    const key = this.ownerKey(agent)
    return this.destroyWhere((sb) => sb.owner === key)
  }

  destroyAll() {
    return this.destroyWhere(() => true)
  }
}
