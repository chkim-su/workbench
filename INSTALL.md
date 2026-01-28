# Installation

## Prerequisites

- `node` (for `verify/run.js`)
- `bun` (to run MCP servers in stdio mode)
- `python3` (runner + OAuth helpers)
- `go` 1.22+ (Bubble Tea TUI under `ui/tui/`)
- Docker daemon access (for verify gate4)

## Install

- `bash install.sh` (installs + runs baseline verify, writes a durable log under `.workbench/install/`, then launches `workbench` TUI, waits for Enter before exiting)
- Windows (double-click): `install.cmd` (runs in WSL, keeps window open until Enter)
- Windows (try Git Bash): `install-gitbash.cmd`

## One command verification

- Recommended: `workbench verify` (fast by default)
- Full gates (incl. Docker): `workbench verify --full`
- Also works (from repo root): `bun run verify` or `node verify/run.js`

## TUI

- `workbench`
- `workbench tui`
- If `go` is missing, Workbench runs the legacy Ink TUI by default (host-native).
- To run the Bubble Tea TUI without installing Go, explicitly opt into the Docker harness: `workbench tui-docker` (verification/dogfooding use).
- Legacy (Ink): `workbench tui-legacy`

### tmux layout (when `tmux` is installed)

Workbench uses a tmux-backed layout by default:

- Window `control`: top-left main TUI, top-right status (OAuth/MCP), bottom full-width Docker streaming pane.
- Window `ui`: provider surface (e.g. Claude Code) with a right-side status pane.
- The embedded in-pane status sidebar is disabled in tmux layouts (use the status pane instead).

Optional environment overrides:

- `WORKBENCH_DOCKER_PANE=0` to disable the bottom Docker pane in `control`.
- `WORKBENCH_DOCKER_PANE_MODE=ui` to use the Ink UI (default is `raw` for tmux scrollback).
- `WORKBENCH_TMUX_NO_ATTACH=1` to create the session without attaching (useful for smoke tests/CI scripts).

Docker pane evidence source: `.workbench/<sessionId>/system.responses.jsonl` (event fallback) plus live `docker logs -f` when available.

## Headless (CLI) — Docker session supervised by an LLM

Workbench exposes a deterministic CLI control surface that runs the Bubble Tea TUI **headlessly in Docker** and drives it via an append-only command bus under `.workbench/<sessionId>/commands.jsonl`.

Typical flow:

- Start a session: `workbench dev start --mode B --json`
- If Docker is unavailable, use host engine: `workbench dev start --engine host --mode B --json`
- Configure without key-scripting: `workbench dev set --session <id> --runtime codex-cli --model gpt-5.2 --thought-stream 1`
- Optional: set permission mode explicitly: `workbench dev set --session <id> --permission-mode plan` (or toggle in the cockpit with Shift+Tab)
- Send work: `workbench dev send --session <id> --text "analyze the project"`
- Run real tests in Docker (via system executor): `workbench dev cmd --session <id> --text "//verify full"`
- Tail durable events for “supervision”: `workbench dev follow --session <id>`

## OpenAI Codex OAuth (opencode tokens, multi-account pool)

If you already logged in via OpenCode (`~/.local/share/opencode/auth.json`), import tokens into the Workbench pool:

- `workbench oauth-import-opencode`
- Then: `export WORKBENCH_PROVIDER=openai-oauth WORKBENCH_VERIFY_REAL_LLM=1; workbench verify --full`

## Claude Code (raw via tmux)

- `export WORKBENCH_PROVIDER=claude-code WORKBENCH_VERIFY_REAL_LLM=1; workbench verify --full`

## OpenCode runtime (opencode)

Workbench can run OpenCode headlessly as a managed runtime (streaming tool/step events into the cockpit).

Prereq: install `opencode` and ensure it’s on your `PATH` (or set `WORKBENCH_OPENCODE_BIN` to the binary path).

Optional overrides:
- `WORKBENCH_OPENCODE_MODEL` (format: `provider/model`, e.g. `openai/gpt-5.2`)
- `WORKBENCH_OPENCODE_AGENT` (defaults to `build`)
- `WORKBENCH_TUI_THOUGHT_STREAM=1` to stream narrated “thinking” + intermediate steps into the cockpit (Codex Chat/CLI + OpenCode)

Note: this managed executor writes an isolated OpenCode config under `.workbench/opencode/` and defaults to `bash=deny` to stay non-interactive/deterministic.
