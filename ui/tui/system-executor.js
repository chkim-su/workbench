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

function ensureSessionId(stateDir) {
  const currentPath = path.join(stateDir, "state", "current.json")
  ensureDir(path.dirname(currentPath))
  let cur = { schemaVersion: 1 }
  if (fs.existsSync(currentPath)) {
    try {
      cur = readJson(currentPath)
    } catch {}
  }
  if (typeof cur.sessionId === "string" && cur.sessionId.trim()) return cur.sessionId.trim()
  const id = randomSessionId()
  cur.sessionId = id
  cur.updatedAt = nowIso()
  writeJson(currentPath, cur, 0o644)
  return id
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

async function main() {
  const args = parseArgs(process.argv)
  const stateDir = args.stateDir ? path.resolve(args.stateDir) : path.resolve(process.env.WORKBENCH_STATE_DIR || ".workbench")
  const repoRoot = path.resolve(args.repoRoot || process.cwd())

  const sessionId = ensureSessionId(stateDir)
  const sessionDir = path.join(stateDir, sessionId)
  ensureDir(sessionDir)
  ensureDir(path.join(sessionDir, "system"))

  const requestsPath = path.join(sessionDir, "system.requests.jsonl")
  const responsesPath = path.join(sessionDir, "system.responses.jsonl")
  const readyPath = path.join(sessionDir, "system.executor.json")

  if (!fs.existsSync(requestsPath)) fs.writeFileSync(requestsPath, "", "utf8")
  if (!fs.existsSync(responsesPath)) fs.writeFileSync(responsesPath, "", "utf8")

  let offset = 0
  let inFlight = null

  const touchReady = () => {
    writeJson(readyPath, { version: 1, pid: process.pid, sessionId, updatedAt: nowIso(), requestsPath, responsesPath }, 0o644)
  }
  touchReady()
  setInterval(() => touchReady(), 5_000)

  while (true) {
    await new Promise((r) => setTimeout(r, 200))

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
