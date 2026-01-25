#!/usr/bin/env node
/**
 * My LLM Workbench TUI
 * State-driven, frame-based rendering with tmux pane integration.
 *
 * Invariants:
 * 1. TUI pane stdout is exclusive - only this process writes to pane 0
 * 2. No output relaying via tmux - commands run directly in target panes
 * 3. State reads are pointer-based via .workbench/state/current.json
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"
import { emitKeypressEvents } from "node:readline"

import { TuiState, aggregateState, probeCapabilities } from "./state.js"
import { render, simpleHash, ANSI, MENU_ITEMS } from "./renderer.js"
import { ProcessManager, PANE } from "./process.js"

// ─── Configuration ───

const POLL_INTERVAL = 2000 // Reduced from 500ms - less aggressive polling prevents flicker during input

// ─── Globals ───

const state = new TuiState()
const pm = new ProcessManager(process.env.WORKBENCH_TMUX_SESSION || "workbench")

let lastRenderedHash = ""
let inputBuffer = ""
let pollTimer = null
let resizeTimer = null

// Coalesce multiple state updates into a single paint.
let renderScheduled = false

// ─── Helpers ───

function repoRoot() {
  return resolve(process.cwd())
}

function stateDir(root) {
  const env = (process.env.WORKBENCH_STATE_DIR ?? "").trim()
  return resolve(env || join(root, ".workbench"))
}

function getTermSize() {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  }
}

function latestSummaryFile(dir) {
  if (!existsSync(dir)) return null
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name))
  if (!entries.length) return null
  entries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const candidate = join(entries[0], "summary.json")
  return existsSync(candidate) ? candidate : null
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// ─── Chat Launch ───

/**
 * Launch the Ink-based Chat component
 * Temporarily suspends the ANSI TUI and runs the Ink chat
 */
async function launchInkChat() {
  // Show cursor, reset terminal
  process.stdout.write(ANSI.showCursor)
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false)
  }

  // Stop timers
  if (pollTimer) clearInterval(pollTimer)
  if (frameTimer) clearInterval(frameTimer)

  // Clear screen
  process.stdout.write(ANSI.clear)

  // Launch Ink chat process
  const { spawn } = await import("node:child_process")
  const chatProcess = spawn("bun", ["run", "ui/tui/chat-entry.jsx"], {
    stdio: "inherit",
    env: {
      ...process.env,
      WORKBENCH_PROVIDER: "openai-oauth",
    },
  })

  await new Promise((resolve) => {
    chatProcess.on("close", resolve)
    chatProcess.on("error", (err) => {
      console.error("Chat error:", err.message)
      resolve()
    })
  })

  // Restore TUI state
  process.stdout.write(ANSI.hideCursor)
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
  }

  // Restart timers
  pollTimer = setInterval(async () => {
    await pollState()
  }, POLL_INTERVAL)

  frameTimer = setInterval(() => {
    doRender()
  }, 1000 / FPS)

  // Force re-render
  lastRenderedHash = ""
  state.update({ mode: "menu" })
}

// ─── Rendering ───

function doRender() {
  const output = render(state, getTermSize())
  const hash = simpleHash(output)

  // Only write if content actually changed
  if (hash !== lastRenderedHash) {
    lastRenderedHash = hash
    process.stdout.write(output)
  }
}

function scheduleRender({ force = false } = {}) {
  if (force) lastRenderedHash = ""
  if (renderScheduled) return
  renderScheduled = true
  setImmediate(() => {
    renderScheduled = false
    doRender()
  })
}

// ─── State Aggregation ───

async function pollState() {
  const root = repoRoot()
  const base = stateDir(root)
  try {
    await aggregateState(state, base)
  } catch (e) {
    // Ignore polling errors
  }
}

// ─── Input Handling ───

function handleKeypress(str, key) {
  if (!key) return

  // Global: Ctrl+C exits
  if (key.ctrl && key.name === "c") {
    cleanup()
    process.exit(0)
  }

  if (state.running) {
    // While running, any key returns to menu
    if (key.name === "return" || key.name === "escape") {
      state.update({ mode: "menu", running: false, statusMessage: null })
    }
    return
  }

  if (state.mode !== "menu") {
    // In non-menu modes, Enter returns to menu
    if (key.name === "return" || key.name === "escape") {
      state.update({ mode: "menu", statusMessage: null })
    }
    return
  }

  // Menu mode: handle number/letter input
  if (key.name === "return") {
    handleMenuSelection(inputBuffer.trim().toLowerCase())
    inputBuffer = ""
    return
  }

  if (key.name === "backspace") {
    inputBuffer = inputBuffer.slice(0, -1)
    return
  }

  // Accumulate input
  if (str && /^[0-9a-z]$/i.test(str)) {
    inputBuffer += str
  }
}

async function handleMenuSelection(choice) {
  const root = repoRoot()
  const base = stateDir(root)

  if (choice === "q" || choice === "quit" || choice === "exit") {
    cleanup()
    process.exit(0)
  }

  // === Core ===
  if (choice === "1") {
    // Install
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runInstall()
      state.update({ mode: "runner", running: true, statusMessage: "Running install (pane 2)..." })
    } else {
      state.update({ mode: "runner", running: true, statusMessage: "Running install..." })
      await pm.runDirect("bash", ["scripts/install.sh", "--no-launch"])
      state.update({ running: false, statusMessage: "Install complete" })
    }
  } else if (choice === "2") {
    // Verify (fast)
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runVerifyFast()
      state.update({ mode: "verify", running: true, statusMessage: "Running verify (fast) in pane 3..." })
    } else {
      state.update({ mode: "verify", running: true, statusMessage: "Running verify (fast)..." })
      await pm.runDirect("node", ["verify/run.js"], { WORKBENCH_VERIFY_FAST: "1", WORKBENCH_SKIP_DOCKER: "1" })
      state.update({ running: false })
      await pollState()
    }
  } else if (choice === "3") {
    // Verify (full)
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runVerifyFull()
      state.update({ mode: "verify", running: true, statusMessage: "Running verify (full) in pane 3..." })
    } else {
      state.update({ mode: "verify", running: true, statusMessage: "Running verify (full)..." })
      await pm.runDirect("node", ["verify/run.js"])
      state.update({ running: false })
      await pollState()
    }
  } else if (choice === "4") {
    // Doctor
    await showDoctor()
  }

  // === OAuth Management ===
  else if (choice === "5") {
    // OAuth status view (profiles/rate limits)
    state.update({ mode: "oauth-status", running: false, statusMessage: null })
  } else if (choice === "6") {
    // OAuth login (browser)
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runOAuthLogin({ deviceCode: false })
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth login (browser) in pane 2..." })
    } else {
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth login (browser)..." })
      await pm.runDirect("python3", ["runner/auth/openai_oauth_login.py", "--pool"])
      state.update({ running: false })
    }
  } else if (choice === "7") {
    // OAuth login (device code)
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runOAuthLogin({ deviceCode: true })
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth login (device code) in pane 2..." })
    } else {
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth login (device code)..." })
      await pm.runDirect("python3", ["runner/auth/openai_oauth_login.py", "--pool", "--device-code"])
      state.update({ running: false })
    }
  } else if (choice === "8") {
    // OAuth sync (one-time)
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runOAuthSync(false)
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth sync in pane 2..." })
    } else {
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth sync..." })
      await pm.runDirect("python3", ["runner/auth/openai_oauth_sync.py"])
      state.update({ running: false })
    }
  } else if (choice === "9") {
    // OAuth sync (watch mode)
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runOAuthSync(true)
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth sync (watch) in pane 2..." })
    } else {
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth sync (watch)..." })
      await pm.runDirect("python3", ["runner/auth/openai_oauth_sync.py", "--watch"])
      state.update({ running: false })
    }
  } else if (choice === "10") {
    // OAuth pool manage - show list
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runOAuthManage("list")
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth manage list in pane 2..." })
    } else {
      state.update({ mode: "oauth", running: true, statusMessage: "OAuth manage list..." })
      await pm.runDirect("python3", ["runner/auth/openai_oauth_manage.py", "list"])
      state.update({ running: false })
    }
  }

  // === Runner/Chat ===
  else if (choice === "11") {
    // Runner smoke (mock)
    if (pm.hasTmux() && pm.hasSession()) {
      pm.runRunnerMock()
      state.update({ mode: "runner", running: true, statusMessage: "Running runner (mock) in pane 2..." })
    } else {
      state.update({ mode: "runner", running: true, statusMessage: "Running runner (mock)..." })
      await pm.runDirect("python3", ["runner/run_smoke.py"], { WORKBENCH_PROVIDER: "mock" })
      state.update({ running: false })
      await pollState()
    }
  } else if (choice === "12") {
    // Runner smoke (real Codex OAuth)
    if (pm.hasTmux() && pm.hasSession()) {
      // First sync, then run
      pm.triggerInPane(PANE.RUNNER, "python3 runner/auth/openai_oauth_sync.py && python3 runner/run_smoke.py", {
        WORKBENCH_PROVIDER: "openai-oauth",
      })
      state.update({ mode: "runner", running: true, statusMessage: "Running runner (real OAuth) in pane 2..." })
    } else {
      state.update({ mode: "runner", running: true, statusMessage: "Running runner (real OAuth)..." })
      await pm.runDirect("python3", ["runner/auth/openai_oauth_sync.py"])
      await pm.runDirect("python3", ["runner/run_smoke.py"], { WORKBENCH_PROVIDER: "openai-oauth" })
      state.update({ running: false })
      await pollState()
    }
  } else if (choice === "13") {
    // Chat (Codex) - launch Ink-based chat
    await launchInkChat()
  } else if (choice === "14") {
    // Verify (full) with Codex OAuth
    if (pm.hasTmux() && pm.hasSession()) {
      pm.triggerInPane(PANE.VERIFY, "python3 runner/auth/openai_oauth_sync.py && node verify/run.js", {
        WORKBENCH_PROVIDER: "openai-oauth",
        WORKBENCH_VERIFY_REAL_LLM: "1",
      })
      state.update({ mode: "verify", running: true, statusMessage: "Running verify (real OAuth) in pane 3..." })
    } else {
      state.update({ mode: "verify", running: true, statusMessage: "Running verify (real OAuth)..." })
      await pm.runDirect("python3", ["runner/auth/openai_oauth_sync.py"])
      await pm.runDirect("node", ["verify/run.js"], {
        WORKBENCH_PROVIDER: "openai-oauth",
        WORKBENCH_VERIFY_REAL_LLM: "1",
      })
      state.update({ running: false })
      await pollState()
    }
  }

  // === Info ===
  else if (choice === "15") {
    // Show latest verify summary
    await showLatestVerifySummary()
  } else {
    state.update({ lastError: `Unknown selection: ${choice}` })
  }
}

async function showDoctor() {
  const root = repoRoot()
  const base = stateDir(root)

  const { spawn } = await import("node:child_process")

  const which = (cmd) =>
    new Promise((resolve) => {
      const p = spawn("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1 && echo yes || echo no`], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      let out = ""
      p.stdout.on("data", (d) => (out += d.toString("utf8")))
      p.on("close", () => resolve(out.trim() === "yes"))
    })

  const [bun, node, python3, tmux, claude, docker, opencode] = await Promise.all([
    which("bun"),
    which("node"),
    which("python3"),
    which("tmux"),
    which("claude"),
    which("docker"),
    which("opencode"),
  ])

  const opencodeAuth = resolve(process.env.OPENCODE_AUTH_JSON ?? join(process.env.HOME ?? "", ".local/share/opencode/auth.json"))
  const workbenchPool = resolve(process.env.WORKBENCH_OPENAI_OAUTH_POOL_PATH ?? join(base, "auth/openai_codex_oauth_pool.json"))

  const info = {
    repoRoot: root,
    stateDir: base,
    has: { bun, node, python3, tmux, claude, docker, opencode },
    paths: {
      opencodeAuthJson: existsSync(opencodeAuth) ? opencodeAuth : null,
      workbenchOpenaiOauthPool: existsSync(workbenchPool) ? workbenchPool : null,
    },
  }

  // For doctor, we need to show full output - temporarily switch to direct mode
  console.log(ANSI.clear)
  console.log(JSON.stringify(info, null, 2))
  console.log("\nPress Enter to return to menu...")
  state.update({ mode: "menu", statusMessage: "Doctor output shown above" })
}

async function showLatestVerifySummary() {
  const root = repoRoot()
  const base = stateDir(root)
  const gatesDir = join(base, "verify", "gates")

  if (!existsSync(gatesDir)) {
    state.update({ lastError: "No verify results found" })
    return
  }

  // Find latest directory
  const entries = readdirSync(gatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(gatesDir, d.name))
  if (!entries.length) {
    state.update({ lastError: "No verify results found" })
    return
  }
  entries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const summaryPath = join(entries[0], "summary.json")

  if (!existsSync(summaryPath)) {
    state.update({ lastError: "No summary.json in latest verify run" })
    return
  }

  const content = readFileSync(summaryPath, "utf8")
  console.log(ANSI.clear)
  console.log(`[workbench-tui] ${summaryPath}`)
  console.log(content)
  console.log("\nPress Enter to return to menu...")
  state.update({ mode: "menu", statusMessage: "Verify summary shown above" })
}

// ─── Cleanup ───

function cleanup() {
  if (pollTimer) clearInterval(pollTimer)
  if (resizeTimer) clearTimeout(resizeTimer)

  // Show cursor
  process.stdout.write(ANSI.showCursor)

  // Reset terminal
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false)
  }
}

// ─── Main ───

async function main() {
  const args = new Set(process.argv.slice(2))

  // Doctor mode
  if (args.has("--doctor")) {
    await showDoctor()
    return
  }

  const root = repoRoot()
  const base = stateDir(root)

  // Hide cursor for cleaner rendering
  process.stdout.write(ANSI.hideCursor)

  // Probe capabilities
  await probeCapabilities(state)

  // Initial state load
  await pollState()

  // Render whenever state changes (event-driven; avoids FPS redraw noise).
  state.subscribe(() => scheduleRender())

  // Initial render
  scheduleRender({ force: true })

  // Start state polling (runs independently)
  pollTimer = setInterval(async () => {
    await pollState()
  }, POLL_INTERVAL)

  // Handle terminal resize
  process.stdout.on("resize", () => {
    // Debounce: terminals can emit many resize events while dragging.
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      scheduleRender({ force: true })
    }, 80)
  })

  // Setup raw mode for immediate key handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    emitKeypressEvents(process.stdin)

    process.stdin.on("keypress", (str, key) => {
      handleKeypress(str, key)
    })
  } else {
    // Non-TTY fallback: use readline
    const { createInterface } = await import("node:readline/promises")
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    console.log("(Non-interactive mode - enter commands)")

    while (true) {
      const choice = (await rl.question("Select: ")).trim().toLowerCase()
      if (choice === "q" || choice === "quit") break
      await handleMenuSelection(choice)
    }

    rl.close()
    cleanup()
  }
}

// Handle exit
process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})

process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})

process.on("exit", () => {
  cleanup()
})

main().catch((e) => {
  cleanup()
  console.error(String(e))
  process.exit(1)
})
