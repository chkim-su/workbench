# PLAN (Frozen v1)

## Task / Success criteria
- Migrate and refactor My LLM Workbench into a well-integrated, MCP-first control-plane architecture.
- Optionally reference (not bulk-copy) patterns from `/mnt/c/Users/chanhokim/Downloads/opencode-dev/opencode-dev`.
- Provide runnable local MCP servers (stdio) and reproducible verification with real tests at multiple checkpoints.

## Change boundaries
- Will touch: repo layout, MCP kit + servers, state store, docs, verification tests/scripts.
- Will not touch: large UI builds; unrelated features; bulk-copying opencode-dev code.

## Mode
- Mode B (Compatibility Mode).

## Steps (with mandatory test gates)
0. Inventory + evidence:
   - If this directory is a git repo: include `git status` and recent `git log`.
   - If not a git repo: treat git evidence as optional and fall back to filesystem evidence (tree/find snapshot + `.workbench/verify/gates/<runId>/summary.json` from `node verify/run.js`).
1. Target architecture + TEST GATE 1: start server, handshake, tools/list.
2. Registry + auto-discovery + TEST GATE 2: scan manifests, handshake servers, persist registry.
3. Workflow server + TEST GATE 3: upload workflow, status, update, status (state transitions).
4. Docker server + TEST GATE 4: MCP-driven Docker run producing artifacts/logs, repeatable.
5. Runner dogfooding + TEST GATE 5: runner smoke validates LLM tool-loop (mock always; real optional when configured).
6. Docs + single verify entrypoint.
