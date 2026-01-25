# PLAN (Frozen) — Connectivity + Docker Dogfooding

## Objective (frozen)

Implement **LLM connectivity** and **Docker enablement** first so ongoing development is continuously validated via dogfooding.

“Connectivity” means a real end-to-end tool loop:
`LLM → MCP tool call → stdio JSON-RPC → result → LLM next step`, with durable logs/state.

“Docker enablement” means verification gate4 is runnable and reproducible (not “implemented but failing”).

Mode: **Mode B** (compatibility).

## Done criteria (non-negotiable)

### Work Item A — Workbench Runner (LLM tool-loop)
- A runnable workbench runner exists that:
  - uses an SDK/API provider adapter (CLI is not the default path),
  - discovers MCP servers via registry/discovery,
  - routes tool calls to stdio MCP servers,
  - persists evidence for every tool call.
- A reproducible smoke scenario exists where the **LLM triggers MCP calls** to:
  - obtain a tool list via the registry path,
  - upload a minimal workflow,
  - status → update → status,
  - and leaves durable evidence artifacts.
 - A deterministic offline/mock provider exists so the tool-loop can be validated without network/credentials.

### Work Item B — Docker enablement
- Add a Docker capability probe that reports daemon availability, socket accessibility, permission failures, and actionable next steps.
- Define exactly one deterministic docker scenario executed via MCP docker server that produces verifiable artifacts/logs and is repeatable.
- `node verify/run.js` passes gate4 in an environment where Docker is available.

### Work Item C — UX v1
- Runner and verify output:
  - available MCP servers,
  - gates pass/fail,
  - why a gate failed,
  - exact next action to fix it.

## Constraints
- Mode B compatibility: workflow remains optional feature layer.
- MCP-first control plane; avoid CLI-first operational paths.
- Real tests only; no import-only claims.
- Vendor-neutral state under `.workbench/` (override with `WORKBENCH_STATE_DIR`).
- SRP/OCP/DIP apply to all changes.
