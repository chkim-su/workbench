const HEADER_SEPARATOR = "\r\n\r\n"

export class StdioMessageCodec {
  constructor() {
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0)
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    /** @type {unknown[]} */
    const messages = []

    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR)

      if (headerEnd !== -1) {
        const headerText = this.buffer.subarray(0, headerEnd).toString("utf8")
        const contentLength = parseContentLength(headerText)
        if (contentLength === null) break

        const bodyStart = headerEnd + HEADER_SEPARATOR.length
        const bodyEnd = bodyStart + contentLength
        if (this.buffer.length < bodyEnd) break

        const bodyBytes = this.buffer.subarray(bodyStart, bodyEnd)
        this.buffer = this.buffer.subarray(bodyEnd)

        try {
          messages.push(JSON.parse(bodyBytes.toString("utf8")))
        } catch (e) {
          // Skip malformed JSON messages instead of crashing
          console.error("[MCP] Failed to parse JSON message:", e.message)
        }
        continue
      }

      const newline = this.buffer.indexOf("\n")
      if (newline === -1) break

      const line = this.buffer.subarray(0, newline + 1).toString("utf8").trim()
      this.buffer = this.buffer.subarray(newline + 1)
      if (!line) continue
      try {
        messages.push(JSON.parse(line))
      } catch (e) {
        // Skip malformed JSON lines instead of crashing
        console.error("[MCP] Failed to parse JSON line:", e.message)
      }
    }

    return messages
  }

  /** @param {unknown} message */
  encode(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8")
    const header = Buffer.from(`Content-Length: ${body.length}${HEADER_SEPARATOR}`, "utf8")
    return Buffer.concat([header, body])
  }
}

/** @param {string} headerText */
function parseContentLength(headerText) {
  const lines = headerText.split("\r\n")
  for (const line of lines) {
    const [k, v] = line.split(":").map((s) => s.trim())
    if (!k || !v) continue
    if (k.toLowerCase() === "content-length") {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) return null
      return n
    }
  }
  return null
}

