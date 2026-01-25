import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createMcpStdioServer } from "../../../kit/src/index.js"
import { McpRegistryStore } from "../../../../state/src/index.js"

const server = createMcpStdioServer({ name: "workbench.registry", version: "0.0.0" })
const store = new McpRegistryStore()

server.tool(
  { name: "workbench.registry.get", description: "Get the persisted MCP registry (.workbench/registry/mcp.json)." },
  async () => ({ content: [{ type: "json", json: await store.get() }] }),
)

server.tool(
  {
    name: "workbench.registry.list_manifests",
    description: "List MCP server manifests discovered under mcp/servers/*/manifest.json (no handshake).",
  },
  async () => ({ content: [{ type: "json", json: await discoverManifests(process.cwd()) }] }),
)

server.tool(
  {
    name: "workbench.registry.scan",
    description: "Discover manifests, handshake each server, list tools, and persist results.",
    inputSchema: { type: "object", additionalProperties: false, properties: { timeoutMs: { type: "number" } } },
  },
  async (args) => {
    const a = args ?? {}
    const timeoutMs = typeof a.timeoutMs === "number" && Number.isFinite(a.timeoutMs) ? Math.max(250, Math.min(30_000, a.timeoutMs)) : 10_000
    if (typeof Bun === "undefined") {
      return {
        content: [{ type: "text", text: "registry.scan requires bun runtime (uses Bun.spawn to run verify/scan_registry.py)" }],
        isError: true,
      }
    }

    const proc = Bun.spawn(["python3", "verify/scan_registry.py", "--timeout-ms", String(timeoutMs)], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
      env: process.env,
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      return {
        content: [{ type: "text", text: `scan helper failed (exit=${exitCode})\n${stderr || stdout}`.trim() }],
        isError: true,
      }
    }

    const parsed = JSON.parse(stdout || "{}")
    return { content: [{ type: "json", json: parsed }] }
  },
)

server.start()

async function discoverManifests(repoRoot) {
  const serversDir = join(repoRoot, "mcp", "servers")
  const items = await readdir(serversDir, { withFileTypes: true }).catch(() => [])
  const manifests = []

  for (const item of items) {
    if (!item.isDirectory()) continue
    const manifestPath = join(serversDir, item.name, "manifest.json")
    const raw = await readFile(manifestPath, "utf8").catch(() => null)
    if (!raw) continue
    const parsed = JSON.parse(raw)
    const m = validateManifest(parsed)
    if (m) manifests.push(m)
  }

  return manifests
}

function validateManifest(input) {
  if (!input || typeof input !== "object") return null
  const v = input
  if (v.version !== 1) return null
  if (typeof v.name !== "string" || !v.name) return null
  if (v.transport !== "stdio") return null
  if (!Array.isArray(v.command) || !v.command.every((x) => typeof x === "string" && x)) return null

  return {
    version: 1,
    name: v.name,
    description: typeof v.description === "string" ? v.description : undefined,
    transport: "stdio",
    command: v.command,
    cwd: typeof v.cwd === "string" ? v.cwd : undefined,
  }
}

function resolveCwd(repoRoot, cwd) {
  if (!cwd) return repoRoot
  if (cwd === ".") return repoRoot
  return join(repoRoot, cwd)
}
