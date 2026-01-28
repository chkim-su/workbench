#!/usr/bin/env bun
/**
 * tmux-autostart
 * - Intended to run inside the Workbench tmux "control" main pane at startup.
 * - Requests `surface.launch` via the system JSONL bus (no tmux send-keys side channel).
 *
 * Env:
 * - WORKBENCH_STATE_DIR
 * - WORKBENCH_REPO_ROOT
 * - WORKBENCH_TMUX_SERVER
 * - WORKBENCH_TMUX_SESSION
 * - WORKBENCH_AUTOSTART_SURFACE  (codex|claude-code|bash)
 */

import { join } from "node:path"
import { appendSystemRequest, isSystemExecutorReady, newCorrelationId } from "./system-client.js"

const stateDir = String(process.env.WORKBENCH_STATE_DIR || join(process.cwd(), ".workbench")).trim()
const repoRoot = String(process.env.WORKBENCH_REPO_ROOT || process.cwd()).trim()
const tmuxServer = String(process.env.WORKBENCH_TMUX_SERVER || "workbench").trim()
const tmuxSession = String(process.env.WORKBENCH_TMUX_SESSION || "workbench").trim()
const surface = String(process.env.WORKBENCH_AUTOSTART_SURFACE || "").trim()

if (!surface) {
  process.exit(0)
}

if (!isSystemExecutorReady(stateDir)) {
  // Non-fatal: leave the pane as a normal shell so the user can still work.
  console.log("[workbench] autostart skipped: system executor not ready")
  process.exit(0)
}

const correlationId = newCorrelationId()
appendSystemRequest(stateDir, {
  type: "surface.launch",
  correlationId,
  surface,
  cwd: repoRoot,
  title: surface === "claude-code" ? "claude" : surface,
  syncOAuth: surface === "codex",
  tmuxServer,
  tmuxSession,
  window: "control",
  paneRole: "main",
})

console.log(`[workbench] autostart requested: ${surface} (cid=${correlationId})`)

