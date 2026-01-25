import test from "node:test"
import assert from "node:assert/strict"
import { StdioJsonRpcClient } from "../mcp/kit/src/index.js"

test("workflow MCP server responds to initialize and tools/list", async () => {
  const client = StdioJsonRpcClient.spawn(["bun", "mcp/servers/workflow/src/index.js"], { cwd: process.cwd(), env: process.env })
  try {
    const init = await client.initialize(10_000)
    assert.ok(init.result?.serverInfo?.name === "workbench.workflow")

    const tools = await client.toolsList(10_000)
    const names = (tools.result?.tools ?? []).map((t) => t.name)
    assert.ok(names.includes("workbench.workflow.upload"))
  } finally {
    client.kill()
  }
})
