#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="${WORKBENCH_TMUX_SESSION:-workbench}"
SERVER="${WORKBENCH_TMUX_SERVER:-workbench}"
STATE_DIR="${WORKBENCH_STATE_DIR:-$ROOT/.workbench}"
PERSIST="${WORKBENCH_TMUX_PERSIST:-0}"
USE_GO_TUI="${WORKBENCH_GO_TUI:-0}"
ORCHESTRATOR="${WORKBENCH_TMUX_ORCHESTRATOR:-0}"
AUTOSTART_SURFACE="${WORKBENCH_AUTOSTART_SURFACE:-}"

tmux_cmd() {
  tmux -L "$SERVER" "$@"
}

if ! command -v tmux >/dev/null 2>&1; then
  if [[ "$ORCHESTRATOR" == "1" ]]; then
    exec bash
  fi
  if [[ "$USE_GO_TUI" == "1" ]] && command -v go >/dev/null 2>&1; then
    exec bash -lc "cd \"$ROOT/ui/tui\" && go run ."
  fi
  exec bun "$ROOT/ui/tui/ink-entry.js"
fi

# Determine the main pane command.
MAIN_CMD=""
MAIN_SURFACE="bash"

if [[ "$ORCHESTRATOR" == "1" ]]; then
  # Main pane starts as a normal shell (tmux scrollback + drag-select work).
  # Optional: auto-request surface launch via the system executor (e.g., codex/claude).
  if [[ -n "${AUTOSTART_SURFACE}" ]]; then
    MAIN_CMD="bash -lc 'cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR\" WORKBENCH_REPO_ROOT=\"$ROOT\" WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_AUTOSTART_SURFACE=\"${AUTOSTART_SURFACE}\" bun ui/tui/tmux-autostart.js; exec bash'"
  else
    MAIN_CMD="bash -lc 'cd \"$ROOT\" && exec bash'"
  fi
  MAIN_SURFACE="bash"
else
  if [[ "$USE_GO_TUI" == "1" ]] && command -v go >/dev/null 2>&1; then
    MAIN_CMD="bash -lc 'cd \"$ROOT/ui/tui\" && WORKBENCH_STATE_DIR=\"$STATE_DIR\" WORKBENCH_TMUX_HAS_STATUS_PANE=1 go run .; rc=\$?; echo \"[workbench] Go TUI exited (rc=\$rc)\"; exec bash'"
    MAIN_SURFACE="workbench-go-tui"
  else
    MAIN_CMD="bash -lc 'cd \"$ROOT\" && WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_STATE_DIR=\"$STATE_DIR\" WORKBENCH_EMBED_STATUS=0 WORKBENCH_TMUX_HAS_STATUS_PANE=1 bun ui/tui/ink-entry.js; rc=\$?; echo \"[workbench] control pane exited (rc=\$rc)\"; exec bash'"
    MAIN_SURFACE="workbench-ink"
  fi
fi

# Pane layout feature flags
DOCKER_PANE="${WORKBENCH_DOCKER_PANE:-1}"
NO_ATTACH="${WORKBENCH_TMUX_NO_ATTACH:-0}"

# Initialize state directory and pointer file
mkdir -p "$STATE_DIR/state"
if [[ ! -f "$STATE_DIR/state/current.json" ]]; then
  echo '{"schemaVersion":1,"updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$STATE_DIR/state/current.json"
fi

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
  # +--------------------+-----------------+
  # | Pane 0: Main TUI   | Pane 2: Status  |
  # | (Chat/Control)     | (OAuth, MCP)    |
  # +--------------------+-----------------+
  # | Pane 1: Docker process streaming     |
  # | (stdout/stderr from Docker container)|
  # +--------------------------------------+
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

  # Create session + "control" window (Workbench TUI - Go or Ink)
  # Don't specify size - let tmux use default
  if [[ "$session_exists" == "1" ]]; then
    tmux_cmd new-window -d -t "$SESSION" -n "control" -c "$ROOT" "$MAIN_CMD"
  else
    tmux_cmd new-session -d -s "$SESSION" -n "control" "$MAIN_CMD"
  fi

  # Persist Workbench metadata into tmux session options for key bindings / popups.
  tmux_cmd set-option -t "$SESSION" @workbench_repo_root "$ROOT" 2>/dev/null || true
  tmux_cmd set-option -t "$SESSION" @workbench_state_dir "$STATE_DIR" 2>/dev/null || true
  tmux_cmd set-option -t "$SESSION" @workbench_tmux_server "$SERVER" 2>/dev/null || true
  tmux_cmd set-option -t "$SESSION" @workbench_tmux_session "$SESSION" 2>/dev/null || true

  # Optional: create Docker pane first so it spans the full width (bottom), then add status on the right of the top row.
  local docker_pane_idx=""
  if [[ "$DOCKER_PANE" == "1" ]]; then
    docker_pane_idx="$(tmux_cmd split-window -v -t "$SESSION:control.0" -l 30% -c "$ROOT" -P -F '#{pane_index}' \
      "bash -lc 'cd \"$ROOT\" && WORKBENCH_STATE_DIR=\"$STATE_DIR\" WORKBENCH_REPO_ROOT=\"$ROOT\" WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" bun ui/tui/docker-pane.js; rc=\$?; echo \"[workbench] docker pane exited (rc=\$rc)\"; exec bash'"
    )"
    tmux_cmd set-option -pt "$SESSION:control.$docker_pane_idx" @workbench_pane_role docker 2>/dev/null || true
    tmux_cmd set-option -pt "$SESSION:control.$docker_pane_idx" @workbench_surface workbench-docker 2>/dev/null || true
    tmux_cmd select-pane -t "$SESSION:control.$docker_pane_idx" 2>/dev/null && tmux_cmd select-pane -t "$SESSION:control.$docker_pane_idx" -T docker 2>/dev/null || true
  fi

  # Add a right-side status pane (top row).
  tmux_cmd select-pane -t "$SESSION:control.0" 2>/dev/null || true
  local status_pane_idx=""
  status_pane_idx="$(tmux_cmd split-window -h -t "$SESSION:control.0" -c "$ROOT" -P -F '#{pane_index}' \
    "bash -lc 'cd \"$ROOT\" && WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_STATE_DIR=\"$STATE_DIR\" bun ui/tui/status-pane-entry.jsx; rc=\$?; echo \"[workbench] status pane exited (rc=\$rc)\"; exec bash'"
  )"
  tmux_cmd resize-pane -t "$SESSION:control.$status_pane_idx" -x 50 2>/dev/null || true
  tmux_cmd set-option -pt "$SESSION:control.$status_pane_idx" @workbench_pane_role status 2>/dev/null || true
  tmux_cmd set-option -pt "$SESSION:control.$status_pane_idx" @workbench_surface workbench-status 2>/dev/null || true
  tmux_cmd select-pane -t "$SESSION:control.$status_pane_idx" 2>/dev/null && tmux_cmd select-pane -t "$SESSION:control.$status_pane_idx" -T status 2>/dev/null || true

  # Add a bottom-right command pane (pairs under the status pane).
  # Pane target is the bottom docker pane if present; otherwise split the main pane.
  local command_target_idx="${docker_pane_idx:-0}"
  local command_pane_idx=""
  command_pane_idx="$(tmux_cmd split-window -h -t "$SESSION:control.$command_target_idx" -c "$ROOT" -P -F '#{pane_index}' \
    "bash -lc 'cd \"$ROOT\" && WORKBENCH_TMUX_SERVER=\"$SERVER\" WORKBENCH_TMUX_SESSION=\"$SESSION\" WORKBENCH_STATE_DIR=\"$STATE_DIR\" WORKBENCH_REPO_ROOT=\"$ROOT\" bun ui/tui/control-pane-entry.jsx; rc=\$?; echo \"[workbench] command pane exited (rc=\$rc)\"; exec bash'"
  )"
  tmux_cmd resize-pane -t "$SESSION:control.$command_pane_idx" -x 50 2>/dev/null || true
  tmux_cmd set-option -pt "$SESSION:control.$command_pane_idx" @workbench_pane_role command 2>/dev/null || true
  tmux_cmd set-option -pt "$SESSION:control.$command_pane_idx" @workbench_surface workbench-command 2>/dev/null || true
  tmux_cmd select-pane -t "$SESSION:control.$command_pane_idx" 2>/dev/null && tmux_cmd select-pane -t "$SESSION:control.$command_pane_idx" -T cmd 2>/dev/null || true

  # Mark main pane role (so executors can locate it even if pane indices drift).
  tmux_cmd set-option -pt "$SESSION:control.0" @workbench_pane_role main 2>/dev/null || true
  tmux_cmd set-option -pt "$SESSION:control.0" @workbench_surface "$MAIN_SURFACE" 2>/dev/null || true
  tmux_cmd select-pane -t "$SESSION:control.0" 2>/dev/null && tmux_cmd select-pane -t "$SESSION:control.0" -T main 2>/dev/null || true

  # Ensure the main (left/top) pane is focused by default.
  tmux_cmd select-pane -t "$SESSION:control.0" 2>/dev/null || true

  # Note: ui window is optional; default layout is a single "control" window with stable panes.

  # Default behavior: if you close the tmux client, tear down the workbench session.
  # Use a hook rather than `destroy-unattached` to avoid racing our initial attach.
  if [[ "$PERSIST" != "1" ]]; then
    tmux_cmd set-hook -t "$SESSION" client-detached "if-shell -F '#{==:#{session_attached},0}' 'kill-session -t \"$SESSION\"' ''" 2>/dev/null || true
  fi

  # Select "control" window by default.
  tmux_cmd select-window -t "$SESSION:control" 2>/dev/null || true
  tmux_cmd select-pane -t "$SESSION:control.0" 2>/dev/null || true
}

ensure_layout
# Apply Workbench session-scoped tmux theme (status line + borders)
bash "$ROOT/scripts/tmux_theme.sh" "$SESSION" || true
if [[ "$NO_ATTACH" == "1" ]]; then
  exit 0
fi
exec tmux -L "$SERVER" attach -t "$SESSION"
