import { StdioMessageCodec } from "./stdio-framing.js"

export class McpStdioServer {
  /**
   * @param {{name: string; version: string}} info
   * @param {{
   *  tools: Map<string, {def: any, handler: (args: unknown) => any | Promise<any>}>,
   *  resources: Map<string, {def: any, reader: () => any | Promise<any>}>,
   *  prompts: Map<string, {def: any, getter: (args: unknown) => any | Promise<any>}>,
   * }} handlers
   */
  constructor(info, handlers) {
    this.info = info
    this.handlers = handlers
    this.codec = new StdioMessageCodec()
  }

  start() {
    process.stdin.resume()
    // Node does not reliably keep the process alive on stdin alone when run under stdio pipes.
    // Keep the event loop alive while stdin is open.
    const keepAlive = setInterval(() => {}, 60 * 60 * 1000)
    process.stdin.on("data", (chunk) => {
      const messages = this.codec.push(Buffer.from(chunk))
      for (const msg of messages) void this.#handleIncoming(msg)
    })
    // Do not clear the keepalive on stdin close/end here; some environments report
    // stdin close immediately even when a pipe is intended to remain open.
    void keepAlive
  }

  async #handleIncoming(message) {
    if (!message || typeof message !== "object") return

    const method = message.method
    const isRequest = typeof method === "string" && Object.prototype.hasOwnProperty.call(message, "id")
    const isNotification = typeof method === "string" && !Object.prototype.hasOwnProperty.call(message, "id")

    if (!isRequest && !isNotification) return

    if (isNotification) {
      return
    }

    const req = /** @type {{jsonrpc: "2.0", id: any, method: string, params?: any}} */ (message)
    try {
      const result = await this.#dispatch(req.method, req.params)
      this.#write({ jsonrpc: "2.0", id: req.id, result })
    } catch (err) {
      this.#write({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: err instanceof Error ? err.message : "Unknown error" },
      })
    }
  }

  async #dispatch(method, params) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          serverInfo: this.info,
          capabilities: {
            tools: { listChanged: false },
            resources: {},
            prompts: {},
          },
        }
      case "ping":
        return {}
      case "tools/list":
        return { tools: [...this.handlers.tools.values()].map((t) => normalizeTool(t.def)) }
      case "tools/call": {
        const name = params?.name
        const args = params?.arguments
        if (!name) throw new Error("Missing tool name")
        const tool = this.handlers.tools.get(name)
        if (!tool) throw new Error(`Unknown tool: ${name}`)
        return await tool.handler(args)
      }
      case "resources/list":
        return { resources: [...this.handlers.resources.values()].map((r) => r.def) }
      case "resources/read": {
        const uri = params?.uri
        if (!uri) throw new Error("Missing resource uri")
        const res = this.handlers.resources.get(uri)
        if (!res) throw new Error(`Unknown resource: ${uri}`)
        const read = await res.reader()
        return { contents: [{ uri, mimeType: read.mimeType, text: read.contents }] }
      }
      case "prompts/list":
        return { prompts: [...this.handlers.prompts.values()].map((p) => p.def) }
      case "prompts/get": {
        const name = params?.name
        if (!name) throw new Error("Missing prompt name")
        const prompt = this.handlers.prompts.get(name)
        if (!prompt) throw new Error(`Unknown prompt: ${name}`)
        return await prompt.getter(params?.arguments)
      }
      case "notifications/initialized":
        return
      default:
        throw new Error(`Method not found: ${method}`)
    }
  }

  #write(payload) {
    const out = this.codec.encode(payload)
    process.stdout.write(out)
  }
}

export function createMcpStdioServer(info) {
  const handlers = {
    tools: new Map(),
    resources: new Map(),
    prompts: new Map(),
  }

  return {
    tool(def, handler) {
      handlers.tools.set(def.name, { def, handler })
    },
    resource(def, reader) {
      handlers.resources.set(def.uri, { def, reader })
    },
    prompt(def, getter) {
      handlers.prompts.set(def.name, { def, getter })
    },
    start() {
      const server = new McpStdioServer(info, handlers)
      server.start()
    },
  }
}

function normalizeTool(def) {
  if (def && typeof def === "object" && def.inputSchema) return def
  return { ...(def ?? {}), inputSchema: { type: "object", properties: {}, additionalProperties: false } }
}
