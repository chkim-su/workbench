# Registry MCP server

Run: `bun mcp/servers/registry/src/index.js`

Purpose:
- Discover local server manifests in `mcp/servers/*/manifest.json`
- Handshake each server and list tools
- Persist results to `.workbench/registry/mcp.json`

Tools:
- `workbench.registry.get`
- `workbench.registry.list_manifests`
- `workbench.registry.scan`

Notes:
- `workbench.registry.scan` runs `verify/scan_registry.py` (Python) to perform stdio handshakes/tool listing and update `.workbench/registry/mcp.json`.
