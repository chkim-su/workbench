# SPEC: MCP Control Plane

## Local server manifest (`mcp/servers/*/manifest.json`)

`version: 1`

```jsonc
{
  "version": 1,
  "name": "workbench.workflow",
  "description": "…",
  "transport": "stdio",
  "command": ["bun", "mcp/servers/workflow/src/index.js"],
  "cwd": "."
}
```

## Registry state

Stored at `.workbench/registry/mcp.json` (override base dir with `WORKBENCH_STATE_DIR`).

The registry is updated by the registry MCP server (`workbench.registry.scan`).
