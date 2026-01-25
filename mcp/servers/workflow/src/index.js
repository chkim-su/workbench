import { createMcpStdioServer } from "../../../kit/src/index.js"
import { WorkflowStore } from "../../../../state/src/index.js"

const server = createMcpStdioServer({ name: "workbench.workflow", version: "0.0.0" })
const store = new WorkflowStore()

function okJson(json) {
  return { content: [{ type: "json", json }] }
}

server.tool(
  {
    name: "workbench.workflow.validate",
    description: "Validate a workflow definition payload.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { workflow: { type: "object" } },
    },
  },
  async (args) => {
    const a = args ?? {}
    return okJson(store.validate(a.workflow))
  },
)

server.tool(
  {
    name: "workbench.workflow.upload",
    description: "Upload a workflow definition and create initial status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { workflow: { type: "object" } },
    },
  },
  async (args) => {
    const a = args ?? {}
    const validated = store.validate(a.workflow)
    if (!validated.valid) return okJson(validated)
    const status = await store.upload(validated.workflow)
    return okJson(status)
  },
)

server.tool(
  {
    name: "workbench.workflow.status",
    description: "Get workflow definition and status for a workflow id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  async (args) => {
    const a = args ?? {}
    const id = a.id
    if (typeof id !== "string" || !id) {
      return { content: [{ type: "text", text: "Missing required field: id" }], isError: true }
    }
    const [def, status] = await Promise.all([store.getDefinition(id), store.getStatus(id)])
    return okJson({ definition: def, status })
  },
)

server.tool(
  {
    name: "workbench.workflow.update",
    description: "Update workflow status fields for a workflow id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        note: { type: "string" },
        data: { type: "object" },
      },
    },
  },
  async (args) => {
    const a = args ?? {}
    const id = a.id
    if (typeof id !== "string" || !id) {
      return { content: [{ type: "text", text: "Missing required field: id" }], isError: true }
    }
    const next = await store.updateStatus(id, {
      note: typeof a.note === "string" ? a.note : undefined,
      data: typeof a.data === "object" && a.data ? a.data : undefined,
      state: "updated",
    })
    return okJson(next)
  },
)

server.resource(
  {
    uri: "workbench://workflow/help",
    name: "Workflow server help",
    mimeType: "application/json",
  },
  async () => ({
    mimeType: "application/json",
    contents:
      JSON.stringify(
        {
          tools: [
            "workbench.workflow.validate",
            "workbench.workflow.upload",
            "workbench.workflow.status",
            "workbench.workflow.update",
          ],
          stateDir: process.env.WORKBENCH_STATE_DIR ?? ".workbench/",
        },
        null,
        2,
      ) + "\n",
  }),
)

server.start()

