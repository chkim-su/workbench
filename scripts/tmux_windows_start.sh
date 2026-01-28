#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="${WORKBENCH_TMUX_SESSION:-workbench}"
SERVER="${WORKBENCH_TMUX_SERVER:-workbench}"
STATE_DIR="${WORKBENCH_STATE_DIR:-$ROOT/.workbench}"
PERSIST="${WORKBENCH_TMUX_PERSIST:-0}"

if ! command -v tmux >/dev/null 2>&1; then
  exec bun "$ROOT/ui/tui/ink-entry.js"
fi

# Initialize state directory and pointer file
mkdir -p "$STATE_DIR/state"
if [[ ! -f "$STATE_DIR/state/current.json" ]]; then
  echo '{"schemaVersion":1,"updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$STATE_DIR/state/current.json"
fi

STATE_DIR_ABS="$(cd "$STATE_DIR" && pwd)"

tmux_has_window() {
  local name="$1"
  tmux -L "$SERVER" list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -Fxq "$name"
}

ensure_session() {
  if tmux -L "$SERVER" has-session -t "$SESSION" 2>/dev/null; then
    return 0
  fi

  tmux -L "$SERVER" new-session -d -s "$SESSION" -n "control" \
    "bash -lc 'cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_EMBED_STATUS=0 WORKBENCH_TMUX_HAS_STATUS_PANE=1 bun ui/tui/ink-entry.js; rc=\$?; echo \"[workbench] control window exited (rc=\$rc)\"; exec bash'"
}

ensure_window() {
  local name="$1"; shift
  local cmd="$*"
  if tmux_has_window "$name"; then
    return 0
  fi
  tmux -L "$SERVER" new-window -d -t "$SESSION" -n "$name" -c "$ROOT" "bash -lc \"$cmd\""
}

ensure_session

# Persist Workbench metadata into tmux session options for key bindings / popups.
tmux -L "$SERVER" set-option -t "$SESSION" @workbench_repo_root "$ROOT" 2>/dev/null || true
tmux -L "$SERVER" set-option -t "$SESSION" @workbench_state_dir "$STATE_DIR_ABS" 2>/dev/null || true
tmux -L "$SERVER" set-option -t "$SESSION" @workbench_tmux_server "$SERVER" 2>/dev/null || true
tmux -L "$SERVER" set-option -t "$SESSION" @workbench_tmux_session "$SESSION" 2>/dev/null || true

# Default behavior: if you close the tmux client, tear down the workbench session.
# Use a hook rather than `destroy-unattached` to avoid racing our initial attach.
if [[ "$PERSIST" != "1" ]]; then
  tmux -L "$SERVER" set-hook -t "$SESSION" client-detached "if-shell -F '#{==:#{session_attached},0}' 'kill-session -t \"$SESSION\"' ''" 2>/dev/null || true
fi

# Mouse enables: click-to-focus panes + drag-to-resize split dividers + wheel scroll (copy-mode)
tmux -L "$SERVER" set-option -g mouse on 2>/dev/null || true
tmux -L "$SERVER" set-option -g focus-events on 2>/dev/null || true

# Dedicated windows (no embedded status UI required)
ensure_window "control" "cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_EMBED_STATUS=0 WORKBENCH_TMUX_HAS_STATUS_PANE=1 bun ui/tui/ink-entry.js; rc=\$?; echo \"[workbench] control window exited (rc=\$rc)\"; exec bash"
ensure_window "ui" "cd \"$ROOT\" && exec bash"
ensure_window "status" "cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_TMUX_SESSION=\"$SESSION\" bun ui/tui/status-pane-entry.jsx"
ensure_window "output" "cd \"$ROOT\" && exec bash"
# Docker window with multi-pane layout (similar to control window)
# pane0: Docker PTY (container shell)
# pane1: Status pane
# pane2: Docker logs
# pane3: Output/bash
if ! tmux_has_window "docker"; then
  tmux -L "$SERVER" new-window -d -t "$SESSION" -n "docker" -c "$ROOT" \
    "WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" bash scripts/docker_attach.sh; exec bash"

  # Split right for status pane (pane1)
  tmux -L "$SERVER" split-window -h -t "$SESSION:docker.0" -c "$ROOT" \
    "WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_TMUX_SESSION=\"$SESSION\" bun ui/tui/status-pane-entry.jsx; exec bash"

  # Split bottom of pane0 for docker logs (pane2)
  tmux -L "$SERVER" split-window -v -t "$SESSION:docker.0" -c "$ROOT" \
    "WORKBENCH_STATE_DIR=\"$STATE_DIR_ABS\" WORKBENCH_DOCKER_PANE_MODE=raw bun ui/tui/docker-pane.js; exec bash"

  # Split bottom of pane1 for output (pane3)
  tmux -L "$SERVER" split-window -v -t "$SESSION:docker.1" -c "$ROOT" \
    "exec bash"

  # Set layout: main-left with docker PTY as main
  tmux -L "$SERVER" select-layout -t "$SESSION:docker" main-vertical 2>/dev/null || true

  # Resize panes for better proportions
  tmux -L "$SERVER" resize-pane -t "$SESSION:docker.0" -x 60% 2>/dev/null || true
  tmux -L "$SERVER" resize-pane -t "$SESSION:docker.2" -y 30% 2>/dev/null || true
fi

# Mark pane roles where applicable (windows topology has single-pane windows).
tmux -L "$SERVER" set-option -pt "$SESSION:control.0" @workbench_pane_role main 2>/dev/null || true
tmux -L "$SERVER" select-pane -t "$SESSION:control.0" 2>/dev/null && tmux -L "$SERVER" select-pane -t "$SESSION:control.0" -T main 2>/dev/null || true

bash "$ROOT/scripts/tmux_theme.sh" "$SESSION" || true

tmux -L "$SERVER" select-window -t "$SESSION:control" 2>/dev/null || tmux -L "$SERVER" select-window -t "$SESSION" 2>/dev/null || true
exec tmux -L "$SERVER" attach -t "$SESSION"
