#!/usr/bin/env node
/**
 * Host-side OpenCode runtime executor for the Go TUI.
 *
 * Contract:
 * - Reads requests from:  <stateDir>/<sessionId>/opencode.requests.jsonl
 * - Writes results to:   <stateDir>/<sessionId>/opencode.responses.jsonl
 * - Writes stream events:<stateDir>/<sessionId>/opencode.events.jsonl
 * - Heartbeat file:      <stateDir>/<sessionId>/opencode.executor.json (mtime indicates readiness)
 *
 * Streaming:
 * - Runs `opencode run --format json ...` and converts JSON events into `turn.event` lines
 *   so the managed cockpit can show intermediate tool/step updates.
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"

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

function ensureOpencodeConfig({ stateDir }) {
  const base = path.join(stateDir, "opencode")
  const xdg = {
    XDG_CONFIG_HOME: path.join(base, "xdg", "config"),
    XDG_DATA_HOME: path.join(base, "xdg", "data"),
    XDG_STATE_HOME: path.join(base, "xdg", "state"),
    XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
  }
  for (const p of Object.values(xdg)) ensureDir(p)

  const cfgDir = path.join(xdg.XDG_CONFIG_HOME, "opencode")
  ensureDir(cfgDir)
  const cfgPath = path.join(cfgDir, "config.json")

  return { ...xdg, OPENCODE_TEST_HOME: base }
}

function opencodeBinary() {
  return process.env.WORKBENCH_OPENCODE_BIN?.trim() || "opencode"
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function looksLikeOpencodePlainError(line) {
  const s = String(line || "").trim()
  if (!s) return false
  if (s.startsWith("error:")) return true
  if (s.toLowerCase().includes("unable to connect")) return true
  if (s.toLowerCase().includes("connectionrefused")) return true
  if (s.toLowerCase().includes("connection refused")) return true
  return false
}

function emitTurnEvent(eventsPath, correlationId, { kind, message, tool }) {
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

function summarizeToolUse(part) {
  const tool = String(part?.tool ?? "").trim() || "tool"
  const title = String(part?.state?.title ?? "").trim()
  const input = part?.state?.input && typeof part.state.input === "object" ? part.state.input : null
  const message = title || (input ? JSON.stringify(input) : "(no input)")
  return { tool, message }
}

function extractFileChangesFromTool(part, set) {
  const tool = String(part?.tool ?? "").trim()
  if (!tool) return
  const input = part?.state?.input
  if (!input || typeof input !== "object") return

  const candidates = []
  for (const k of ["path", "file", "filepath", "filename", "target", "pattern"]) {
    const v = input[k]
    if (typeof v === "string" && v.trim()) candidates.push(v.trim())
  }
  for (const c of candidates) {
    // Best-effort: only record plausible paths.
    if (c.includes("/") || c.includes("\\") || c.endsWith(".js") || c.endsWith(".ts") || c.endsWith(".go") || c.endsWith(".py")) {
      set.add(c)
    }
  }
}

function startOpencodeTurn({ repoRoot, stateDir, sessionId, request, onDone }) {
  const startedAt = nowIso()
  const out = { ok: false, content: "", error: "", fileChanges: [], startedAt, endedAt: "" }

  const sessionDir = path.join(stateDir, sessionId)
  const eventsPath = path.join(sessionDir, "opencode.events.jsonl")
  const cwd = normalizeCwd(request.cwd) || repoRoot

  let resolvedCwd = cwd
  try {
    if (!fs.statSync(resolvedCwd).isDirectory()) resolvedCwd = repoRoot
  } catch {
    resolvedCwd = repoRoot
  }

  const xdgEnv = ensureOpencodeConfig({ stateDir })
  const bin = opencodeBinary()

  const agent = String(request.agent ?? "").trim()
  const model = String(request.model ?? "").trim()
  const prompt = String(request.prompt ?? "")
  const wantThink = request.think === true
  const permissionMode = String(request.permissionMode ?? "plan").trim().toLowerCase()

  // Apply permissions per-turn (isolated Workbench config under .workbench/opencode/).
  // Planning: read-only, no bash.
  // Bypass: allow edits + bash (still deny web/external dir for safety/determinism).
  {
    const cfgPath = path.join(xdgEnv.XDG_CONFIG_HOME, "opencode", "config.json")
    const allowEdits = permissionMode === "bypass"
    const allowBash = permissionMode === "bypass"
    const cfg = {
      $schema: "https://opencode.ai/config.json",
      permission: {
        read: "allow",
        edit: allowEdits ? "allow" : "deny",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: allowBash ? "allow" : "deny",
        external_directory: "deny",
        webfetch: "deny",
        websearch: "deny",
        codesearch: "deny",
        doom_loop: "deny",
      },
    }
    writeJson(cfgPath, cfg, 0o600)
  }

  /** @type {import("node:child_process").ChildProcess | null} */
  let inFlightProc = null

  let cancelled = false
  const cancel = () => {
    cancelled = true
    try { inFlightProc?.kill("SIGKILL") } catch {}
  }

  const runOnce = async ({ phaseAgent, phaseName, captureText }) => {
    const args = ["run", "--format", "json"]
    if (phaseAgent) args.push("--agent", phaseAgent)
    else if (agent) args.push("--agent", agent)
    if (model) args.push("--model", model)
    args.push(prompt)

    emitTurnEvent(eventsPath, request.correlationId, {
      kind: phaseName === "think" ? "think" : "info",
      message: phaseName === "think"
        ? "Planning (OpenCode plan agent)..."
        : `opencode run started (cwd=${resolvedCwd}, permissionMode=${permissionMode || "plan"})`,
    })

    let phaseText = ""
    let phaseError = ""
    let lastText = ""
    let sawAnyJson = false
    let plainOut = ""
    let plainLooksError = false
    const proc = spawn(bin, args, { cwd: resolvedCwd, env: { ...process.env, ...xdgEnv, OPENCODE: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    inFlightProc = proc

    let stdoutBuf = ""
    proc.stdout.on("data", (d) => {
      stdoutBuf += d.toString("utf8")
      for (;;) {
        const idx = stdoutBuf.indexOf("\n")
        if (idx === -1) break
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (!line) continue
        const ev = safeJsonParse(line)
        if (!ev || typeof ev !== "object") {
          // OpenCode sometimes prints plaintext errors even in --format json mode.
          // Treat any plaintext output as error signal (we asked for JSON).
          if (plainOut.length < 4096) {
            plainOut += (plainOut ? "\n" : "") + line
          }
          if (looksLikeOpencodePlainError(line)) plainLooksError = true
          continue
        }
        sawAnyJson = true

        if (ev.type === "tool_use") {
          const { tool, message } = summarizeToolUse(ev.part)
          extractFileChangesFromTool(ev.part, fileChanges)
          emitTurnEvent(eventsPath, request.correlationId, { kind: "tool_use", tool, message })
          continue
        }

        if (ev.type === "step_start" || ev.type === "step_finish") {
          const stepType = ev.type === "step_start" ? "step_start" : "step_finish"
          const title = String(ev.part?.state?.title ?? ev.part?.title ?? "").trim()
          emitTurnEvent(eventsPath, request.correlationId, { kind: stepType, message: title || stepType })
          continue
        }

        if (ev.type === "text") {
          const text = String(ev.part?.text ?? "")
          if (text) {
            if (phaseName === "run") {
              const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text
              // Stream deltas to the cockpit (best-effort). Keep chunks bounded.
              if (delta.length) {
                const max = 800
                for (let i = 0; i < delta.length; i += max) {
                  emitTurnEvent(eventsPath, request.correlationId, { kind: "delta", message: delta.slice(i, i + max) })
                }
              }
            }
            lastText = text
            phaseText = text.trim()
          }
          continue
        }

        if (ev.type === "error") {
          const msg = String(ev.error?.message ?? ev.error?.name ?? "error").trim()
          phaseError = phaseError ? `${phaseError}\n${msg}` : msg
          emitTurnEvent(eventsPath, request.correlationId, { kind: "error", message: msg })
          continue
        }
      }
    })

    let stderrBuf = ""
    proc.stderr.on("data", (d) => {
      stderrBuf += d.toString("utf8")
      if (stderrBuf.length > 16_384) stderrBuf = stderrBuf.slice(-16_384)
    })

    const exitCode = await new Promise((resolve) => proc.on("close", resolve))
    if (inFlightProc === proc) inFlightProc = null
    let ok = exitCode === 0 && !phaseError
    if (ok && !sawAnyJson && plainOut.trim()) {
      // If we got non-JSON output in json mode, surface it as an error (even if exitCode=0).
      phaseError = plainOut.trim()
      ok = false
      emitTurnEvent(eventsPath, request.correlationId, { kind: "error", message: phaseError.split("\n")[0].slice(0, 200) })
    }
    if (!ok && !phaseError && stderrBuf.trim()) phaseError = stderrBuf.trim()
    if (!ok && phaseError && plainLooksError) {
      // Also emit a concise error hint for the cockpit.
      emitTurnEvent(eventsPath, request.correlationId, {
        kind: "error",
        message: "OpenCode failed (likely cannot reach models.dev). If offline, switch runtime to Codex – Chat/CLI.",
      })
    }

    if (captureText && phaseText) {
      // Emit one line per non-empty line for a quasi-streaming “thinking” display.
      const lines = phaseText.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
      for (const l of lines) {
        emitTurnEvent(eventsPath, request.correlationId, { kind: "think", message: l.trim() })
      }
    }

    return { ok, phaseText, phaseError }
  }

  let finalText = ""
  let errorText = ""
  const fileChanges = new Set()

  const run = async () => {
    if (wantThink) {
      // First pass: generate a user-facing narrated plan (no private chain-of-thought).
      const planned = await runOnce({ phaseAgent: "plan", phaseName: "think", captureText: true })
      if (!planned.ok) {
        errorText = planned.phaseError || "OpenCode plan phase failed"
        return { ok: false }
      }
    }

    // Second pass: do the actual work with the selected agent (default build).
    if (cancelled) return { ok: false }
    const executed = await runOnce({ phaseAgent: null, phaseName: "run", captureText: false })
    if (!executed.ok) {
      errorText = executed.phaseError || "OpenCode run failed"
      return { ok: false }
    }
    finalText = executed.phaseText || ""
    return { ok: true }
  }

  void run().then((result) => {
    out.endedAt = nowIso()

    if (cancelled) {
      out.ok = false
      out.error = "cancelled"
    } else {
      out.ok = result.ok === true && !errorText
      out.content = out.ok ? (finalText || "") : ""
      out.error = out.ok ? "" : (errorText || "OpenCode run failed")
    }

    out.fileChanges = Array.from(fileChanges)

    emitTurnEvent(eventsPath, request.correlationId, { kind: "info", message: `opencode run completed (ok=${out.ok})` })

    onDone(out)
  })

  return { proc: inFlightProc, cancel, startedAt }
}

async function main() {
  const args = parseArgs(process.argv)
  const stateDir = args.stateDir ? path.resolve(args.stateDir) : path.resolve(process.env.WORKBENCH_STATE_DIR || ".workbench")
  const repoRoot = path.resolve(args.repoRoot || process.cwd())

  let sessionId = ensureSessionId(stateDir)
  let sessionDir = path.join(stateDir, sessionId)
  ensureDir(sessionDir)

  let requestsPath = path.join(sessionDir, "opencode.requests.jsonl")
  let responsesPath = path.join(sessionDir, "opencode.responses.jsonl")
  let eventsPath = path.join(sessionDir, "opencode.events.jsonl")
  let readyPath = path.join(sessionDir, "opencode.executor.json")

  for (const p of [requestsPath, responsesPath, eventsPath]) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8")
  }

  let offset = 0
  let inFlight = null

  const touchReady = () => {
    writeJson(readyPath, { version: 1, pid: process.pid, sessionId, updatedAt: nowIso(), requestsPath, responsesPath, eventsPath }, 0o644)
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

    requestsPath = path.join(sessionDir, "opencode.requests.jsonl")
    responsesPath = path.join(sessionDir, "opencode.responses.jsonl")
    eventsPath = path.join(sessionDir, "opencode.events.jsonl")
    readyPath = path.join(sessionDir, "opencode.executor.json")

    for (const p of [requestsPath, responsesPath, eventsPath]) {
      if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8")
    }
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
      const req = safeJsonParse(line)
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
        const handleDone = (result) => {
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
        const startedTurn = startOpencodeTurn({ repoRoot, stateDir, sessionId, request: req, onDone: handleDone })
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
