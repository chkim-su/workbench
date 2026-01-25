/**
 * ANSI-based rendering for TUI.
 * Frame-driven: only renders when content changes.
 */

export const ANSI = {
  clear: "\x1b[2J\x1b[H", // Legacy: full clear (causes flicker) - avoid in render loop
  home: "\x1b[H", // Cursor to home position (no clear)
  clearLine: "\x1b[K", // Clear from cursor to end of line
  clearDown: "\x1b[J", // Clear from cursor to end of screen
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
}

/**
 * Slice an ANSI-colored string to a maximum visible column width.
 * This is intentionally simple (counts most codepoints as width=1) because our ANSI TUI
 * output is mostly ASCII/box-drawing and we want a stable no-wrap invariant.
 * @param {string} input
 * @param {number} maxCols
 * @returns {string}
 */
function ansiTruncate(input, maxCols) {
  if (!input) return ""
  if (!Number.isFinite(maxCols) || maxCols <= 0) return ""

  let out = ""
  let cols = 0

  // CSI sequence matcher (covers our usage like \x1b[31m, \x1b[?25l, etc.)
  const csiRe = /^\x1b\[[0-9;?]*[ -/]*[@-~]/

  for (let i = 0; i < input.length && cols < maxCols; ) {
    if (input[i] === "\x1b") {
      const m = input.slice(i).match(csiRe)
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }

    const cp = input.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    out += ch
    cols += 1
    i += ch.length
  }

  // Avoid color bleed if we truncate before a reset.
  if (!out.endsWith(ANSI.reset)) out += ANSI.reset
  return out
}

/**
 * Menu items for the TUI
 */
export const MENU_ITEMS = [
  { key: "1", label: "Install (interactive, logged)", section: "core" },
  { key: "2", label: "Verify (fast)", section: "core" },
  { key: "3", label: "Verify (full)", section: "core" },
  { key: "4", label: "Doctor (env/status)", section: "core" },
  { key: "5", label: "OAuth status (profiles/rate limits)", section: "oauth" },
  { key: "6", label: "OAuth login (browser)", section: "oauth" },
  { key: "7", label: "OAuth login (device code)", section: "oauth" },
  { key: "8", label: "OAuth sync from OpenCode", section: "oauth" },
  { key: "9", label: "OAuth sync (watch mode)", section: "oauth" },
  { key: "10", label: "OAuth pool manage", section: "oauth" },
  { key: "11", label: "Runner smoke (mock)", section: "runner" },
  { key: "12", label: "Runner smoke (real Codex OAuth)", section: "runner" },
  { key: "13", label: "Chat (Codex)", section: "runner" },
  { key: "14", label: "Verify (full) with Codex OAuth", section: "runner" },
  { key: "15", label: "Show latest verify summary", section: "info" },
  { key: "q", label: "Quit", section: "info" },
]

/**
 * Render menu section
 * @param {import('./state.js').TuiState} state
 * @returns {string[]}
 */
function renderMenu(state) {
  const lines = []

  lines.push(`${ANSI.bold}${ANSI.cyan}=== Core ===${ANSI.reset}`)
  for (const item of MENU_ITEMS.filter((i) => i.section === "core")) {
    lines.push(`  ${ANSI.yellow}${item.key.padStart(2)})${ANSI.reset} ${item.label}`)
  }

  lines.push("")
  lines.push(`${ANSI.bold}${ANSI.cyan}=== OAuth Management ===${ANSI.reset}`)
  for (const item of MENU_ITEMS.filter((i) => i.section === "oauth")) {
    lines.push(`  ${ANSI.yellow}${item.key.padStart(2)})${ANSI.reset} ${item.label}`)
  }

  lines.push("")
  lines.push(`${ANSI.bold}${ANSI.cyan}=== Runner/Chat ===${ANSI.reset}`)
  for (const item of MENU_ITEMS.filter((i) => i.section === "runner")) {
    lines.push(`  ${ANSI.yellow}${item.key.padStart(2)})${ANSI.reset} ${item.label}`)
  }

  lines.push("")
  lines.push(`${ANSI.bold}${ANSI.cyan}=== Info ===${ANSI.reset}`)
  for (const item of MENU_ITEMS.filter((i) => i.section === "info")) {
    lines.push(`  ${ANSI.yellow}${item.key.padStart(2)})${ANSI.reset} ${item.label}`)
  }

  return lines
}

/**
 * Render verify status section
 * @param {import('./state.js').TuiState} state
 * @returns {string[]}
 */
function renderVerifyStatus(state) {
  const lines = []

  if (!state.verifyGates.length) {
    lines.push(`${ANSI.dim}No verify results yet${ANSI.reset}`)
    return lines
  }

  lines.push(`${ANSI.bold}Verify Run: ${state.verifyRunId || "unknown"}${ANSI.reset}`)
  lines.push("")

  for (const gate of state.verifyGates) {
    const icon = gate.skipped ? `${ANSI.yellow}⊘${ANSI.reset}` : gate.ok ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`
    const name = gate.name || "unknown"
    const status = gate.skipped ? `${ANSI.dim}skipped${ANSI.reset}` : gate.ok ? `${ANSI.green}ok${ANSI.reset}` : `${ANSI.red}failed${ANSI.reset}`
    lines.push(`  ${icon} ${name}: ${status}`)
  }

  return lines
}

/**
 * Render runner status section
 * @param {import('./state.js').TuiState} state
 * @returns {string[]}
 */
function renderRunnerStatus(state) {
  const lines = []

  if (!state.runnerStatus) {
    lines.push(`${ANSI.dim}No runner results yet${ANSI.reset}`)
    return lines
  }

  const rs = state.runnerStatus
  lines.push(`${ANSI.bold}Runner: ${rs.runId || "unknown"}${ANSI.reset}`)
  lines.push(`  Provider: ${rs.provider || "unknown"}`)
  lines.push(`  Tool calls: ${rs.toolCallsSeen?.length || 0}`)
  if (rs.error) {
    lines.push(`  ${ANSI.red}Error: ${rs.error}${ANSI.reset}`)
  }

  return lines
}

/**
 * Format time remaining from milliseconds
 * @param {number} ms
 * @returns {string|null}
 */
function formatTimeRemaining(ms) {
  if (ms <= 0) return null
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

/**
 * Extract email from JWT token
 * @param {string} token
 * @returns {string|null}
 */
function extractEmailFromToken(token) {
  if (!token) return null
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())
    return (
      payload["https://api.openai.com/profile"]?.email ||
      payload.email ||
      null
    )
  } catch {
    return null
  }
}

/**
 * Get profile status info
 * @param {object} profile
 * @returns {{status: string, color: string, icon: string, text: string}}
 */
function getProfileStatus(profile) {
  const now = Date.now()

  // Check if rate limited
  if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > now) {
    return {
      status: "rate_limited",
      color: ANSI.yellow,
      icon: "!",
      text: `Rate limited`,
    }
  }

  // Check if disabled
  if (profile.disabled || profile.enabled === false) {
    return {
      status: "disabled",
      color: ANSI.dim,
      icon: "-",
      text: "Disabled",
    }
  }

  // Check if expired
  if (profile.expiresAtMs && profile.expiresAtMs < now) {
    return {
      status: "expired",
      color: ANSI.red,
      icon: "x",
      text: "Token expired (will refresh)",
    }
  }

  // Ready
  return {
    status: "ready",
    color: ANSI.green,
    icon: "●",
    text: "Ready",
  }
}

/**
 * Render OAuth pool status (compact - for sidebar)
 * @param {import('./state.js').TuiState} state
 * @returns {string[]}
 */
function renderOAuthStatus(state) {
  const lines = []

  if (!state.oauthPool) {
    lines.push(`${ANSI.dim}No OAuth pool configured${ANSI.reset}`)
    return lines
  }

  const pool = state.oauthPool
  lines.push(`${ANSI.bold}OAuth Pool${ANSI.reset}`)
  lines.push(`  Strategy: ${pool.strategy || pool.selection?.strategy || "unknown"}`)
  if (pool.pinned || pool.selection?.pinnedProfile) {
    lines.push(`  ${ANSI.cyan}Pinned: ${pool.pinned || pool.selection?.pinnedProfile}${ANSI.reset}`)
  }

  const profiles = Object.keys(pool.profiles || {})
  if (profiles.length) {
    lines.push(`  Profiles: ${profiles.join(", ")}`)
  }

  return lines
}

/**
 * Render detailed OAuth status view (full screen)
 * @param {import('./state.js').TuiState} state
 * @returns {string[]}
 */
function renderOAuthStatusView(state) {
  const lines = []

  lines.push(`${ANSI.bold}${ANSI.cyan}╭────────────────────────────────────────╮${ANSI.reset}`)
  lines.push(`${ANSI.bold}${ANSI.cyan}│          OAUTH STATUS                  │${ANSI.reset}`)
  lines.push(`${ANSI.bold}${ANSI.cyan}╰────────────────────────────────────────╯${ANSI.reset}`)
  lines.push("")

  if (!state.oauthPool) {
    lines.push(`${ANSI.yellow}No OAuth profiles configured.${ANSI.reset}`)
    lines.push("")
    lines.push(`${ANSI.dim}Use option 5 (OAuth login) to add a profile.${ANSI.reset}`)
    return lines
  }

  const pool = state.oauthPool
  const profiles = pool.profiles || {}
  const profileNames = Object.keys(profiles)

  // Summary bar
  let readyCount = 0
  let rateLimitedCount = 0
  let expiredCount = 0
  let disabledCount = 0

  for (const name of profileNames) {
    const status = getProfileStatus(profiles[name])
    if (status.status === "ready") readyCount++
    else if (status.status === "rate_limited") rateLimitedCount++
    else if (status.status === "expired") expiredCount++
    else if (status.status === "disabled") disabledCount++
  }

  const summaryParts = []
  summaryParts.push(`${ANSI.green}${readyCount}${ANSI.reset} ready`)
  if (rateLimitedCount > 0) {
    summaryParts.push(`${ANSI.yellow}${rateLimitedCount}${ANSI.reset} rate limited`)
  }
  if (expiredCount > 0) {
    summaryParts.push(`${ANSI.red}${expiredCount}${ANSI.reset} expired`)
  }
  if (disabledCount > 0) {
    summaryParts.push(`${ANSI.dim}${disabledCount}${ANSI.reset} disabled`)
  }

  lines.push(`${summaryParts.join(" | ")} | Strategy: ${pool.strategy || pool.selection?.strategy || "sticky"}`)
  lines.push("")

  // Profile cards
  const lastUsed = pool.lastUsedProfile || pool.selection?.lastUsedProfile
  const pinned = pool.pinned || pool.selection?.pinnedProfile

  for (const name of profileNames) {
    const profile = profiles[name]
    const status = getProfileStatus(profile)
    const email = extractEmailFromToken(profile.accessToken || profile.idToken)
    const isSelected = name === lastUsed || name === pinned

    // Profile header
    const selectedMark = isSelected ? `${ANSI.cyan}>${ANSI.reset}` : " "
    lines.push(`${selectedMark} ${ANSI.bold}${name}${ANSI.reset}  ${status.color}${status.icon} ${status.text}${ANSI.reset}`)

    // Email
    if (email) {
      lines.push(`    ${ANSI.dim}${email}${ANSI.reset}`)
    }

    // Expiry info
    if (profile.expiresAtMs) {
      const expiresAt = new Date(profile.expiresAtMs).toLocaleTimeString()
      const remaining = profile.expiresAtMs - Date.now()
      if (remaining > 0) {
        lines.push(`    ${ANSI.dim}Expires: ${expiresAt} (${formatTimeRemaining(remaining)})${ANSI.reset}`)
      } else {
        lines.push(`    ${ANSI.red}Expired at: ${expiresAt}${ANSI.reset}`)
      }
    }

    // Rate limit info
    if (profile.rateLimitedUntilMs && profile.rateLimitedUntilMs > Date.now()) {
      const until = new Date(profile.rateLimitedUntilMs).toLocaleTimeString()
      const remaining = profile.rateLimitedUntilMs - Date.now()
      lines.push(`    ${ANSI.yellow}Rate limited until: ${until} (${formatTimeRemaining(remaining)})${ANSI.reset}`)
    }

    lines.push("")
  }

  return lines
}

/**
 * Render capabilities status bar
 * @param {import('./state.js').TuiState} state
 * @returns {string}
 */
function renderCapabilities(state) {
  const caps = state.capabilities
  const items = []

  const cap = (name, ok) => (ok ? `${ANSI.green}${name}${ANSI.reset}` : `${ANSI.dim}${name}${ANSI.reset}`)

  items.push(cap("node", caps.node))
  items.push(cap("python3", caps.python3))
  items.push(cap("bun", caps.bun))
  items.push(cap("tmux", caps.tmux))
  items.push(cap("docker", caps.docker))

  return `[${items.join(" ")}]`
}

/**
 * Main render function
 * @param {import('./state.js').TuiState} state
 * @param {{rows: number, cols: number}} size
 * @returns {string}
 */
export function render(state, size) {
  const lines = []
  const rows = Math.max(1, Number(size?.rows) || 24)
  const cols = Math.max(1, Number(size?.cols) || 80)

  // Hard guard: if the terminal is extremely small, render a stable hint instead of a broken layout.
  if (cols < 20 || rows < 6) {
    const tiny = [
      `${ANSI.bold}My LLM Workbench${ANSI.reset}`,
      `${ANSI.yellow}Terminal too small${ANSI.reset}`,
      `${ANSI.dim}Need at least 20x6. Current: ${cols}x${rows}${ANSI.reset}`,
      `${ANSI.dim}Tip: resize the terminal window.${ANSI.reset}`,
    ]
    const rendered = tiny.slice(0, rows).map((l) => ansiTruncate(l, cols) + ANSI.clearLine)
    return ANSI.home + rendered.join("\n") + ANSI.clearDown
  }

  // Header
  lines.push(`${ANSI.bold}${ANSI.bgBlue}${ANSI.white} My LLM Workbench ${ANSI.reset} ${ANSI.dim}(Mode B)${ANSI.reset} ${renderCapabilities(state)}`)
  lines.push(`${ANSI.dim}repo: ${process.cwd()}${ANSI.reset}`)
  lines.push("")

  // Status message if any
  if (state.statusMessage) {
    lines.push(`${ANSI.cyan}${state.statusMessage}${ANSI.reset}`)
    lines.push("")
  }

  // Main content based on mode
  if (state.mode === "menu") {
    lines.push(...renderMenu(state))
  } else if (state.mode === "verify") {
    lines.push(...renderVerifyStatus(state))
    lines.push("")
    lines.push(`${ANSI.dim}Running verify... (output in pane 3)${ANSI.reset}`)
  } else if (state.mode === "runner") {
    lines.push(...renderRunnerStatus(state))
    lines.push("")
    lines.push(`${ANSI.dim}Running runner... (output in pane 2)${ANSI.reset}`)
  } else if (state.mode === "oauth") {
    lines.push(...renderOAuthStatus(state))
  } else if (state.mode === "oauth-status") {
    lines.push(...renderOAuthStatusView(state))
  }

  // Sidebar: Latest verify summary (compact)
  if (state.mode === "menu" && state.verifyGates.length) {
    lines.push("")
    lines.push(`${ANSI.dim}─── Last Verify ───${ANSI.reset}`)
    const failed = state.verifyGates.filter((g) => g && g.ok === false).length
    const skipped = state.verifyGates.filter((g) => g && g.skipped).length
    const passed = state.verifyGates.filter((g) => g && g.ok && !g.skipped).length
    const summary = []
    if (passed) summary.push(`${ANSI.green}${passed} passed${ANSI.reset}`)
    if (failed) summary.push(`${ANSI.red}${failed} failed${ANSI.reset}`)
    if (skipped) summary.push(`${ANSI.yellow}${skipped} skipped${ANSI.reset}`)
    lines.push(`  ${summary.join(", ")}`)
  }

  // Footer with last error if any
  if (state.lastError) {
    lines.push("")
    lines.push(`${ANSI.red}Error: ${state.lastError}${ANSI.reset}`)
  }

  // Prompt
  lines.push("")
  if (state.running) {
    lines.push(`${ANSI.dim}[Running... press Ctrl+C to interrupt]${ANSI.reset}`)
  } else if (state.mode === "menu") {
    lines.push(`${ANSI.cyan}Select:${ANSI.reset} `)
  } else {
    lines.push(`${ANSI.dim}[Press Enter to return to menu]${ANSI.reset}`)
  }

  // Keep header + footer visible even on short terminals.
  const headerKeep = 3 // title, repo, blank
  const footerKeep = 2 // blank + prompt line
  let fittedLines = lines
  if (lines.length > rows) {
    if (rows <= headerKeep + footerKeep + 1) {
      // Too short to do a nice split; keep the bottom (prompt) visible.
      fittedLines = lines.slice(-rows)
    } else {
      const body = lines.slice(headerKeep, lines.length - footerKeep)
      const bodyMax = rows - headerKeep - footerKeep
      const bodyFitted = body.slice(0, bodyMax)
      if (body.length > bodyMax) {
        bodyFitted[bodyFitted.length - 1] = `${ANSI.dim}… (${body.length - bodyMax + 1} more)${ANSI.reset}`
      }
      fittedLines = [...lines.slice(0, headerKeep), ...bodyFitted, ...lines.slice(-footerKeep)]
    }
  }

  // Flicker-free rendering: cursor home + line-by-line with clear-to-EOL.
  // The critical invariant is: NEVER emit a line longer than `cols` (no implicit terminal wrapping).
  const renderedLines = fittedLines
    .slice(0, rows)
    .map((line) => ansiTruncate(line, cols) + ANSI.clearLine)

  return ANSI.home + renderedLines.join("\n") + ANSI.clearDown
}

/**
 * Simple hash for content change detection
 * @param {string} str
 * @returns {string}
 */
export function simpleHash(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0 // Convert to 32bit integer
  }
  return hash.toString(16)
}
