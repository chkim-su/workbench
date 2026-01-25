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
