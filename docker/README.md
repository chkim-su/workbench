# Docker harness

This directory is reserved for Docker-based verification harnesses (compose files, reproducible runs, log capture).

The MCP server that operates Docker lives under `mcp/servers/docker`.

## Included harnesses

- `docker/sandbox/`: isolated Claude Code test environment (derived from your existing docker sandbox project, but credential-safe by default).
