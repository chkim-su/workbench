#!/usr/bin/env node
/**
 * Host-side system executor for the Go TUI.
 *
 * Purpose:
 * - The Go Bubble Tea TUI may run inside Docker; it cannot directly run host tools.
 * - This executor runs side-effecting system actions on the host and reports results via JSONL.
 *
 * Contract:
 * - Reads requests from:  <stateDir>/<sessionId>/system.requests.jsonl
 * - Writes results to:   <stateDir>/<sessionId>/system.responses.jsonl
 * - Heartbeat file:      <stateDir>/<sessionId>/system.executor.json (mtime indicates readiness)
 * - Artifacts root:      <stateDir>/<sessionId>/system/
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { StdioJsonRpcClient } from "../../mcp/kit/src/stdio-client.js"

function parseArgs(argv) {
  const out = { stateDir: null, repoRoot: process.cwd() }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--state-dir") out.stateDir = argv[++i]
    else if (a === "--repo-root") out.repoRoot = argv[++i]
  }
  return out
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"))
}

function writeJson(p, obj, mode = 0o644) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode })
}

function appendJsonl(p, obj, mode = 0o644) {
  ensureDir(path.dirname(p))
  fs.appendFileSync(p, JSON.stringify(obj) + "\n", { encoding: "utf8", mode })
}

function nowIso() {
  return new Date().toISOString()
}

function randomSessionId() {
  return `sess_${crypto.randomBytes(4).toString("hex")}`
}

function readCurrentSessionId(stateDir) {
  const currentPath = path.join(stateDir, "state", "current.json")
  ensureDir(path.dirname(currentPath))
  let cur = { schemaVersion: 1 }
  if (fs.existsSync(currentPath)) {
    try {
      cur = readJson(currentPath)
    } catch {}
  }
  if (typeof cur.sessionId === "string" && cur.sessionId.trim()) return cur.sessionId.trim()
  return ""
}

function ensureSessionId(stateDir) {
  const existing = readCurrentSessionId(stateDir)
  if (existing) return existing
  const currentPath = path.join(stateDir, "state", "current.json")
  ensureDir(path.dirname(currentPath))
  const cur = { schemaVersion: 1, sessionId: randomSessionId(), updatedAt: nowIso() }
  writeJson(currentPath, cur, 0o644)
  return cur.sessionId
}

function safeName(s) {
  return String(s ?? "")
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80)
}

function hasCommand(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" })
  return !r.error
}

function tmuxBinArgs(server) {
  const s = String(server ?? "").trim()
  return s ? ["-L", s] : []
}

function runTmuxSync(server, args, opts = {}) {
  return spawnSync("tmux", [...tmuxBinArgs(server), ...args], {
    timeout: opts.timeout ?? 10_000,
    encoding: "utf8",
  })
}

// Pane slot definitions for the Workbench layout
// Indices match the expected pane positions in tmux_start.sh
const PANE_SLOTS = [
  { index: 0, role: 'main', defaultSurface: 'workbench-ink' },
  { index: 1, role: 'docker', defaultSurface: 'workbench-docker' },
  { index: 2, role: 'status', defaultSurface: 'workbench-status' },
  { index: 3, role: 'command', defaultSurface: 'workbench-command' },
]

function listTmuxPanes(server, session, windowName) {
  const fmt = "#{pane_id}|#{pane_index}|#{pane_title}|#{pane_current_command}|#{@workbench_pane_role}|#{@workbench_surface}"
  const out = runTmuxSync(server, ["list-panes", "-t", `${session}:${windowName}`, "-F", fmt])
  if (out.status !== 0) return []
  return String(out.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId, idx, title, cmd, role, surface] = line.split("|")
      return {
        paneId: (paneId || "").trim(),
        paneIndex: Number.parseInt(idx, 10),
        title: (title || "").trim(),
        command: (cmd || "").trim(),
        role: (role || "").trim(),
        surface: (surface || "").trim(),
      }
    })
    .filter((p) => p.paneId && Number.isFinite(p.paneIndex))
}

/**
 * Get pane slots as a fixed-size array.
 * Missing/closed panes are represented as null to preserve slot positions.
 * @param {string} server - tmux server name
 * @param {string} session - tmux session name
 * @param {string} windowName - tmux window name
 * @returns {Array<Object|null>} Array where each index corresponds to a pane slot
 */
function getPaneSlots(server, session, windowName) {
  const activePanes = listTmuxPanes(server, session, windowName)

  return PANE_SLOTS.map(slot => {
    // Find pane by role (preferred) or by index
    const pane = activePanes.find(p => p.role === slot.role) ||
                 activePanes.find(p => p.paneIndex === slot.index)

    if (pane) {
      return {
        ...pane,
        slotIndex: slot.index,
        expectedRole: slot.role,
        active: true,
      }
    }

    // Slot is empty (pane was closed)
    return null
  })
}

/**
 * Get pane status summary including empty slots
 * @param {string} server - tmux server name
 * @param {string} session - tmux session name
 * @param {string} windowName - tmux window name
 * @returns {Object} Status summary
 */
function getPaneStatus(server, session, windowName) {
  const slots = getPaneSlots(server, session, windowName)
  const active = slots.filter(Boolean)
  const empty = slots.map((s, i) => s === null ? i : null).filter(i => i !== null)

  return {
    slots,
    activeCount: active.length,
    totalSlots: PANE_SLOTS.length,
    emptySlots: empty,
    hasMain: slots[0] !== null,
    hasDocker: slots[1] !== null,
    hasStatus: slots[2] !== null,
    hasCommand: slots[3] !== null,
  }
}

function safeTmuxPaneLabel(s) {
  return String(s ?? "")
    .trim()
    .replaceAll(/[\r\n\t]+/g, " ")
    .slice(0, 80)
}

function pickPoolProfile(pool, preferredName) {
  const profiles = pool?.profiles ?? {}
  const preferred = String(preferredName ?? "").trim()
  if (preferred && profiles[preferred]) return profiles[preferred]
  const sel = pool?.selection?.lastUsedProfile
  if (sel && profiles[sel]) return profiles[sel]
  const keys = Object.keys(profiles)
  if (keys.length) return profiles[keys[0]]
  return null
}

function writeCodexAuthFromPool({ stateDir, profileName }) {
  const poolPath = path.join(stateDir, "auth", "openai_codex_oauth_pool.json")
  const pool = fs.existsSync(poolPath) ? readJson(poolPath) : null
  const profile = pickPoolProfile(pool, profileName)
  if (!profile) throw new Error(`OAuth pool missing/empty: ${poolPath}`)
  if (!profile.accessToken || !profile.refreshToken || !profile.accountId) {
    throw new Error("OAuth pool profile missing accessToken/refreshToken/accountId")
  }

  const codexHomeDir = path.join(stateDir, "codex_home")
  ensureDir(path.join(codexHomeDir, ".codex"))
  const authPath = path.join(codexHomeDir, ".codex", "auth.json")
  const auth = {
    tokens: {
      id_token: profile.accessToken,
      access_token: profile.accessToken,
      refresh_token: profile.refreshToken,
      account_id: profile.accountId,
    },
    last_refresh: nowIso(),
  }
  writeJson(authPath, auth, 0o600)
  return { codexHomeDir, authPath, poolPath, profileName: profile.profile ?? null }
}

/**
 * Find the next available profile for OAuth swap.
 * Excludes the current profile and any rate-limited profiles.
 * Returns the profile with the lowest usage percentage.
 */
function findNextAvailableProfile(pool, currentProfileName) {
  const profiles = pool?.profiles ?? {}
  const now = Date.now()

  // Filter out current profile and rate-limited/disabled profiles
  const candidates = Object.entries(profiles)
    .filter(([name, profile]) => {
      if (name === currentProfileName) return false
      if (profile.disabled || profile.enabled === false) return false
      if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > now) return false
      if (profile.expiresAtMs && profile.expiresAtMs < now) return false
      if (!profile.accessToken || !profile.refreshToken) return false
      return true
    })
    .map(([name, profile]) => ({ name, profile }))

  if (candidates.length === 0) return null

  // Sort by lowest usage (if usage data is available, prefer profiles with lower usage)
  // For now, just return the first available candidate
  // In the future, we could integrate with usageFetcher to get real usage data
  return candidates[0]
}

/**
 * Update the OAuth pool selection after a swap
 */
function updatePoolSelection(stateDir, profileName) {
  const poolPath = path.join(stateDir, "auth", "openai_codex_oauth_pool.json")
  if (!fs.existsSync(poolPath)) return false

  const pool = readJson(poolPath)
  if (!pool.selection) pool.selection = {}
  pool.selection.lastUsedProfile = profileName
  pool.updatedAt = nowIso()
  writeJson(poolPath, pool, 0o600)
  return true
}

/**
 * Perform a graceful Codex OAuth swap:
 * 1. Select next available profile
 * 2. Update auth.json with new profile's tokens
 * 3. Restart Codex with `codex resume --last` to continue the session
 */
async function runCodexSwap({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()

  const tmuxServer = String(request?.tmuxServer || process.env.WORKBENCH_TMUX_SERVER || "workbench").trim() || "workbench"
  const tmuxSession = String(request?.tmuxSession || process.env.WORKBENCH_TMUX_SESSION || "workbench").trim() || "workbench"
  const windowName = String(request?.window || "control").trim() || "control"
  const paneRole = String(request?.paneRole || "main").trim() || "main"

  // Load OAuth pool
  const poolPath = path.join(stateDir, "auth", "openai_codex_oauth_pool.json")
  if (!fs.existsSync(poolPath)) {
    return {
      ok: false,
      action: "codex.swap",
      summary: "oauth_pool_not_found",
      detail: `OAuth pool not found at ${poolPath}`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const pool = readJson(poolPath)
  const currentProfile = pool?.selection?.lastUsedProfile || null

  // Find next available profile
  const nextCandidate = request?.targetProfile
    ? { name: request.targetProfile, profile: pool.profiles?.[request.targetProfile] }
    : findNextAvailableProfile(pool, currentProfile)

  if (!nextCandidate || !nextCandidate.profile) {
    return {
      ok: false,
      action: "codex.swap",
      summary: "no_available_profiles",
      detail: `No available profiles to swap to. Current: ${currentProfile || "(none)"}`,
      artifacts: { poolPath },
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const nextProfileName = nextCandidate.name

  // Check tmux session
  if (!hasCommand("tmux")) {
    return {
      ok: false,
      action: "codex.swap",
      summary: "tmux_not_found",
      detail: "tmux CLI is not installed or not in PATH.",
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const has = runTmuxSync(tmuxServer, ["has-session", "-t", tmuxSession])
  if (has.status !== 0) {
    return {
      ok: false,
      action: "codex.swap",
      summary: "tmux_session_not_found",
      detail: `tmux session "${tmuxSession}" not found on server "${tmuxServer}"`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: has.status,
      cancelled: false,
    }
  }

  // Find target pane
  const panes = listTmuxPanes(tmuxServer, tmuxSession, windowName)
  const targetPane = panes.find((p) => p.role === paneRole) || panes.find((p) => p.paneIndex === 0) || null

  if (!targetPane) {
    return {
      ok: false,
      action: "codex.swap",
      summary: "target_pane_not_found",
      detail: `Unable to locate pane role "${paneRole}" in ${tmuxSession}:${windowName}`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  // Write new auth.json
  const { codexHomeDir, authPath } = writeCodexAuthFromPool({
    stateDir,
    profileName: nextProfileName,
  })

  // Update pool selection
  updatePoolSelection(stateDir, nextProfileName)

  // Build the swap command with graceful message and resume
  const cwd = request?.cwd || repoRoot
  const swapMessage = `🔄 Swapping OAuth account: ${currentProfile || "(unknown)"} → ${nextProfileName}...`
  const shellCmd = [
    `echo "${swapMessage}"`,
    `sleep 1`,
    `cd "${cwd.replaceAll('"', '\\"')}"`,
    `exec codex resume --last`,
  ].join(" && ")

  // Respawn the pane with the swap command
  const respawn = await runCommandAction({
    repoRoot,
    stateDir,
    sessionDir,
    action: "codex.swap",
    request: {
      ...request,
      fromProfile: currentProfile,
      toProfile: nextProfileName,
    },
    cmd: "tmux",
    args: [
      ...tmuxBinArgs(tmuxServer),
      "respawn-pane",
      "-k",
      "-t",
      targetPane.paneId,
      "env",
      `HOME=${codexHomeDir}`,
      "bash",
      "-lc",
      shellCmd,
    ],
    env: {},
    meta: {
      swap: {
        fromProfile: currentProfile,
        toProfile: nextProfileName,
        codexHomeDir,
        authPath,
        poolPath,
      },
      tmux: { server: tmuxServer, session: tmuxSession, window: windowName, paneRole, paneId: targetPane.paneId },
      cwd,
    },
  })

  // Update pane title
  try {
    runTmuxSync(tmuxServer, ["select-pane", "-t", targetPane.paneId, "-T", `codex [${nextProfileName}]`], { timeout: 5_000 })
  } catch {}

  return {
    ...respawn,
    summary: respawn.ok
      ? `swap_ok: ${currentProfile || "(none)"} → ${nextProfileName}`
      : `swap_failed: ${respawn.summary}`,
    detail: respawn.ok
      ? `Successfully swapped from ${currentProfile || "(none)"} to ${nextProfileName}. Codex resumed.`
      : respawn.detail,
    swap: {
      fromProfile: currentProfile,
      toProfile: nextProfileName,
    },
  }
}

async function runCommandAction({ repoRoot, stateDir, sessionDir, action, request, cmd, args, env = {}, meta = {} }) {
  const startedAt = nowIso()
  const safeAction = safeName(action)
  const runId = `${safeAction}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", safeAction, runId)
  ensureDir(runDir)

  const stdoutPath = path.join(runDir, "stdout.txt")
  const stderrPath = path.join(runDir, "stderr.txt")
  const metaPath = path.join(runDir, "meta.json")

  writeJson(
    metaPath,
    { version: 1, action, startedAt, cwd: repoRoot, request: request ?? null, ...meta },
    0o644,
  )

  let proc = null
  try {
    proc = spawn(cmd, args, {
      cwd: repoRoot,
      env: { ...process.env, WORKBENCH_STATE_DIR: stateDir, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e) {
    const endedAt = nowIso()
    return {
      ok: false,
      action,
      summary: `${safeAction}.spawn_failed`,
      detail: String(e?.message || e),
      artifacts: { runDir, stdout: stdoutPath, stderr: stderrPath, meta: metaPath },
      startedAt,
      endedAt,
      exitCode: null,
      cancelled: false,
    }
  }

  const outFd = fs.openSync(stdoutPath, "a")
  const errFd = fs.openSync(stderrPath, "a")
  proc.stdout.on("data", (d) => fs.writeSync(outFd, d))
  proc.stderr.on("data", (d) => fs.writeSync(errFd, d))

  const code = await new Promise((resolve) => proc.on("close", resolve))
  try {
    fs.closeSync(outFd)
    fs.closeSync(errFd)
  } catch {}

  const endedAt = nowIso()
  const ok = code === 0
  return {
    ok,
    action,
    summary: ok ? `${safeAction}.ok` : `${safeAction}.failed(exitCode=${code ?? "?"})`,
    detail: "",
    artifacts: { runDir, stdout: stdoutPath, stderr: stderrPath, meta: metaPath },
    startedAt,
    endedAt,
    exitCode: code ?? null,
    cancelled: false,
  }
}

async function runOAuthSync({ repoRoot, stateDir, sessionDir, request }) {
  const watch = !!request?.watch
  const args = ["runner/auth/openai_oauth_sync.py"]
  if (watch) args.push("--watch")
  return runCommandAction({
    repoRoot,
    stateDir,
    sessionDir,
    action: "oauth.sync",
    request,
    cmd: "python3",
    args,
    meta: { watch },
  })
}

async function runRunnerSmoke({ repoRoot, stateDir, sessionDir, request }) {
  const provider = String(request?.provider || "mock").trim() || "mock"
  const syncOAuth = request?.syncOAuth !== false && provider === "openai-oauth"

  if (syncOAuth) {
    const sync = await runOAuthSync({ repoRoot, stateDir, sessionDir, request: { watch: false } })
    if (!sync.ok) {
      return {
        ok: false,
        action: "runner.smoke",
        summary: "oauth.sync.failed",
        detail: sync.summary,
        artifacts: { oauthSync: sync.artifacts },
        startedAt: sync.startedAt,
        endedAt: sync.endedAt,
        exitCode: sync.exitCode ?? null,
        cancelled: false,
      }
    }
  }

  const result = await runCommandAction({
    repoRoot,
    stateDir,
    sessionDir,
    action: "runner.smoke",
    request,
    cmd: "python3",
    args: ["runner/run_smoke.py"],
    env: { WORKBENCH_PROVIDER: provider },
    meta: { provider, syncOAuth },
  })
  return result
}

async function runInstall({ repoRoot, stateDir, sessionDir, request }) {
  return runCommandAction({
    repoRoot,
    stateDir,
    sessionDir,
    action: "install",
    request,
    cmd: "bash",
    args: ["scripts/install.sh", "--no-launch"],
  })
}

async function runSurfaceLaunch({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()

  const tmuxServer = String(request?.tmuxServer || process.env.WORKBENCH_TMUX_SERVER || "workbench").trim() || "workbench"
  const tmuxSession = String(request?.tmuxSession || process.env.WORKBENCH_TMUX_SESSION || "workbench").trim() || "workbench"
  const windowName = String(request?.window || "control").trim() || "control"
  const paneRole = String(request?.paneRole || "main").trim() || "main"

  const surface = String(request?.surface || "").trim()
  const cwd = String(request?.cwd || repoRoot).trim() || repoRoot
  const title = safeTmuxPaneLabel(request?.title || surface || "surface")

  if (!hasCommand("tmux")) {
    return {
      ok: false,
      action: "surface.launch",
      summary: "tmux not found",
      detail: "tmux CLI is not installed or not in PATH.",
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const has = runTmuxSync(tmuxServer, ["has-session", "-t", tmuxSession])
  if (has.status !== 0) {
    return {
      ok: false,
      action: "surface.launch",
      summary: "tmux session not found",
      detail: `tmux session "${tmuxSession}" not found on server "${tmuxServer}"`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: has.status,
      cancelled: false,
    }
  }

  const panes = listTmuxPanes(tmuxServer, tmuxSession, windowName)
  const targetPane =
    panes.find((p) => p.role === paneRole) ||
    panes.find((p) => p.paneIndex === 0) ||
    null

  if (!targetPane) {
    return {
      ok: false,
      action: "surface.launch",
      summary: "target pane not found",
      detail: `Unable to locate pane role "${paneRole}" in ${tmuxSession}:${windowName}`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  let shellCmd = ""
  let launchPrefixArgs = []

  if (surface === "claude-code") {
    shellCmd = `cd "${cwd.replaceAll('"', '\\"')}" && exec claude`
  } else if (surface === "codex") {
    const syncOAuth = request?.syncOAuth !== false
    if (syncOAuth) {
      const sync = await runOAuthSync({ repoRoot, stateDir, sessionDir, request: { watch: false } })
      if (!sync.ok) {
        return {
          ok: false,
          action: "surface.launch",
          summary: "oauth.sync.failed",
          detail: sync.summary,
          artifacts: { oauthSync: sync.artifacts },
          startedAt: sync.startedAt,
          endedAt: sync.endedAt,
          exitCode: sync.exitCode ?? null,
          cancelled: false,
        }
      }
    }

    const { codexHomeDir, poolPath, profileName } = writeCodexAuthFromPool({
      stateDir,
      profileName: request?.profileName,
    })
    launchPrefixArgs = ["env", `HOME=${codexHomeDir}`]
    shellCmd = `cd "${cwd.replaceAll('"', '\\"')}" && exec codex`
    // Avoid leaking tokens; only include pool metadata.
    request = { ...request, codex: { poolPath, profileName, syncOAuth } }
  } else if (surface === "bash") {
    shellCmd = `cd "${cwd.replaceAll('"', '\\"')}" && exec bash`
  } else if (surface === "workbench-ink") {
    // Restore the Workbench managed surface in a pane (keeps control-plane available even after replacing it).
    const rootEsc = repoRoot.replaceAll('"', '\\"')
    const stateEsc = stateDir.replaceAll('"', '\\"')
    const serverEsc = tmuxServer.replaceAll('"', '\\"')
    const sessEsc = tmuxSession.replaceAll('"', '\\"')
    shellCmd = `cd "${rootEsc}" && WORKBENCH_STATE_DIR="${stateEsc}" WORKBENCH_REPO_ROOT="${rootEsc}" WORKBENCH_TMUX_SERVER="${serverEsc}" WORKBENCH_TMUX_SESSION="${sessEsc}" exec bun ui/tui/ink-entry.js`
  } else {
    return {
      ok: false,
      action: "surface.launch",
      summary: "unknown surface",
      detail: `Unknown surface: ${surface || "(empty)"}`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const respawn = await runCommandAction({
    repoRoot,
    stateDir,
    sessionDir,
    action: "surface.launch",
    request,
    cmd: "tmux",
    args: [
      ...tmuxBinArgs(tmuxServer),
      "respawn-pane",
      "-k",
      "-t",
      targetPane.paneId,
      ...launchPrefixArgs,
      "bash",
      "-lc",
      shellCmd,
    ],
    env: {},
    meta: {
      surface,
      tmux: { server: tmuxServer, session: tmuxSession, window: windowName, paneRole, paneId: targetPane.paneId },
      title,
      cwd,
    },
  })

  try {
    runTmuxSync(tmuxServer, ["select-pane", "-t", targetPane.paneId, "-T", title], { timeout: 5_000 })
    runTmuxSync(tmuxServer, ["set-option", "-pt", targetPane.paneId, "@workbench_surface", surface], { timeout: 5_000 })
  } catch {}

  return respawn
}

async function runPaneCapture({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()

  const tmuxServer = String(request?.tmuxServer || process.env.WORKBENCH_TMUX_SERVER || "workbench").trim() || "workbench"
  const tmuxSession = String(request?.tmuxSession || process.env.WORKBENCH_TMUX_SESSION || "workbench").trim() || "workbench"
  const windowName = String(request?.window || "control").trim() || "control"
  const paneRole = String(request?.paneRole || "main").trim() || "main"

  const title = safeTmuxPaneLabel(request?.title || "Transcript")
  const openPopup = request?.openPopup !== false

  let captureLines = Number.parseInt(String(request?.captureLines ?? ""), 10)
  if (!Number.isFinite(captureLines) || captureLines <= 0) captureLines = 5000
  if (captureLines < 200) captureLines = 200
  if (captureLines > 200_000) captureLines = 200_000

  if (!hasCommand("tmux")) {
    return {
      ok: false,
      action: "pane.capture",
      summary: "tmux not found",
      detail: "tmux CLI is not installed or not in PATH.",
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const has = runTmuxSync(tmuxServer, ["has-session", "-t", tmuxSession])
  if (has.status !== 0) {
    return {
      ok: false,
      action: "pane.capture",
      summary: "tmux session not found",
      detail: `tmux session "${tmuxSession}" not found on server "${tmuxServer}"`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: has.status,
      cancelled: false,
    }
  }

  const panes = listTmuxPanes(tmuxServer, tmuxSession, windowName)
  const targetPane =
    panes.find((p) => p.role === paneRole) ||
    panes.find((p) => p.paneIndex === 0) ||
    null

  if (!targetPane) {
    return {
      ok: false,
      action: "pane.capture",
      summary: "target pane not found",
      detail: `Unable to locate pane role "${paneRole}" in ${tmuxSession}:${windowName}`,
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const runId = `capture_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "pane.capture", runId)
  ensureDir(runDir)
  const outPath = path.join(runDir, "pane.txt")

  const cap = runTmuxSync(tmuxServer, [
    "capture-pane",
    "-t",
    targetPane.paneId,
    "-J",
    "-S",
    `-${captureLines}`,
    "-p",
  ], { timeout: 10_000 })

  if (cap.status !== 0) {
    return {
      ok: false,
      action: "pane.capture",
      summary: "tmux capture failed",
      detail: String(cap.stderr || "").trim(),
      artifacts: { tmux: { server: tmuxServer, session: tmuxSession, window: windowName, paneId: targetPane.paneId } },
      startedAt,
      endedAt: nowIso(),
      exitCode: cap.status,
      cancelled: false,
    }
  }

  try {
    fs.writeFileSync(outPath, String(cap.stdout || ""), { encoding: "utf8", mode: 0o644 })
  } catch (e) {
    return {
      ok: false,
      action: "pane.capture",
      summary: "write failed",
      detail: String(e?.message ?? e),
      artifacts: {},
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  if (openPopup) {
    // Launch popup in the background; do not block the system executor on interactive `less`.
    const popupArgs = [
      ...tmuxBinArgs(tmuxServer),
      "display-popup",
      "-E",
      "-w",
      "90%",
      "-h",
      "90%",
      "-T",
      title,
      "bash",
      "-lc",
      `less -R +G "${outPath.replaceAll('"', '\\"')}"`,
    ]
    try {
      const p = spawn("tmux", popupArgs, { stdio: "ignore", detached: true })
      p.unref()
    } catch {}
  }

  return {
    ok: true,
    action: "pane.capture",
    summary: "captured",
    detail: openPopup ? "opened popup viewer" : "",
    artifacts: {
      capturePath: outPath,
      tmux: { server: tmuxServer, session: tmuxSession, window: windowName, paneId: targetPane.paneId, paneRole },
      captureLines,
    },
    startedAt,
    endedAt: nowIso(),
    exitCode: 0,
    cancelled: false,
  }
}

function startVerify({ repoRoot, stateDir, sessionDir, request, onDone }) {
  const startedAt = nowIso()
  const runId = `verify_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "verify", runId)
  ensureDir(runDir)

  const stdoutPath = path.join(runDir, "stdout.txt")
  const stderrPath = path.join(runDir, "stderr.txt")
  const metaPath = path.join(runDir, "meta.json")

  const full = !!request?.full
  const args = ["verify/run.js"]
  const env = {
    ...process.env,
    WORKBENCH_STATE_DIR: stateDir,
  }
  if (!full) {
    env.WORKBENCH_VERIFY_FAST = "1"
    env.WORKBENCH_SKIP_DOCKER = "1"
  }

  writeJson(metaPath, { version: 1, action: "verify", full, startedAt, cwd: repoRoot }, 0o644)

  const proc = spawn("node", args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] })
  const outFd = fs.openSync(stdoutPath, "a")
  const errFd = fs.openSync(stderrPath, "a")
  proc.stdout.on("data", (d) => fs.writeSync(outFd, d))
  proc.stderr.on("data", (d) => fs.writeSync(errFd, d))

  let cancelled = false
  const cancel = () => {
    cancelled = true
    try {
      proc.kill("SIGKILL")
    } catch {}
  }

  proc.on("close", (code) => {
    try {
      fs.closeSync(outFd)
      fs.closeSync(errFd)
    } catch {}
    const endedAt = nowIso()

    let summaryPath = null
    try {
      const s = fs.readFileSync(stdoutPath, "utf8")
      const m = s.match(/\[verify\] summary:\s*(.+)\s*$/m)
      if (m && m[1]) summaryPath = m[1].trim()
    } catch {}

    const ok = !cancelled && code === 0
    const summary = ok ? "verify.ok" : cancelled ? "verify.cancelled" : `verify.failed(exitCode=${code ?? "?"})`

    onDone({
      ok,
      action: "verify",
      summary,
      detail: summaryPath ? `summary: ${summaryPath}` : "",
      artifacts: { runDir, stdout: stdoutPath, stderr: stderrPath, summary: summaryPath },
      startedAt,
      endedAt,
      exitCode: code ?? null,
      cancelled,
    })
  })

  return { proc, cancel, startedAt, runDir }
}

async function runDockerProbe({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()
  const runId = `docker_probe_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "docker", runId)
  ensureDir(runDir)

  const outJsonPath = path.join(runDir, "probe.json")
  const outTxtPath = path.join(runDir, "probe.txt")
  const metaPath = path.join(runDir, "meta.json")

  writeJson(metaPath, { version: 1, action: "docker.probe", startedAt }, 0o644)

  if (!hasCommand("bun")) {
    writeJson(outJsonPath, { version: 1, request, error: "bun not found" }, 0o644)
    const endedAt = nowIso()
    return {
      ok: false,
      action: "docker.probe",
      summary: "bun not found",
      detail: "Install Bun or run `workbench verify --full` from a Bun-enabled environment.",
      artifacts: { runDir, probeJson: outJsonPath, probeText: null },
      startedAt,
      endedAt,
      exitCode: null,
      cancelled: false,
    }
  }

  const docker = StdioJsonRpcClient.spawn(["bun", "mcp/servers/docker/src/index.js"], { cwd: repoRoot, env: { ...process.env, WORKBENCH_STATE_DIR: stateDir } })
  try {
    const init = await docker.initialize(10_000)
    if (init?.error) throw new Error(init.error?.message ?? "docker.initialize failed")
    const call = await docker.toolsCall("workbench.docker.probe", {}, 20_000)
    if (call?.error) throw new Error(call.error?.message ?? "docker.toolsCall failed")

    const json = call?.result?.content?.[0]?.json ?? null
    const text = call?.result?.content?.[0]?.text ?? ""

    writeJson(outJsonPath, { version: 1, request, result: call, json }, 0o644)
    if (text) fs.writeFileSync(outTxtPath, text, "utf8")

    const ok = !call?.result?.isError
    return {
      ok,
      action: "docker.probe",
      summary: ok ? "docker.ok" : "docker.error",
      detail: text ? text.slice(0, 4000) : "",
      artifacts: { runDir, probeJson: outJsonPath, probeText: text ? outTxtPath : null },
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  } finally {
    docker.kill()
  }
}

async function runDockerPs({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()
  const runId = `docker_ps_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "docker", runId)
  ensureDir(runDir)

  const outJsonPath = path.join(runDir, "ps.json")
  const metaPath = path.join(runDir, "meta.json")

  writeJson(metaPath, { version: 1, action: "docker.ps", startedAt }, 0o644)

  if (!hasCommand("docker")) {
    const endedAt = nowIso()
    return {
      ok: false,
      action: "docker.ps",
      summary: "docker not found",
      detail: "Docker CLI is not installed or not in PATH.",
      artifacts: { runDir },
      startedAt,
      endedAt,
      exitCode: null,
      cancelled: false,
    }
  }

  const all = request?.args?.all === true
  const args = all ? ["ps", "-a", "--format", "json"] : ["ps", "--format", "json"]
  const result = spawnSync("docker", args, { timeout: 10_000, encoding: "utf8" })

  const ok = result.status === 0
  const containers = []
  if (ok && result.stdout) {
    // Docker outputs one JSON per line
    const lines = result.stdout.split("\n").filter(Boolean)
    for (const line of lines) {
      try {
        containers.push(JSON.parse(line))
      } catch {}
    }
  }

  writeJson(outJsonPath, { version: 1, request, containers, stderr: result.stderr }, 0o644)

  return {
    ok,
    action: "docker.ps",
    summary: ok ? `docker.ps.ok (${containers.length} containers)` : "docker.ps.error",
    detail: ok ? `Found ${containers.length} container(s)` : result.stderr?.slice(0, 1000) || "",
    artifacts: { runDir, psJson: outJsonPath },
    startedAt,
    endedAt: nowIso(),
    exitCode: result.status,
    cancelled: false,
    containers,
  }
}

async function runSandboxStatus({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()
  const runId = `sandbox_status_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "sandbox", runId)
  ensureDir(runDir)

  const metaPath = path.join(runDir, "meta.json")
  const name = request?.args?.name || "workbench-docker"

  writeJson(metaPath, { version: 1, action: "sandbox.status", name, startedAt }, 0o644)

  if (!hasCommand("docker")) {
    return {
      ok: false,
      action: "sandbox.status",
      summary: "docker not found",
      detail: "Docker CLI is not installed or not in PATH.",
      artifacts: { runDir },
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
      sandbox: { name, running: false },
    }
  }

  // Check if container exists and is running
  const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", name], {
    timeout: 10_000,
    encoding: "utf8",
  })

  const running = inspect.status === 0 && inspect.stdout.trim() === "true"

  return {
    ok: true,
    action: "sandbox.status",
    summary: running ? "sandbox.running" : "sandbox.stopped",
    detail: `Container ${name} is ${running ? "running" : "not running"}`,
    artifacts: { runDir },
    startedAt,
    endedAt: nowIso(),
    exitCode: inspect.status,
    cancelled: false,
    sandbox: { name, running },
  }
}

async function runSandboxStart({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()
  const runId = `sandbox_start_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "sandbox", runId)
  ensureDir(runDir)

  const metaPath = path.join(runDir, "meta.json")
  const name = request?.args?.name || "workbench-docker"
  const image = request?.args?.image || "claude-sandbox:base"
  const workspace = request?.args?.workspace || process.cwd()

  writeJson(metaPath, { version: 1, action: "sandbox.start", name, image, workspace, startedAt }, 0o644)

  if (!hasCommand("docker")) {
    return {
      ok: false,
      action: "sandbox.start",
      summary: "docker not found",
      detail: "Docker CLI is not installed or not in PATH.",
      artifacts: { runDir },
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
      sandbox: { name, running: false },
    }
  }

  // Check if container already exists
  const existing = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", name], {
    timeout: 10_000,
    encoding: "utf8",
  })

  if (existing.status === 0) {
    const running = existing.stdout.trim() === "true"
    return {
      ok: true,
      action: "sandbox.start",
      summary: running ? "sandbox.already_running" : "sandbox.exists_stopped",
      detail: `Container ${name} already exists (${running ? "running" : "stopped"})`,
      artifacts: { runDir },
      startedAt,
      endedAt: nowIso(),
      exitCode: 0,
      cancelled: false,
      sandbox: { name, running },
    }
  }

  // Start new container
  const args = [
    "run", "-d",
    "--name", name,
    "-v", `${workspace}:/work`,
    "-w", "/work",
    image,
    "tail", "-f", "/dev/null",
  ]

  const result = spawnSync("docker", args, { timeout: 60_000, encoding: "utf8" })
  const ok = result.status === 0

  return {
    ok,
    action: "sandbox.start",
    summary: ok ? "sandbox.started" : "sandbox.start_failed",
    detail: ok ? `Container ${name} started` : result.stderr?.slice(0, 1000) || "",
    artifacts: { runDir },
    startedAt,
    endedAt: nowIso(),
    exitCode: result.status,
    cancelled: false,
    sandbox: { name, running: ok },
  }
}

async function runSandboxExec({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()
  const runId = `sandbox_exec_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "sandbox", runId)
  ensureDir(runDir)

  const metaPath = path.join(runDir, "meta.json")
  const outTxtPath = path.join(runDir, "output.txt")
  const name = request?.args?.name || "workbench-docker"
  const command = request?.args?.command || "echo 'No command specified'"
  const timeout = request?.args?.timeout || 60_000

  writeJson(metaPath, { version: 1, action: "sandbox.exec", name, command, startedAt }, 0o644)

  if (!hasCommand("docker")) {
    return {
      ok: false,
      action: "sandbox.exec",
      summary: "docker not found",
      detail: "Docker CLI is not installed or not in PATH.",
      artifacts: { runDir },
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
    }
  }

  const result = spawnSync("docker", ["exec", name, "bash", "-c", command], {
    timeout,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })

  const output = (result.stdout || "") + (result.stderr || "")
  fs.writeFileSync(outTxtPath, output, "utf8")

  const ok = result.status === 0

  return {
    ok,
    action: "sandbox.exec",
    summary: ok ? "sandbox.exec.ok" : "sandbox.exec.error",
    detail: output.slice(0, 2000),
    artifacts: { runDir, outputTxt: outTxtPath },
    startedAt,
    endedAt: nowIso(),
    exitCode: result.status,
    cancelled: false,
  }
}

async function runSandboxStop({ repoRoot, stateDir, sessionDir, request }) {
  const startedAt = nowIso()
  const runId = `sandbox_stop_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const runDir = path.join(sessionDir, "system", "sandbox", runId)
  ensureDir(runDir)

  const metaPath = path.join(runDir, "meta.json")
  const name = request?.args?.name || "workbench-docker"

  writeJson(metaPath, { version: 1, action: "sandbox.stop", name, startedAt }, 0o644)

  if (!hasCommand("docker")) {
    return {
      ok: false,
      action: "sandbox.stop",
      summary: "docker not found",
      detail: "Docker CLI is not installed or not in PATH.",
      artifacts: { runDir },
      startedAt,
      endedAt: nowIso(),
      exitCode: null,
      cancelled: false,
      sandbox: { name, running: false },
    }
  }

  // Stop and remove container
  const stop = spawnSync("docker", ["rm", "-f", name], { timeout: 30_000, encoding: "utf8" })
  const ok = stop.status === 0 || stop.stderr?.includes("No such container")

  return {
    ok,
    action: "sandbox.stop",
    summary: ok ? "sandbox.stopped" : "sandbox.stop_failed",
    detail: ok ? `Container ${name} stopped and removed` : stop.stderr?.slice(0, 1000) || "",
    artifacts: { runDir },
    startedAt,
    endedAt: nowIso(),
    exitCode: stop.status,
    cancelled: false,
    sandbox: { name, running: false },
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const stateDir = args.stateDir ? path.resolve(args.stateDir) : path.resolve(process.env.WORKBENCH_STATE_DIR || ".workbench")
  const repoRoot = path.resolve(args.repoRoot || process.cwd())

  let sessionId = ensureSessionId(stateDir)
  let sessionDir = path.join(stateDir, sessionId)
  ensureDir(sessionDir)
  ensureDir(path.join(sessionDir, "system"))

  let requestsPath = path.join(sessionDir, "system.requests.jsonl")
  let responsesPath = path.join(sessionDir, "system.responses.jsonl")
  let readyPath = path.join(sessionDir, "system.executor.json")

  if (!fs.existsSync(requestsPath)) fs.writeFileSync(requestsPath, "", "utf8")
  if (!fs.existsSync(responsesPath)) fs.writeFileSync(responsesPath, "", "utf8")

  let offset = 0
  let inFlight = null

  const touchReady = () => {
    writeJson(readyPath, { version: 1, pid: process.pid, sessionId, updatedAt: nowIso(), requestsPath, responsesPath }, 0o644)
  }
  touchReady()
  setInterval(() => touchReady(), 5_000)

  const switchSession = (nextId) => {
    if (!nextId || nextId === sessionId) return
    if (inFlight && typeof inFlight.cancel === "function") {
      try { inFlight.cancel() } catch {}
    }
    inFlight = null
    offset = 0

    sessionId = nextId
    sessionDir = path.join(stateDir, sessionId)
    ensureDir(sessionDir)
    ensureDir(path.join(sessionDir, "system"))

    requestsPath = path.join(sessionDir, "system.requests.jsonl")
    responsesPath = path.join(sessionDir, "system.responses.jsonl")
    readyPath = path.join(sessionDir, "system.executor.json")

    if (!fs.existsSync(requestsPath)) fs.writeFileSync(requestsPath, "", "utf8")
    if (!fs.existsSync(responsesPath)) fs.writeFileSync(responsesPath, "", "utf8")

    touchReady()
  }

  while (true) {
    await new Promise((r) => setTimeout(r, 200))

    const desired = readCurrentSessionId(stateDir) || sessionId
    if (desired !== sessionId) {
      switchSession(desired)
      continue
    }

    let st = null
    try {
      st = fs.statSync(requestsPath)
    } catch {
      continue
    }
    if (offset > st.size) offset = st.size
    if (offset === st.size) continue

    const fd = fs.openSync(requestsPath, "r")
    const buf = Buffer.alloc(st.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = st.size

    const lines = buf
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)

    for (const line of lines) {
      let req = null
      try {
        req = JSON.parse(line)
      } catch {
        continue
      }
      if (!req || req.version !== 1) continue
      if (typeof req.correlationId !== "string" || !req.correlationId.trim()) continue

      if (req.type === "cancel") {
        if (inFlight && inFlight.correlationId === req.correlationId && typeof inFlight.cancel === "function") {
          inFlight.cancel()
        }
        continue
      }

      if (inFlight) {
        appendJsonl(responsesPath, {
          version: 1,
          type: "system.result",
          correlationId: req.correlationId,
          ok: false,
          action: String(req.type ?? ""),
          summary: "executor busy",
          detail: "",
          artifacts: {},
          startedAt: nowIso(),
          endedAt: nowIso(),
        })
        continue
      }

      const startedAt = nowIso()
      const action = String(req.type ?? "").trim()
      try {
        if (action === "verify") {
          const turn = startVerify({
            repoRoot,
            stateDir,
            sessionDir,
            request: { full: !!req.full },
            onDone: (result) => {
              appendJsonl(responsesPath, {
                version: 1,
                type: "system.result",
                correlationId: req.correlationId,
                ok: !!result.ok,
                action: result.action,
                summary: result.summary,
                detail: result.detail,
                artifacts: result.artifacts,
                startedAt: result.startedAt ?? startedAt,
                endedAt: result.endedAt ?? nowIso(),
              })
              inFlight = null
            },
          })
          inFlight = { correlationId: req.correlationId, cancel: turn.cancel }
          continue
        }

        if (action === "docker.probe") {
          const result = await runDockerProbe({ repoRoot, stateDir, sessionDir, request: {} })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "docker.ps") {
          const result = await runDockerPs({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            containers: result.containers,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "oauth.sync") {
          const result = await runOAuthSync({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "runner.smoke") {
          const result = await runRunnerSmoke({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "install") {
          const result = await runInstall({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "surface.launch") {
          const result = await runSurfaceLaunch({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "codex.swap") {
          const result = await runCodexSwap({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            swap: result.swap,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "pane.capture") {
          const result = await runPaneCapture({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "sandbox.status") {
          const result = await runSandboxStatus({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            sandbox: result.sandbox,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "sandbox.start") {
          const result = await runSandboxStart({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            sandbox: result.sandbox,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "sandbox.exec") {
          const result = await runSandboxExec({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        if (action === "sandbox.stop") {
          const result = await runSandboxStop({ repoRoot, stateDir, sessionDir, request: req })
          appendJsonl(responsesPath, {
            version: 1,
            type: "system.result",
            correlationId: req.correlationId,
            ok: !!result.ok,
            action: result.action,
            summary: result.summary,
            detail: result.detail,
            artifacts: result.artifacts,
            sandbox: result.sandbox,
            startedAt: result.startedAt ?? startedAt,
            endedAt: result.endedAt ?? nowIso(),
          })
          continue
        }

        appendJsonl(responsesPath, {
          version: 1,
          type: "system.result",
          correlationId: req.correlationId,
          ok: false,
          action: safeName(action),
          summary: "unknown action",
          detail: "",
          artifacts: {},
          startedAt,
          endedAt: nowIso(),
        })
      } catch (e) {
        appendJsonl(responsesPath, {
          version: 1,
          type: "system.result",
          correlationId: req.correlationId,
          ok: false,
          action: safeName(action),
          summary: "error",
          detail: String(e?.message ?? e),
          artifacts: {},
          startedAt,
          endedAt: nowIso(),
        })
        inFlight = null
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
