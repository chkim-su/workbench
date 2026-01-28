#!/usr/bin/env bash
set -euo pipefail

# Workbench tmux theme (session-scoped)
# - Does NOT modify ~/.tmux.conf
# - Applies options only to the given session/windows

SESSION="${1:-workbench}"
SERVER="${WORKBENCH_TMUX_SERVER:-workbench}"

if ! command -v tmux >/dev/null 2>&1; then
  exit 0
fi

if ! tmux -L "$SERVER" has-session -t "$SESSION" 2>/dev/null; then
  exit 0
fi

# Allow disabling without editing scripts
if [[ "${WORKBENCH_TMUX_THEME:-1}" == "0" ]]; then
  exit 0
fi

# Workbench defaults (server-scoped within the isolated -L server).
# Ensure mouse + focus events so panes are clickable and resizable with the mouse.
tmux -L "$SERVER" set-option -g mouse on 2>/dev/null || true
tmux -L "$SERVER" set-option -g focus-events on 2>/dev/null || true

# Keep Workbench window names stable (Claude Code should not auto-rename the "ui" window).
tmux -L "$SERVER" set-option -t "$SESSION" allow-rename off 2>/dev/null || true
tmux -L "$SERVER" set-window-option -g synchronize-panes off 2>/dev/null || true

# Navigation helpers (no-prefix). These apply only to the Workbench tmux server (-L).
tmux -L "$SERVER" bind-key -n F1 select-window -t "$SESSION:control" 2>/dev/null || true
tmux -L "$SERVER" bind-key -n F2 select-window -t "$SESSION:ui" 2>/dev/null || true
tmux -L "$SERVER" bind-key -n F4 select-pane -t "$SESSION:control.3" 2>/dev/null || true
tmux -L "$SERVER" bind-key -n F3 display-popup -E -w 90% -h 90% -T "Workbench" \
  "bash -lc '
    export PATH=\"$HOME/.bun/bin:$PATH\"
    ROOT=\"#{?@workbench_repo_root,#{@workbench_repo_root},#{pane_current_path}}\"
    STATE=\"#{?@workbench_state_dir,#{@workbench_state_dir},.workbench}\"
    TMUX_SERVER=\"#{?@workbench_tmux_server,#{@workbench_tmux_server},workbench}\"
    TMUX_SESSION=\"#{?@workbench_tmux_session,#{@workbench_tmux_session},workbench}\"
    if ! cd \"$ROOT\" 2>/dev/null; then cd \"#{pane_current_path}\" 2>/dev/null || true; fi
    bun \"$ROOT/ui/tui/control-popup-entry.jsx\"
    rc=$?
    if [ $rc -ne 0 ]; then
      echo \"\"
      echo \"[workbench] F3 popup failed (rc=$rc)\"
      echo \"ROOT=$ROOT\"
      echo \"STATE=$STATE\"
      echo \"PATH=$PATH\"
      echo \"Press any key to close...\"
      read -r -n 1 -s
    fi
    exit $rc
  '" 2>/dev/null || true

# Avoid hijacking app-level scroll/view keys (Codex/Workbench use PgUp/PgDn).
tmux -L "$SERVER" unbind-key -n PageUp 2>/dev/null || true
tmux -L "$SERVER" unbind-key -n PageDown 2>/dev/null || true

# Mouse wheel behavior:
# - For Workbench-rendered TUIs (Bubble Tea / Ink): forward PgUp/PgDn so app-level scrollback works.
# - For raw provider surfaces (codex/claude/bash): keep tmux copy-mode scrolling so drag+select UX works.
tmux -L "$SERVER" bind-key -n WheelUpPane if-shell -F '#{||:#{==:#{@workbench_surface},workbench-go-tui},#{==:#{@workbench_surface},workbench-ink}}' \
  'send-keys PageUp' \
  'if-shell -F "#{pane_in_mode}" "send-keys -M" "copy-mode -e; send-keys -M"' 2>/dev/null || true
tmux -L "$SERVER" bind-key -n WheelDownPane if-shell -F '#{||:#{==:#{@workbench_surface},workbench-go-tui},#{==:#{@workbench_surface},workbench-ink}}' \
  'send-keys PageDown' \
  'send-keys -M' 2>/dev/null || true

# Pane navigation within the current window (no-prefix). Avoid Alt+Arrow so Claude/shell keep word-jump.
tmux -L "$SERVER" bind-key -n F6 select-pane -t ":.+" 2>/dev/null || true
tmux -L "$SERVER" bind-key -n F7 last-pane 2>/dev/null || true

# Palette (Catppuccin-ish, readable on dark terminals)
BG="#1e1e2e"
FG="#cdd6f4"
MUTED="#6c7086"
ACCENT="#89b4fa"
WARN="#f9e2af"
ERR="#f38ba8"
OK="#a6e3a1"

tmux -L "$SERVER" set-option -t "$SESSION" status on
tmux -L "$SERVER" set-option -t "$SESSION" status-interval 5
tmux -L "$SERVER" set-option -t "$SESSION" status-position bottom
tmux -L "$SERVER" set-option -t "$SESSION" status-style "bg=${BG},fg=${FG}"
tmux -L "$SERVER" set-option -t "$SESSION" message-style "bg=${BG},fg=${FG}"
tmux -L "$SERVER" set-option -t "$SESSION" message-command-style "bg=${BG},fg=${ACCENT}"
tmux -L "$SERVER" set-option -t "$SESSION" mode-style "bg=${ACCENT},fg=${BG}"

tmux -L "$SERVER" set-option -t "$SESSION" status-left-length 80
tmux -L "$SERVER" set-option -t "$SESSION" status-right-length 120

# Prefix indicator + session name
tmux -L "$SERVER" set-option -t "$SESSION" status-left "#[bg=${ACCENT},fg=${BG},bold] wb #[default] #[fg=${MUTED}]#{session_name}#[default] #[fg=${MUTED}](control/ui)#[default] #{?client_prefix,#[bg=${WARN},fg=${BG},bold] PREFIX #[default],}"

# Right: time + host + pane title
tmux -L "$SERVER" set-option -t "$SESSION" status-right "#[fg=${MUTED}]%Y-%m-%d %H:%M #[fg=${ACCENT}]#H#[default] #[fg=${MUTED}]#{pane_title}#[default]"

# Window options must be set per-window; apply across session windows.
while IFS= read -r win; do
  [[ -z "$win" ]] && continue
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" automatic-rename off 2>/dev/null || true
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" synchronize-panes off 2>/dev/null || true
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" window-status-separator " "
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" window-status-style "bg=${BG},fg=${MUTED}"
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" window-status-current-style "bg=${BG},fg=${FG},bold"
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" window-status-activity-style "bg=${BG},fg=${WARN}"
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" window-status-bell-style "bg=${BG},fg=${ERR},bold"

  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" window-status-format "#[fg=${MUTED}]#I:#W#[default]"
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" window-status-current-format "#[fg=${ACCENT},bold]#I:#W#[default]"

  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" pane-border-style "fg=${MUTED}"
  tmux -L "$SERVER" set-window-option -t "$SESSION:$win" pane-active-border-style "fg=${ACCENT}"
done < <(tmux -L "$SERVER" list-windows -t "$SESSION" -F '#{window_index}')

# Extra readability
tmux -L "$SERVER" set-option -t "$SESSION" display-panes-colour "${MUTED}"
tmux -L "$SERVER" set-option -t "$SESSION" display-panes-active-colour "${ACCENT}"
