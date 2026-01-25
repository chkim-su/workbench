# Workflow MCP server

Run: `bun mcp/servers/workflow/src/index.js`

Writes state under `.workbench/workflows/<id>/` (override base with `WORKBENCH_STATE_DIR`).

Tools:
- `workbench.workflow.validate`
- `workbench.workflow.upload`
- `workbench.workflow.status`
- `workbench.workflow.update`

Resources:
- `workbench://workflow/help`
