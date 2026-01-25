/**
 * Centralized state store for TUI.
 * State reads are pointer-based via .workbench/state/current.json
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * @typedef {'menu' | 'verify' | 'runner' | 'chat' | 'oauth'} TuiMode
 */

/**
 * @typedef {Object} VerifyGate
 * @property {string} name
 * @property {boolean} ok
 * @property {boolean} [skipped]
 * @property {string} at
 */

/**
 * @typedef {Object} RunnerStatus
 * @property {string} runId
 * @property {string} provider
 * @property {string[]} toolCallsSeen
 * @property {string|null} error
 */

/**
 * @typedef {Object} OAuthPool
 * @property {Object} profiles
 * @property {string} strategy
 * @property {string|null} pinned
 */

export class TuiState {
  constructor() {
    /** @type {TuiMode} */
    this.mode = "menu"
    /** @type {number} */
    this.menuIndex = 0
    /** @type {Map<string, {status: string, updatedAt: string}>} */
    this.workflows = new Map()
    /** @type {VerifyGate[]} */
    this.verifyGates = []
    /** @type {string|null} */
    this.verifyRunId = null
    /** @type {RunnerStatus|null} */
    this.runnerStatus = null
    /** @type {string|null} */
    this.runnerRunId = null
    /** @type {OAuthPool|null} */
    this.oauthPool = null
    /** @type {string|null} */
    this.lastError = null
    /** @type {string|null} */
    this.statusMessage = null
    /** @type {boolean} */
    this.running = false
    /** @type {Set<function(TuiState):void>} */
    this.listeners = new Set()
    /** @type {boolean} */
    this._resized = false
    /** @type {Object} */
    this.capabilities = {
      node: false,
      python3: false,
      tmux: false,
      docker: false,
      bun: false,
    }
  }

  /**
   * Subscribe to state changes
   * @param {function(TuiState):void} fn
   */
  subscribe(fn) {
    this.listeners.add(fn)
  }

  /**
   * Unsubscribe from state changes
   * @param {function(TuiState):void} fn
   */
  unsubscribe(fn) {
    this.listeners.delete(fn)
  }

  /**
   * Update state with partial object
   * @param {Partial<TuiState>} partial
   */
  update(partial) {
    Object.assign(this, partial)
    this.notify()
  }

  /**
   * Notify all listeners of state change
   */
  notify() {
    for (const fn of this.listeners) {
      try {
        fn(this)
      } catch (e) {
        // Ignore listener errors
      }
    }
  }
}

/**
 * Read JSON file safely
 * @param {string} path
 * @returns {Promise<any|null>}
 */
async function readJson(path) {
  try {
    if (!existsSync(path)) return null
    const content = await readFile(path, "utf8")
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * Aggregate state from .workbench/ directory using pointer-based reads
 * @param {TuiState} state
 * @param {string} baseDir
 */
export async function aggregateState(state, baseDir) {
  // 1. Read the pointer-of-truth
  const currentPath = join(baseDir, "state", "current.json")
  const current = await readJson(currentPath)

  // 2. Load verify summary from pointed runId
  if (current?.verifyRunId) {
    if (current.verifyRunId !== state.verifyRunId) {
      const summaryPath = join(baseDir, "verify", "gates", current.verifyRunId, "summary.json")
      const summary = await readJson(summaryPath)
      if (summary) {
        state.update({
          verifyRunId: current.verifyRunId,
          verifyGates: summary.gates || [],
        })
      }
    }
  }

  // 3. Load runner summary from pointed runId
  if (current?.runnerRunId) {
    if (current.runnerRunId !== state.runnerRunId) {
      const summaryPath = join(baseDir, "runs", current.runnerRunId, "summary.json")
      const summary = await readJson(summaryPath)
      if (summary) {
        state.update({
          runnerRunId: current.runnerRunId,
          runnerStatus: {
            runId: summary.runId,
            provider: summary.provider?.mode || "unknown",
            toolCallsSeen: summary.toolCallsSeen || [],
            error: summary.error || null,
          },
        })
      }
    }
  }

  // 4. Read OAuth pool (static path, no pointer needed)
  const poolPath = join(baseDir, "auth", "openai_codex_oauth_pool.json")
  const pool = await readJson(poolPath)
  if (pool) {
    state.update({
      oauthPool: {
        profiles: pool.profiles || {},
        strategy: pool.strategy || "sticky",
        pinned: pool.pinned || null,
      },
    })
  }
}

/**
 * Probe system capabilities
 * @param {TuiState} state
 */
export async function probeCapabilities(state) {
  const { spawn } = await import("node:child_process")

  const check = (cmd) =>
    new Promise((resolve) => {
      const p = spawn("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1 && echo yes || echo no`], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      let out = ""
      p.stdout.on("data", (d) => (out += d.toString("utf8")))
      p.on("close", () => resolve(out.trim() === "yes"))
    })

  const [node, python3, tmux, docker, bun] = await Promise.all([
    check("node"),
    check("python3"),
    check("tmux"),
    check("docker"),
    check("bun"),
  ])

  state.update({
    capabilities: { node, python3, tmux, docker, bun },
  })
}
