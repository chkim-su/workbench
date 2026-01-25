# Docker MCP server

Run: `bun mcp/servers/docker/src/index.js`

Tools:
- `workbench.docker.version`
- `workbench.docker.probe`
- `workbench.docker.ps`
- `workbench.docker.logs`
- `workbench.docker.run`

Notes:
- Only `workbench.docker.version` works without a running Docker daemon.
- Other tools return stderr + exit code if the daemon is unavailable.
- `workbench.docker.run` writes artifacts under `.workbench/verify/docker/<runId>/`.
