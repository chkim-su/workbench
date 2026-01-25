#!/usr/bin/env bash
# Helper script to send commands to specific tmux panes.
# This is for TRIGGERING commands only - output is rendered by the pane's own process.
# NEVER use this to relay output.
#
# Usage: scripts/tmux_pane.sh <pane> <command...>
#
# Pane assignments:
#   0: TUI (exclusive - never send commands here)
#   1: MCP logs
#   2: Runner/LLM
#   3: Verify/Docker
#
# Examples:
#   scripts/tmux_pane.sh 2 python3 runner/run_smoke.py
#   scripts/tmux_pane.sh 3 node verify/run.js

set -euo pipefail

SESSION="${WORKBENCH_TMUX_SESSION:-workbench}"
SERVER="${WORKBENCH_TMUX_SERVER:-workbench}"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <pane> <command...>" >&2
  echo "  pane: 1=MCP, 2=Runner, 3=Verify (0=TUI is reserved)" >&2
  exit 2
fi

PANE="$1"; shift

# Safety: never send commands to TUI pane
if [[ "$PANE" == "0" ]]; then
  echo "Error: Cannot send commands to TUI pane (0). Use panes 1-3." >&2
  exit 1
fi

# Check if session exists
if ! tmux -L "$SERVER" has-session -t "$SESSION" 2>/dev/null; then
  echo "Error: tmux session '$SESSION' not found. Run 'workbench' first." >&2
  exit 1
fi

# Escape special characters for tmux send-keys
escape_for_tmux() {
  local str="$1"
  # Escape double quotes and dollar signs
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  str="${str//\$/\\\$}"
  echo "$str"
}

CMD="$*"
ESCAPED_CMD=$(escape_for_tmux "$CMD")

# Clear pane and run command
tmux -L "$SERVER" send-keys -t "$SESSION:workbench.$PANE" "clear; $ESCAPED_CMD" Enter
