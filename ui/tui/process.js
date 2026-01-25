/**
 * ProcessManager for TUI.
 * Triggers commands in tmux panes - NEVER relays output.
 * Output is rendered by the pane's own process stdout.
 */

import { execSync, spawn } from "node:child_process"

/**
 * Pane assignments for the 3-pane layout:
 *   0: TUI (exclusive - never send commands here)
 *   1: Status pane (Ink-based live status - don't send commands here)
 *   2: Output shell (for runner/verify output)
 */
export const PANE = {
  TUI: 0, // Reserved - TUI exclusive
  STATUS: 1, // Reserved - Status pane exclusive
  OUTPUT: 2, // Output shell - runner/verify output goes here
  // Aliases for backwards compatibility
  RUNNER: 2,
  VERIFY: 2,
}

export class ProcessManager {
  /**
   * @param {string} sessionName
   */
  constructor(sessionName = "workbench") {
    this.session = sessionName
    this._tmuxAvailable = null
  }

  /**
   * Check if tmux is available
   * @returns {boolean}
   */
  hasTmux() {
    if (this._tmuxAvailable === null) {
      try {
        execSync("command -v tmux", { stdio: "ignore" })
        this._tmuxAvailable = true
      } catch {
        this._tmuxAvailable = false
      }
    }
    return this._tmuxAvailable
  }

  /**
   * Check if tmux session exists
   * @returns {boolean}
   */
  hasSession() {
    if (!this.hasTmux()) return false
    try {
      const server = (process.env.WORKBENCH_TMUX_SERVER || "").trim()
      const tmuxBin = server ? `tmux -L "${server}"` : "tmux"
      execSync(`${tmuxBin} has-session -t "${this.session}" 2>/dev/null`, { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }

  /**
   * Escape special characters for tmux send-keys
   * @param {string} str
   * @returns {string}
   */
  escape(str) {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")
  }

  /**
   * Send a command to a pane (trigger only, never relay output)
   * @param {number} pane - Pane number (1-3, NOT 0)
   * @param {string} command - Command to run
   * @param {Object} [env] - Environment variables to prepend
   */
  triggerInPane(pane, command, env = {}) {
    if (pane === PANE.TUI) {
      throw new Error("Cannot send commands to TUI pane (0)")
    }
    if (pane === PANE.STATUS) {
      throw new Error("Cannot send commands to STATUS pane (1)")
    }

    if (!this.hasTmux() || !this.hasSession()) {
      // Fallback: just log that we would have triggered this
      console.error(`[ProcessManager] No tmux session; would run in pane ${pane}: ${command}`)
      return
    }

    // Build env prefix if needed
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")

    // Build full command with optional env prefix
    const fullCmd = envPrefix ? `${envPrefix} ${command}` : command

    // Clear pane and run command
    const clearAndRun = `clear; ${fullCmd}`

    // Send to pane (this just triggers - output goes to pane's own stdout)
    const server = (process.env.WORKBENCH_TMUX_SERVER || "").trim()
    const tmuxBin = server ? `tmux -L "${server}"` : "tmux"
    const tmuxCmd = `${tmuxBin} send-keys -t "${this.session}:workbench.${pane}" "${this.escape(clearAndRun)}" Enter`
    try {
      execSync(tmuxCmd, { stdio: "ignore" })
    } catch (e) {
      console.error(`[ProcessManager] Failed to send to pane ${pane}: ${e.message}`)
    }
  }

  /**
   * Send Ctrl+C to interrupt a pane
   * @param {number} pane - Pane number (1-3)
   */
  interruptPane(pane) {
    if (pane === PANE.TUI) {
      throw new Error("Cannot interrupt TUI pane (0)")
    }

    if (!this.hasTmux() || !this.hasSession()) {
      return
    }

    try {
      const server = (process.env.WORKBENCH_TMUX_SERVER || "").trim()
      const tmuxBin = server ? `tmux -L "${server}"` : "tmux"
      execSync(`${tmuxBin} send-keys -t "${this.session}:workbench.${pane}" C-c`, { stdio: "ignore" })
    } catch (e) {
      console.error(`[ProcessManager] Failed to interrupt pane ${pane}: ${e.message}`)
    }
  }

  /**
   * Run verify (fast) in verify pane
   */
  runVerifyFast() {
    this.triggerInPane(PANE.VERIFY, "node verify/run.js", {
      WORKBENCH_VERIFY_FAST: "1",
      WORKBENCH_SKIP_DOCKER: "1",
    })
  }

  /**
   * Run verify (full) in verify pane
   */
  runVerifyFull() {
    this.triggerInPane(PANE.VERIFY, "node verify/run.js")
  }

  /**
   * Run verify with real LLM in verify pane
   */
  runVerifyRealLLM() {
    this.triggerInPane(PANE.VERIFY, "node verify/run.js", {
      WORKBENCH_PROVIDER: "openai-oauth",
      WORKBENCH_VERIFY_REAL_LLM: "1",
    })
  }

  /**
   * Run runner smoke (mock) in runner pane
   */
  runRunnerMock() {
    this.triggerInPane(PANE.RUNNER, "python3 runner/run_smoke.py", {
      WORKBENCH_PROVIDER: "mock",
    })
  }

  /**
   * Run runner smoke (real Codex OAuth) in runner pane
   */
  runRunnerReal() {
    this.triggerInPane(PANE.RUNNER, "python3 runner/run_smoke.py", {
      WORKBENCH_PROVIDER: "openai-oauth",
    })
  }

  /**
   * Run chat in runner pane
   * @param {string} provider - Provider mode
   */
  runChat(provider) {
    this.triggerInPane(PANE.RUNNER, "python3 runner/chat.py", {
      WORKBENCH_PROVIDER: provider,
    })
  }

  /**
   * Run OAuth login in runner pane
   * @param {Object} opts
   * @param {boolean} [opts.deviceCode]
   * @param {string} [opts.profile]
   */
  runOAuthLogin(opts = {}) {
    const args = ["runner/auth/openai_oauth_login.py", "--pool"]
    if (opts.deviceCode) args.push("--device-code")
    if (opts.profile) args.push("--profile", opts.profile)
    this.triggerInPane(PANE.RUNNER, `python3 ${args.join(" ")}`)
  }

  /**
   * Run OAuth sync in runner pane
   * @param {boolean} [watch]
   */
  runOAuthSync(watch = false) {
    const args = ["runner/auth/openai_oauth_sync.py"]
    if (watch) args.push("--watch")
    this.triggerInPane(PANE.RUNNER, `python3 ${args.join(" ")}`)
  }

  /**
   * Run OAuth manage command in runner pane
   * @param {string} action
   * @param {string[]} [args]
   */
  runOAuthManage(action, args = []) {
    const cmdArgs = ["runner/auth/openai_oauth_manage.py", action, ...args]
    this.triggerInPane(PANE.RUNNER, `python3 ${cmdArgs.join(" ")}`)
  }

  /**
   * Run install script in runner pane
   */
  runInstall() {
    this.triggerInPane(PANE.RUNNER, "bash scripts/install.sh --no-launch")
  }

  /**
   * Run a local/direct command without tmux (for single-pane mode)
   * @param {string} cmd
   * @param {string[]} args
   * @param {Object} [envOverrides]
   * @returns {Promise<number>} - Exit code
   */
  runDirect(cmd, args, envOverrides = {}) {
    const env = { ...process.env, ...envOverrides }
    return new Promise((resolve) => {
      const p = spawn(cmd, args, {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
      })
      p.on("close", (code) => resolve(code ?? 1))
    })
  }
}
