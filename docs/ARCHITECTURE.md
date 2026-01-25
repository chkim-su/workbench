# Architecture

## Goal

MCP-first workbench where **MCP servers are the control plane**, and everything else (workflow wrapper, Docker harness, UI surfaces) is operated through MCP rather than ad-hoc CLIs.

## Control Plane vs Experiment Plane (Non-negotiable)

**Control plane (host, Workbench-owned):**
- UI surfaces (TUI/CLI)
- OAuth pools + auth storage under `.workbench/auth/`
- Command bus + durable logs/artifacts under `.workbench/`
- MCP registry + MCP server orchestration (stdio JSON-RPC)

**Experiment plane (managed resources; Docker is one option):**
- Verification harness runs (gates)
- Disposable sandboxes for testing providers/proxies/agents
- Optional self-dogfooding runs of Workbench components (explicitly classified as such)

Docker is a **managed resource** controlled by the workbench (typically via the Docker MCP server). It is not the default “runtime boundary” of the control plane.

## Execution Modes Inventory (Explicit)

**Host-by-default (must remain host-capable; must not require Docker):**
- `workbench` CLI dispatcher + JSON mode (`cli/`)
- Go Bubble Tea TUI when Go is installed (`ui/tui` via `go run .`)
- OAuth pool management (`runner/auth/*` writing under `.workbench/auth/`)
- Verification entrypoint `node verify/run.js` (Docker usage is gated/optional)

**Optionally runnable in Docker (experiment plane):**
- Docker-based verify gates (e.g. TUI smoke, replay determinism) driven via MCP (`verify/run.js`)
- Any “workbench inside Docker” scenario (only as sandbox/dogfooding; never implied as required)

**Must never be forced into Docker:**
- Durable state layout and schemas under `.workbench/` (must be host-readable/writable)
- OAuth pool selection/swap logic (must remain deterministic and host-operable)
- MCP registry + workflow control paths (must not assume Docker presence)

## Adapters / Sidecars (Clarify intent)

Some helpers may run as **host-side sidecars** to keep the UI pure (SRP) and to preserve determinism:
- “Codex runtime executor” sidecar: executes `codex exec` on the host using Workbench OAuth pool; writes results as JSONL under `.workbench/<session>/`.
- “System executor” sidecar: runs system actions (e.g. `verify`, `docker.probe`) and reports results as JSONL under `.workbench/<session>/`.

These are **not** “escaping Docker” as a core architecture. They are control-plane components that can also bridge a dockerized/self-dogfooding UI run back to host capabilities when that *optional* containment is used.

## Repository layout (current)

```
mcp/
  kit/                 # Shared MCP stdio + JSON-RPC helpers (no external deps)
  servers/
    registry/          # Discovery + persisted registry scan results
    workflow/          # Minimal workflow wrapper (upload/validate/status/update)
    docker/            # Docker harness operations (version/ps/logs/run)
state/                 # Vendor-neutral state (registry + workflows + verify artifacts)
verify/                # Reproducible verification entrypoints (real-test gates)
docs/                  # PLAN/SPEC/TESTPLAN/architecture
ui/                    # UI surfaces (placeholder)
docker/                # Docker harness assets (placeholder, see migration notes)
workflow/              # Workflow-related components (daemon placeholder)
```

## Legacy mapping (reference-only)

Sources:
- `csc`: `/home/chanhokim/projects/new_project/csc`
- `docker sandbox`: `/home/chanhokim/projects/new_project/docker`
- `opencode-dev`: `/mnt/c/Users/chanhokim/Downloads/opencode-dev/opencode-dev`

Mapping intent:
- `csc/workflow-daemon` → future `workflow/daemon/` service (SSOT), controlled via MCP adapter.
- `csc/workflow-mcp` → future `mcp/servers/workflow-daemon-adapter/` (stdio MCP → HTTP daemon).
- `docker/docker/*` → `docker/` harness assets (Dockerfile/compose/scripts).
- `docker/mcp-server/*` → tool set patterns and safety checks for Docker/tmux/workspace servers.
- `opencode-dev` → config + MCP patterns (schemas/ideas only; no bulk code reuse).
