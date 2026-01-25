import { spawn } from "node:child_process"
import { StdioMessageCodec } from "./stdio-framing.js"

export class StdioJsonRpcClient {
  /** @param {import("node:child_process").ChildProcessWithoutNullStreams} proc */
  constructor(proc) {
    this.proc = proc
    this.codec = new StdioMessageCodec()
    this.nextId = 1
    /** @type {Map<number, {resolve: (v:any)=>void, timer: any}>} */
    this.pending = new Map()
    /** @type {Buffer[]} */
    this.stderrChunks = []

    proc.stdout.on("data", (chunk) => {
      const msgs = this.codec.push(Buffer.from(chunk))
      for (const m of msgs) this.#onMessage(m)
    })
    proc.stderr.on("data", (chunk) => {
      this.stderrChunks.push(Buffer.from(chunk))
    })
    proc.on("exit", () => {
      for (const [id, p] of this.pending.entries()) {
        clearTimeout(p.timer)
        p.resolve(makeErrorResponse(id, `process exited before response (id=${id})`))
      }
      this.pending.clear()
    })
  }

  /** @param {string[]} command */
  static spawn(command, opts = {}) {
    const [cmd, ...args] = command
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd, env: opts.env })
    return new StdioJsonRpcClient(proc)
  }

  async initialize(timeoutMs = 10_000) {
    return await this.request(
      "initialize",
      { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "workbench", version: "0.0.0" } },
      timeoutMs,
    )
  }

  async toolsList(timeoutMs = 10_000) {
    return await this.request("tools/list", undefined, timeoutMs)
  }

  async toolsCall(name, args, timeoutMs = 10_000) {
    return await this.request("tools/call", { name, arguments: args }, timeoutMs)
  }

  /** @param {string} method */
  request(method, params, timeoutMs = 10_000) {
    const id = this.nextId++
    const payload = { jsonrpc: "2.0", id, method, params }
    const buf = this.codec.encode(payload)
    this.proc.stdin.write(buf)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(makeErrorResponse(id, `Timed out waiting for jsonrpc response id=${id} after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, { resolve, timer })
    })
  }

  kill() {
    this.proc.kill()
  }

  /** @returns {Promise<number | null>} */
  async exited() {
    return await new Promise((resolve) => this.proc.on("close", (code) => resolve(code)))
  }

  stderrText() {
    return Buffer.concat(this.stderrChunks).toString("utf8")
  }

  #onMessage(m) {
    if (!m || typeof m !== "object") return
    if (!Object.prototype.hasOwnProperty.call(m, "id")) return
    const id = m.id
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(m)
  }
}

function makeErrorResponse(id, message) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } }
}
