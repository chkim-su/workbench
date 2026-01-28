#!/usr/bin/env node
/**
 * Host-side Codex runtime executor for the Go TUI.
 *
 * Why this exists:
 * - The Go Bubble Tea TUI may run inside Docker (no `codex` binary inside, repo mounted read-only).
 * - We still want “real” Codex runtime edits on the host filesystem using our Workbench OAuth pool.
 *
 * Contract:
 * - Reads requests from:  <stateDir>/<sessionId>/codex.requests.jsonl
 * - Writes results to:   <stateDir>/<sessionId>/codex.responses.jsonl
 * - Writes raw events to:<stateDir>/<sessionId>/codex.exec.events.jsonl
 * - Heartbeat file:      <stateDir>/<sessionId>/codex.executor.json (mtime indicates readiness)
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { getSandboxArgs, getPermissionModeConfig, DEFAULT_PERMISSION_MODE } from "./permissionModes.js"

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
    try { cur = readJson(currentPath) } catch {}
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

function normalizeCwd(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const lower = s.toLowerCase()
  const marker = "\\\\wsl.localhost\\\\ubuntu\\\\"
  const idx = lower.indexOf(marker)
  if (idx >= 0) {
    let rest = s.slice(idx + marker.length)
    rest = rest.replaceAll("\\\\", "/").replaceAll("\\", "/").trim()
    if (rest && !rest.startsWith("/")) rest = "/" + rest
    return rest
  }
  return s
}

function pickPoolProfile(pool) {
  const sel = pool?.selection?.lastUsedProfile
  const profiles = pool?.profiles ?? {}
  if (sel && profiles[sel]) return profiles[sel]
  const keys = Object.keys(profiles)
  if (keys.length) return profiles[keys[0]]
  return null
}

function writeCodexAuthFromPool({ stateDir, codexHomeDir }) {
  const poolPath = path.join(stateDir, "auth", "openai_codex_oauth_pool.json")
  const pool = fs.existsSync(poolPath) ? readJson(poolPath) : null
  const profile = pickPoolProfile(pool)
  if (!profile) throw new Error(`OAuth pool missing/empty: ${poolPath}`)
  if (!profile.accessToken || !profile.refreshToken || !profile.accountId) {
    throw new Error("OAuth pool profile missing accessToken/refreshToken/accountId")
  }
  const auth = {
    tokens: {
      id_token: profile.accessToken,
      access_token: profile.accessToken,
      refresh_token: profile.refreshToken,
      account_id: profile.accountId,
    },
    last_refresh: nowIso(),
  }
  const authPath = path.join(codexHomeDir, ".codex", "auth.json")
  writeJson(authPath, auth, 0o600)
  return { poolPath, profileName: profile.profile ?? null }
}

function emitCodexTurnEvent(eventsPath, correlationId, { kind, message, tool }) {
  appendJsonl(eventsPath, {
    version: 1,
    type: "turn.event",
    correlationId,
    at: nowIso(),
    kind,
    message,
    ...(tool ? { tool } : {}),
  })
}

function safeToolSummary(input) {
  if (!input || typeof input !== "object") return ""
  const keys = Object.keys(input).slice(0, 8)
  if (!keys.length) return ""
  return `keys=[${keys.join(", ")}]`
}

function truncate(s, max = 180) {
  const txt = String(s ?? "").trim()
  if (!txt) return ""
  if (txt.length <= max) return txt
  return txt.slice(0, Math.max(0, max-1)) + "…"
}

function emitReasoningAsThink(eventsPath, correlationId, text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  // Keep it concise; this is a progress signal, not a full transcript.
  for (const l of lines.slice(0, 6)) {
    emitCodexTurnEvent(eventsPath, correlationId, { kind: "think", message: truncate(l, 220) })
  }
}

function startCodexTurn({ repoRoot, stateDir, sessionId, request, codexHomeDir, uiEventsPath, phase, onDone }) {
  const startedAt = nowIso()
  const out = { ok: false, content: "", error: "", fileChanges: [], startedAt, endedAt: "" }

  const sessionDir = path.join(stateDir, sessionId)
  const eventsPath = path.join(sessionDir, "codex.exec.events.jsonl")
  const cwd = normalizeCwd(request.cwd) || repoRoot

  let resolvedCwd = cwd
  try {
    if (!fs.statSync(resolvedCwd).isDirectory()) resolvedCwd = repoRoot
  } catch {
    resolvedCwd = repoRoot
  }

  const { profileName } = writeCodexAuthFromPool({ stateDir, codexHomeDir })

  const model = String(request.model ?? "").trim()
  const permissionMode = String(request.permissionMode ?? DEFAULT_PERMISSION_MODE).trim()
  const permConfig = getPermissionModeConfig(permissionMode)
  const sandboxArgs = getSandboxArgs(permissionMode)
  const args = ["exec", "--json", ...sandboxArgs, "--skip-git-repo-check", "--cd", resolvedCwd]
  if (model) args.push("--model", model)

  const preludeLines = [
    "You are running inside the local Codex CLI runtime.",
  ]
  if (permConfig.sandboxFlag === "read-only") {
    preludeLines.push("This session is read-only: do not modify any files.")
    preludeLines.push("You can still read files and run shell commands to inspect the repository; file writes will fail.")
  } else {
    preludeLines.push("You can create/edit files in the working directory.")
    preludeLines.push("You can read files and run shell commands in the working directory.")
  }
  preludeLines.push("Do not claim you cannot create files unless the sandbox is read-only.")
  // Apply noShell from permission config or explicit request
  if (permConfig.noShell || request.noShell) preludeLines.push("Do not run shell commands.")
  if (phase === "think") {
    preludeLines.push("Do not modify any files. Do not run any commands. Output only a concise bullet plan.")
  } else {
    preludeLines.push("Prefer apply_patch-style edits when modifying files.")
  }
  const prompt = `${preludeLines.join("\n")}\n\nUSER:\n${String(request.prompt ?? "")}`

  args.push(prompt)

  const env = { ...process.env, HOME: codexHomeDir }

  let agentMessage = ""
  const fileChanges = new Set()
  const proc = spawn("codex", args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] })

  let cancelled = false
  const cancel = () => {
    cancelled = true
    try { proc.kill("SIGKILL") } catch {}
  }

  if (uiEventsPath) {
    const k = phase === "think" ? "think" : "info"
    const msg = phase === "think" ? "Planning (Codex CLI)..." : `codex exec started (cwd=${resolvedCwd})`
    emitCodexTurnEvent(uiEventsPath, request.correlationId, { kind: k, message: msg })
  }

  let stdoutBuf = ""
  proc.stdout.on("data", (d) => {
    stdoutBuf += d.toString("utf8")
    for (;;) {
      const idx = stdoutBuf.indexOf("\n")
      if (idx === -1) break
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      let ev = null
      try { ev = JSON.parse(line) } catch { continue }

      appendJsonl(eventsPath, { correlationId: request.correlationId, at: nowIso(), event: ev })

      if (ev?.type === "item.completed" && ev?.item?.type === "agent_message" && typeof ev.item.text === "string") {
        agentMessage = ev.item.text
      }
      if (ev?.type === "item.completed" && ev?.item?.type === "file_change" && Array.isArray(ev?.item?.changes)) {
        for (const c of ev.item.changes) {
          if (typeof c?.path === "string") fileChanges.add(c.path)
        }
      }

      // Best-effort: convert tool events into cockpit stream events.
      if (uiEventsPath && (ev?.type === "item.completed" || ev?.type === "item.started") && ev?.item && typeof ev.item === "object") {
        const it = ev.item
        const itType = String(it.type ?? "").trim()
        if (itType === "command_execution") {
          const cmd = truncate(it.command, 220)
          if (cmd) {
            if (ev.type === "item.started") {
              emitCodexTurnEvent(uiEventsPath, request.correlationId, { kind: "tool_use", tool: "bash", message: cmd })
            } else {
              const exitCode = it.exit_code ?? it.exitCode ?? null
              const suffix = exitCode === null || exitCode === undefined ? "" : ` (exit=${exitCode})`
              emitCodexTurnEvent(uiEventsPath, request.correlationId, { kind: "tool_use", tool: "bash", message: cmd + suffix })
            }
          }
        }
        if (itType === "reasoning" && ev.type === "item.completed" && typeof it.text === "string") {
          emitReasoningAsThink(uiEventsPath, request.correlationId, it.text)
        }
        if (itType === "tool_call" || itType === "tool" || itType === "tool_use") {
          const tool = String(it.name ?? it.tool ?? it.tool_name ?? it.call?.name ?? "tool").trim()
          const title = String(it.title ?? "").trim()
          const summary = title || safeToolSummary(it.input ?? it.arguments) || "(details)"
          emitCodexTurnEvent(uiEventsPath, request.correlationId, { kind: "tool_use", tool, message: summary })
        }
        if (itType === "file_change") {
          const changes = Array.isArray(it.changes) ? it.changes : []
          if (changes.length) {
            const p = changes[0]?.path
            if (typeof p === "string" && p.trim()) {
              emitCodexTurnEvent(uiEventsPath, request.correlationId, { kind: "tool_use", tool: "edit", message: p.trim() })
            }
          }
        }
      }
    }
  })

  proc.stderr.on("data", () => {})

  proc.on("close", (code) => {
    out.endedAt = nowIso()
    if (cancelled) {
      out.ok = false
      out.error = "cancelled"
      out.fileChanges = Array.from(fileChanges)
    } else if (code === 0) {
      out.ok = true
      out.content = agentMessage || ""
      out.fileChanges = Array.from(fileChanges)
    } else {
      out.ok = false
      out.error = `codex exitCode=${code ?? "?"}`
      out.fileChanges = Array.from(fileChanges)
    }

    appendJsonl(eventsPath, {
      correlationId: request.correlationId,
      at: nowIso(),
      event: { type: "workbench.codex.exec.completed", ok: out.ok, profileName, model, cwd: resolvedCwd, exitCode: code ?? null, cancelled },
    })

    if (uiEventsPath) {
      emitCodexTurnEvent(uiEventsPath, request.correlationId, { kind: "info", message: `codex exec completed (ok=${out.ok})` })
    }

    onDone(out)
  })

  return { proc, cancel, startedAt }
}

async function main() {
  const args = parseArgs(process.argv)
  const stateDir = args.stateDir ? path.resolve(args.stateDir) : path.resolve(process.env.WORKBENCH_STATE_DIR || ".workbench")
  const repoRoot = path.resolve(args.repoRoot || process.cwd())

  let sessionId = ensureSessionId(stateDir)
  let sessionDir = path.join(stateDir, sessionId)
  ensureDir(sessionDir)

  let requestsPath = path.join(sessionDir, "codex.requests.jsonl")
  let responsesPath = path.join(sessionDir, "codex.responses.jsonl")
  let uiEventsPath = path.join(sessionDir, "codex.events.jsonl")
  let readyPath = path.join(sessionDir, "codex.executor.json")

  if (!fs.existsSync(requestsPath)) fs.writeFileSync(requestsPath, "", "utf8")
  if (!fs.existsSync(responsesPath)) fs.writeFileSync(responsesPath, "", "utf8")
  if (!fs.existsSync(uiEventsPath)) fs.writeFileSync(uiEventsPath, "", "utf8")

  const codexHomeDir = path.join(stateDir, "codex_home")
  ensureDir(path.join(codexHomeDir, ".codex"))

  let offset = 0
  /** @type {{ correlationId: string, proc: any } | null} */
  let inFlight = null

  const touchReady = () => {
    writeJson(readyPath, { version: 1, pid: process.pid, sessionId, updatedAt: nowIso(), requestsPath, responsesPath, uiEventsPath }, 0o644)
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

    requestsPath = path.join(sessionDir, "codex.requests.jsonl")
    responsesPath = path.join(sessionDir, "codex.responses.jsonl")
    uiEventsPath = path.join(sessionDir, "codex.events.jsonl")
    readyPath = path.join(sessionDir, "codex.executor.json")

    if (!fs.existsSync(requestsPath)) fs.writeFileSync(requestsPath, "", "utf8")
    if (!fs.existsSync(responsesPath)) fs.writeFileSync(responsesPath, "", "utf8")
    if (!fs.existsSync(uiEventsPath)) fs.writeFileSync(uiEventsPath, "", "utf8")

    touchReady()
  }

  while (true) {
    await new Promise((r) => setTimeout(r, 200))

    // Follow the current session pointer.
    const desired = readCurrentSessionId(stateDir) || sessionId
    if (desired !== sessionId) {
      switchSession(desired)
      continue
    }

    let st = null
    try { st = fs.statSync(requestsPath) } catch { continue }
    if (offset > st.size) offset = st.size

    if (offset === st.size) continue

    const fd = fs.openSync(requestsPath, "r")
    const buf = Buffer.alloc(st.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = st.size

    const lines = buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      let req = null
      try { req = JSON.parse(line) } catch { continue }
      if (!req || req.version !== 1) continue
      if (typeof req.correlationId !== "string" || !req.correlationId.trim()) continue
      if (req.type === "cancel") {
        if (inFlight && inFlight.correlationId === req.correlationId && typeof inFlight.cancel === "function") {
          inFlight.cancel()
        }
        continue
      }
      if (req.type !== "turn") continue
      if (inFlight) {
        appendJsonl(responsesPath, { version: 1, type: "turn.result", correlationId: req.correlationId, ok: false, error: "executor busy" })
        continue
      }
      try {
        const started = nowIso()
        const writeResult = (result) => {
          appendJsonl(responsesPath, {
            version: 1,
            type: "turn.result",
            correlationId: req.correlationId,
            ok: result.ok,
            content: result.content,
            error: result.error,
            fileChanges: result.fileChanges,
            startedAt: result.startedAt || started,
            endedAt: result.endedAt,
          })
          inFlight = null
        }

        if (req.think === true) {
          const planReq = {
            ...req,
            noShell: true,
            prompt:
              "Write a concise bullet plan. Do not modify any files. Do not run any commands. Do not include the final answer.\n\nTASK:\n" +
              String(req.prompt ?? ""),
          }
          const planDone = (planResult) => {
            if (!planResult.ok) {
              emitCodexTurnEvent(uiEventsPath, req.correlationId, { kind: "error", message: planResult.error || "planning failed" })
              writeResult(planResult)
              return
            }
            const lines = String(planResult.content ?? "")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
            for (const l of lines) {
              emitCodexTurnEvent(uiEventsPath, req.correlationId, { kind: "think", message: l })
            }

            const runTurn = startCodexTurn({
              repoRoot,
              stateDir,
              sessionId,
              request: { ...req, think: false },
              codexHomeDir,
              uiEventsPath,
              phase: "run",
              onDone: writeResult,
            })
            inFlight = { correlationId: req.correlationId, proc: runTurn.proc, cancel: runTurn.cancel }
          }

          const planTurn = startCodexTurn({
            repoRoot,
            stateDir,
            sessionId,
            request: planReq,
            codexHomeDir,
            uiEventsPath,
            phase: "think",
            onDone: planDone,
          })
          inFlight = { correlationId: req.correlationId, proc: planTurn.proc, cancel: planTurn.cancel }
          continue
        }

        const startedTurn = startCodexTurn({ repoRoot, stateDir, sessionId, request: req, codexHomeDir, uiEventsPath, phase: "run", onDone: writeResult })
        inFlight = { correlationId: req.correlationId, proc: startedTurn.proc, cancel: startedTurn.cancel }
      } catch (e) {
        appendJsonl(responsesPath, { version: 1, type: "turn.result", correlationId: req.correlationId, ok: false, error: String(e?.message ?? e) })
        inFlight = null
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
