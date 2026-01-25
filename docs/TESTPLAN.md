# TESTPLAN (Real-test gates)

## Gate 0 — Evidence baseline (git optional)
- If this directory is a git repo: capture `git status` + recent `git log`.
- If not a git repo: treat git evidence as optional and use filesystem evidence instead:
  - `tree` (or `find`) snapshot of key directories
  - `.workbench/verify/gates/<runId>/summary.json` from `node verify/run.js`

## Gate 1 — MCP handshake + tools list
- Start `workbench.workflow` in stdio mode
- `initialize` → `tools/list`

## Gate 2 — Registry scan + persisted state
- Start `workbench.registry` in stdio mode
- Call tool `workbench.registry.scan`
- Verify `.workbench/registry/mcp.json` updated

## Gate 3 — Workflow operations
- Start `workbench.workflow`
- `upload` → `status` → `update` → `status` and verify state transition

## Gate 4 — Docker harness
- Start `workbench.docker`
- Run an MCP-driven docker operation that produces observable logs/artifacts and is repeatable

## Gate 5 — Runner dogfooding (tool-loop)
- Run `python3 runner/run_smoke.py` in mock mode (always available):
  - `WORKBENCH_PROVIDER=mock python3 runner/run_smoke.py`
- Optional: run in real LLM mode when configured:
  - local OpenAI-compatible: set `WORKBENCH_OPENAI_BASE_URL`, `WORKBENCH_OPENAI_MODEL`, and `WORKBENCH_OPENAI_ALLOW_NOAUTH=1` (or provide API key)
  - remote OpenAI-style: set API key and opt-in when running `node verify/run.js` via `WORKBENCH_VERIFY_REAL_LLM=1`

## Gate 6 — TUI smoke (Bubble Tea)
- Classification: **Verify / gate harness** (dockerized, disposable). This is not the default control-plane runtime.
- Run a dockerized Bubble Tea smoke scenario that proves:
  - launcher renders
  - mode selection works
  - `/` and `//` command palettes open (namespaces never mix)
  - Esc closes overlays and navigates back via screen stack
  - empty input + Enter opens quick actions
- Durable artifacts:
  - `.workbench/verify/tui/<verifyRunId>/summary.json`
  - `.workbench/verify/docker/<runId>/stdout.txt`

## Gate 7 — OAuth deterministic selection
- Run deterministic OAuth pool selection tests proving:
  - remaining-based ordering
  - reset-time tie-break
  - email lexicographical tie-break

## Gate 8 — CLI replay determinism
- Classification: **Verify / gate harness** (dockerized, disposable). This gate verifies deterministic behavior under a reproducible harness.
- Run a dockerized headless session (`go run ui/tui --serve`) driven entirely by the command bus:
  - CLI-sourced commands produce durable `events.jsonl`
  - Replaying the same `commands.jsonl` yields the same summary state

## Single entrypoint
- `node verify/run.js`
