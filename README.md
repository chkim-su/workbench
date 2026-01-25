# My LLM Workbench

An execution environment for running LLM sessions with MCP (Model Context Protocol) control, reproducible verification, and durable observability.

## Quick Start (WSL/Linux)

```bash
git clone https://github.com/chkim-su/workbench.git
cd workbench
bash install.sh
```

The installer will:
- Auto-install missing dependencies (node, bun, python3) on Ubuntu/Debian/Fedora
- Set up the project with `bun install`
- Run verification gates
- Add `workbench` command to your PATH

Then run:
```bash
workbench
```

## Features

- **MCP Control Plane**: Registry, workflow, and Docker MCP servers
- **Multiple TUI Options**: Bubble Tea (Go) or Ink (Node.js) interfaces
- **Provider Support**: Claude Code, OpenAI Codex, OpenCode
- **Verification Gates**: Automated testing and validation
- **Durable Evidence**: All operations logged to `.workbench/`

## Project Structure

```
mcp/           # Control plane (MCP servers + shared kit)
workflow/      # Optional structuring wrapper (state/logs)
docker/        # Verification harness (compose/runs/log capture)
tui/           # UI surfaces (Bubble Tea Go, Ink Node.js)
bin/           # CLI entrypoint
verify/        # Verification gates
```

## Commands

```bash
# Launch TUI (default)
workbench

# Run verification gates
workbench verify

# Start individual MCP servers
bun mcp/servers/registry/src/index.js
bun mcp/servers/workflow/src/index.js
bun mcp/servers/docker/src/index.js
```

## Documentation

- [INSTALL.md](INSTALL.md) - Detailed installation options and prerequisites
- [CLAUDE.md](CLAUDE.md) - Agent behavior contract

## License

MIT License - see [LICENSE](LICENSE)
