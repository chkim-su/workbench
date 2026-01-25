#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="${WORKBENCH_TMUX_SESSION:-workbench}"
SERVER="${WORKBENCH_TMUX_SERVER:-workbench}"
STATE_DIR="${WORKBENCH_STATE_DIR:-$ROOT/.workbench}"
PERSIST="${WORKBENCH_TMUX_PERSIST:-0}"

tmux_cmd() {
  tmux -L "$SERVER" "$@"
}

if ! command -v tmux >/dev/null 2>&1; then
  exec bun "$ROOT/ui/tui/ink-entry.js"
fi

# Initialize state directory and pointer file
mkdir -p "$STATE_DIR/state"
if [[ ! -f "$STATE_DIR/state/current.json" ]]; then
  echo '{"schemaVersion":1,"updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$STATE_DIR/state/current.json"
fi

# Helper: Send command to a specific pane (trigger only, never relay output)
send_to_pane() {
  local pane="$1"; shift
  local cmd="$*"
  tmux_cmd send-keys -t "$SESSION:workbench.$pane" "$cmd" Enter
}

# Helper: Ensure the layout exists (status pane always on the right)
ensure_layout() {
  local session_exists=0
  if tmux_cmd has-session -t "$SESSION" 2>/dev/null; then
    session_exists=1
  fi

  # Default behavior (non-persistent): always start from a clean tmux session.
  # Avoid tmux's `destroy-unattached` here; it can delete a freshly created detached session
  # before we get a chance to attach.
  if [[ "$session_exists" == "1" && "$PERSIST" != "1" ]]; then
    tmux_cmd kill-session -t "$SESSION" 2>/dev/null || true
    session_exists=0
  fi

  # Always (re)create the "ui" window with our known-good layout.
  # This keeps "status on the right" invariant even if the session already exists.
  if [[ "$session_exists" == "1" ]]; then
    for w in control ui; do
      if tmux_cmd list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -Fxq "$w"; then
        tmux_cmd kill-window -t "$SESSION:$w" 2>/dev/null || true
      fi
    done
  fi

  # Mouse enables: click-to-focus panes + drag-to-resize split dividers + wheel scroll (copy-mode)
  tmux_cmd set-option -g mouse on 2>/dev/null || true
  tmux_cmd set-option -g focus-events on 2>/dev/null || true

  # Layout:
  # Window "control" (Workbench command center):
  #   single pane running Ink UI
  #
  # Window "ui" (provider surface):
  # ┌──────────────────────┬────────────────────┐
  # │                      │                    │
  # │  Provider Surface    │   Status Pane      │
  # │   (Claude/Codex)     │   (live status)    │
  # │                      │                    │
  # ├──────────────────────┴────────────────────┤
  # │                 Output                   │
  # │            (runner/verify)               │
  # └───────────────────────────────────────────┘

  # Create session + "control" window (Ink Workbench)
  # Don't specify size - let tmux use default
  if [[ "$session_exists" == "1" ]]; then
    tmux_cmd new-window -d -t "$SESSION" -n "control" -c "$ROOT" \
      "bash -lc 'cd \"$ROOT\" && WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_STATE_DIR=\"$STATE_DIR\" WORKBENCH_EMBED_STATUS=0 bun ui/tui/ink-entry.js; rc=\$?; echo \"[workbench] control pane exited (rc=\$rc)\"; exec bash'"
  else
    tmux_cmd new-session -d -s "$SESSION" -n "control" \
      "bash -lc 'cd \"$ROOT\" && WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_STATE_DIR=\"$STATE_DIR\" WORKBENCH_EMBED_STATUS=0 bun ui/tui/ink-entry.js; rc=\$?; echo \"[workbench] control pane exited (rc=\$rc)\"; exec bash'"
  fi

  # Add a right-side status pane to the control window as well (so status is visible immediately).
  tmux_cmd split-window -h -t "$SESSION:control.0" -c "$ROOT" \
    "bash -lc 'cd \"$ROOT\" && WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_STATE_DIR=\"$STATE_DIR\" bun ui/tui/status-pane-entry.jsx; rc=\$?; echo \"[workbench] status pane exited (rc=\$rc)\"; exec bash'"
  tmux_cmd resize-pane -t "$SESSION:control.1" -x 50
  # Ensure the main (left) pane is focused by default.
  tmux_cmd select-pane -t "$SESSION:control.0" 2>/dev/null || true

  # Create "ui" window for provider surfaces (starts as a shell)
  tmux_cmd new-window -d -t "$SESSION" -n "ui" -c "$ROOT" "bash"

  # Split horizontally for status pane (use fixed column count)
  tmux_cmd split-window -h -t "$SESSION:ui.0" -c "$ROOT" \
    "bash -lc 'cd \"$ROOT\" && WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_STATE_DIR=\"$STATE_DIR\" bun ui/tui/status-pane-entry.jsx; rc=\$?; echo \"[workbench] status pane exited (rc=\$rc)\"; exec bash'"

  # Split pane 0 vertically for output (use fixed row count)
  tmux_cmd split-window -v -t "$SESSION:ui.0" -c "$ROOT" "bash"

  # Resize panes to desired proportions
  # Status pane (right) should be ~35 columns wide
  tmux_cmd resize-pane -t "$SESSION:ui.1" -x 50
  # Output pane (bottom-left) should be ~10 rows tall
  tmux_cmd resize-pane -t "$SESSION:ui.2" -y 10

  # Now panes are:
  # 0: TUI (top-left, main interactive)
  # 1: Status Pane (right, live status display)
  # 2: Output shell (bottom-left, for runner/verify output)
  tmux_cmd select-pane -t "$SESSION:ui.0" 2>/dev/null || true

  # Default behavior: if you close the tmux client, tear down the workbench session.
  # Use a hook rather than `destroy-unattached` to avoid racing our initial attach.
  if [[ "$PERSIST" != "1" ]]; then
    tmux_cmd set-hook -t "$SESSION" client-detached "if-shell -F '#{==:#{session_attached},0}' 'kill-session -t \"$SESSION\"' ''" 2>/dev/null || true
  fi

  # Select "control" window by default; the UI window is for provider surfaces.
  tmux_cmd select-window -t "$SESSION:control" 2>/dev/null || true
  tmux_cmd select-pane -t "$SESSION:control.0" 2>/dev/null || true
}

ensure_layout
# Apply Workbench session-scoped tmux theme (status line + borders)
bash "$ROOT/scripts/tmux_theme.sh" "$SESSION" || true
exec tmux -L "$SERVER" attach -t "$SESSION"
