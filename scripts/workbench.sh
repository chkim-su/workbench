#!/usr/bin/env bash
#
# workbench - CLI-first interface for My LLM Workbench
#
# This script serves as the main entry point for the workbench CLI.
# It supports both the new Node.js CLI dispatcher and legacy commands.
#
# Usage:
#   workbench [global-flags] <command> [command-flags]
#
# Global Flags (new CLI):
#   --json               Machine-parseable JSON output
#   --quiet, -q          Suppress non-essential output
#   --log-level <level>  debug|info|warn|error (default: info)
#   --no-tty             Force headless mode
#
# Environment Variables:
#   WORKBENCH_STATE_DIR      Override .workbench location
#   WORKBENCH_LOG_LEVEL      Default log level
#   WORKBENCH_HEADLESS       Force headless mode (1=true)
#   WORKBENCH_JSON           Force JSON output (1=true)
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKBENCH_TMUX_SESSION="${WORKBENCH_TMUX_SESSION:-workbench}"

ensure_tmux_session() {
  if ! command -v tmux >/dev/null 2>&1; then
    return
  fi
  local session="${WORKBENCH_TMUX_SESSION}"
  if tmux has-session -t "${session}" >/dev/null 2>&1; then
    return
  fi
  tmux new-session -d -s "${session}" -n workbench
  tmux split-window -t "${session}:workbench" -h || true
  tmux select-layout -t "${session}:workbench" main-horizontal >/dev/null 2>&1 || true
}

# CLI location
CLI_ENTRY="${ROOT}/cli/src/index.js"

# State directory initialization
STATE_DIR="${WORKBENCH_STATE_DIR:-$ROOT/.workbench}"
mkdir -p "$STATE_DIR/state" "$STATE_DIR/logs"
STATE_DIR_ABS="$(cd "$STATE_DIR" && pwd)"

# Initialize current.json pointer if missing
if [[ ! -f "$STATE_DIR/state/current.json" ]]; then
  echo '{"schemaVersion":1,"updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$STATE_DIR/state/current.json"
fi

run_go_tui() {
  local executor_pid=""
  local opencode_pid=""
  local system_pid=""
  ensure_tmux_session
  if command -v node >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then
    mkdir -p "$STATE_DIR_ABS/logs"
    node "$ROOT/ui/tui/codex-executor.js" --state-dir "$STATE_DIR_ABS" --repo-root "$ROOT" >>"$STATE_DIR_ABS/logs/codex-executor.log" 2>&1 &
    executor_pid="$!"
  fi
  if command -v node >/dev/null 2>&1 && { command -v opencode >/dev/null 2>&1 || [[ -n "${WORKBENCH_OPENCODE_BIN:-}" ]]; }; then
    mkdir -p "$STATE_DIR_ABS/logs"
    node "$ROOT/ui/tui/opencode-executor.js" --state-dir "$STATE_DIR_ABS" --repo-root "$ROOT" >>"$STATE_DIR_ABS/logs/opencode-executor.log" 2>&1 &
    opencode_pid="$!"
  fi
  if command -v node >/dev/null 2>&1; then
    mkdir -p "$STATE_DIR_ABS/logs"
    node "$ROOT/ui/tui/system-executor.js" --state-dir "$STATE_DIR_ABS" --repo-root "$ROOT" >>"$STATE_DIR_ABS/logs/system-executor.log" 2>&1 &
    system_pid="$!"
  fi

  bash -lc "cd \"$ROOT/ui/tui\" && go run ."
  local rc=$?

  if [[ -n "${executor_pid}" ]]; then
    kill "${executor_pid}" >/dev/null 2>&1 || true
    wait "${executor_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${opencode_pid}" ]]; then
    kill "${opencode_pid}" >/dev/null 2>&1 || true
    wait "${opencode_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${system_pid}" ]]; then
    kill "${system_pid}" >/dev/null 2>&1 || true
    wait "${system_pid}" >/dev/null 2>&1 || true
  fi

  return $rc
}

run_docker_go_tui() {
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    return 1
  fi

  echo "[workbench] Running Bubble Tea TUI via Docker harness (golang:1.22)." >&2
  echo "[workbench] Tip: install Go 1.22+ to run host-native (recommended)." >&2

  local executor_pid=""
  local opencode_pid=""
  local system_pid=""
  if command -v node >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then
    mkdir -p "$STATE_DIR_ABS/logs"
    node "$ROOT/ui/tui/codex-executor.js" --state-dir "$STATE_DIR_ABS" --repo-root "$ROOT" >>"$STATE_DIR_ABS/logs/codex-executor.log" 2>&1 &
    executor_pid="$!"
  fi
  if command -v node >/dev/null 2>&1 && { command -v opencode >/dev/null 2>&1 || [[ -n "${WORKBENCH_OPENCODE_BIN:-}" ]]; }; then
    mkdir -p "$STATE_DIR_ABS/logs"
    node "$ROOT/ui/tui/opencode-executor.js" --state-dir "$STATE_DIR_ABS" --repo-root "$ROOT" >>"$STATE_DIR_ABS/logs/opencode-executor.log" 2>&1 &
    opencode_pid="$!"
  fi
  if command -v node >/dev/null 2>&1; then
    mkdir -p "$STATE_DIR_ABS/logs"
    node "$ROOT/ui/tui/system-executor.js" --state-dir "$STATE_DIR_ABS" --repo-root "$ROOT" >>"$STATE_DIR_ABS/logs/system-executor.log" 2>&1 &
    system_pid="$!"
  fi

  mkdir -p "$STATE_DIR_ABS/cache/go/mod" "$STATE_DIR_ABS/cache/go/build" "$STATE_DIR_ABS/cache/go/gopath" "$STATE_DIR_ABS/cache/xdg" "$STATE_DIR_ABS/home" >/dev/null 2>&1 || true

  docker run --rm -it --pull=missing \
    --user "$(id -u):$(id -g)" \
    -e HOME=/state/home \
    -e XDG_CACHE_HOME=/state/cache/xdg \
    -e GOPATH=/state/cache/go/gopath \
    -e GOMODCACHE=/state/cache/go/mod \
    -e GOCACHE=/state/cache/go/build \
    -e TERM="${TERM:-xterm-256color}" \
    -e COLORTERM="${COLORTERM:-}" \
    -e LANG="${LANG:-}" \
    -e WORKBENCH_STATE_DIR=/state \
    -v "$ROOT:/repo:ro" \
    -v "$STATE_DIR_ABS:/state:rw" \
    -w /repo/ui/tui \
    golang:1.22 \
    bash -c "go run ."

  local rc=$?
  if [[ -n "${executor_pid}" ]]; then
    kill "${executor_pid}" >/dev/null 2>&1 || true
    wait "${executor_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${opencode_pid}" ]]; then
    kill "${opencode_pid}" >/dev/null 2>&1 || true
    wait "${opencode_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${system_pid}" ]]; then
    kill "${system_pid}" >/dev/null 2>&1 || true
    wait "${system_pid}" >/dev/null 2>&1 || true
  fi
  return $rc
}

run_legacy_tui() {
  local topo="${WORKBENCH_TMUX_TOPOLOGY:-panes}"
  if command -v tmux >/dev/null 2>&1 && is_interactive_tty; then
    case "$topo" in
      windows)
        exec bash "$ROOT/scripts/tmux_windows_start.sh"
        ;;
      panes)
        exec bash "$ROOT/scripts/tmux_start.sh"
        ;;
      none)
        # fall through to single-terminal mode
        ;;
      *)
        exec bash "$ROOT/scripts/tmux_windows_start.sh"
        ;;
    esac
  fi

  if command -v bun >/dev/null 2>&1; then
    exec bun ui/tui/ink-entry.js "$@"
  fi
  exec node ui/tui/ink-entry.js "$@"
}

is_interactive_tty() {
  [[ -t 0 && -t 1 ]]
}

suggest_headless() {
  local in_tty="no"
  local out_tty="no"
  [[ -t 0 ]] && in_tty="yes"
  [[ -t 1 ]] && out_tty="yes"
  cat >&2 <<'EOF'
No interactive TTY detected.
Headless option (deterministic + DevOps-ready):
  workbench dev start --mode B --json
Then drive it via:
  workbench dev send --session <id> --text "..."
  workbench dev cmd  --session <id> --text "//model"
  workbench dev stop --session <id>
EOF
  echo "TTY diagnostics: stdin=${in_tty} stdout=${out_tty}" >&2
  echo "Tip: run from an actual terminal (not via pipes/CI/task runners)." >&2
}

# Check for global flags that route to new CLI
USE_NEW_CLI=0
for arg in "$@"; do
    case "$arg" in
        --json|--no-tty|--quiet|-q)
            USE_NEW_CLI=1
            break
            ;;
    esac
done

# Environment variable overrides
if [[ "${WORKBENCH_JSON:-}" == "1" ]] || [[ "${WORKBENCH_HEADLESS:-}" == "1" ]]; then
    USE_NEW_CLI=1
fi

# Route to new CLI for supported commands with --json flag
cmd="${1:-}"

# New CLI-only commands
case "$cmd" in
    doctor|state|logs|dev)
        if [[ -f "$CLI_ENTRY" ]]; then
            exec node "$CLI_ENTRY" "$@"
        else
            echo "Error: New CLI not installed. Run install.sh to set up." >&2
            exit 1
        fi
        ;;
esac

# If --json flag is used with any command, route to new CLI
if [[ $USE_NEW_CLI -eq 1 ]] && [[ -f "$CLI_ENTRY" ]]; then
    exec node "$CLI_ENTRY" "$@"
fi

shift || true

case "$cmd" in
  "" )
    if command -v go >/dev/null 2>&1; then
      run_go_tui
      exit $?
    fi
    if is_interactive_tty; then
      echo "[workbench] Go not found; launching legacy Ink TUI (host-native)." >&2
      echo "[workbench] To run Bubble Tea TUI: install Go 1.22+ or run: workbench tui-docker" >&2
      run_legacy_tui
    fi
    echo "Error: TUI requires an interactive TTY (stdin+stdout)." >&2
    suggest_headless
    echo "Error: Go (1.22+) is not installed and Docker is not usable." >&2
    echo "Install Go or run legacy Ink TUI from a real terminal: workbench tui-legacy" >&2
    exit 1
    ;;
  install)
    exec bash scripts/install.sh "$@"
    ;;
  tui)
    if command -v go >/dev/null 2>&1; then
      run_go_tui
      exit $?
    fi
    if is_interactive_tty; then
      echo "[workbench] Go not found; launching legacy Ink TUI (host-native)." >&2
      echo "[workbench] To run Bubble Tea TUI: install Go 1.22+ or run: workbench tui-docker" >&2
      run_legacy_tui "$@"
    fi
    echo "Error: TUI requires an interactive TTY (stdin+stdout)." >&2
    suggest_headless
    echo "Error: Go (1.22+) is not installed and Docker is not usable." >&2
    echo "Install Go or run legacy Ink TUI from a real terminal: workbench tui-legacy" >&2
    exit 1
    ;;
  tui-docker)
    if ! is_interactive_tty; then
      echo "Error: TUI requires an interactive TTY (stdin+stdout)." >&2
      suggest_headless
      exit 1
    fi
    if run_docker_go_tui; then
      exit 0
    fi
    echo "Error: Docker harness is not usable in this environment." >&2
    echo "Tip: ensure Docker daemon access (docker info), or install Go 1.22+ and run: workbench tui" >&2
    exit 1
    ;;
  tui-legacy)
    run_legacy_tui "$@"
    ;;
  verify)
    if [[ "${1:-}" == "--full" || "${1:-}" == "full" ]]; then
      shift || true
      exec node verify/run.js "$@"
    fi
    # Default to fast verify for interactive dogfooding; full verify is `workbench verify --full`.
    exec env WORKBENCH_VERIFY_FAST=1 WORKBENCH_SKIP_DOCKER=1 node verify/run.js "$@"
    ;;
  test)
    exec node --test "$@"
    ;;
  runner)
    exec python3 runner/run_smoke.py "$@"
    ;;
  chat)
    exec python3 runner/chat.py "$@"
    ;;
  oauth-import-opencode)
    exec python3 runner/auth/openai_oauth_import_opencode.py "$@"
    ;;
  oauth-login)
    exec python3 runner/auth/openai_oauth_login.py "$@"
    ;;
  oauth-manage)
    exec python3 runner/auth/openai_oauth_manage.py "$@"
    ;;
  oauth-sync)
    exec python3 runner/auth/openai_oauth_sync.py "$@"
    ;;
  workflow)
    # Route workflow command to new CLI if available
    if [[ -f "$CLI_ENTRY" ]]; then
      exec node "$CLI_ENTRY" workflow "$@"
    fi
    echo "Error: workflow command requires new CLI. Run install.sh to set up." >&2
    exit 1
    ;;
  *)
    cat <<'EOF'
Usage:
  workbench                       # launches TUI
  workbench install
  workbench tui
  workbench tui-docker            # Bubble Tea TUI via Docker harness (explicit)
  workbench verify                # fast (default)
  workbench verify --full         # full gates

New CLI Commands (JSON-capable):
  workbench doctor [--json]       # check environment
  workbench logs [--follow]       # view CLI logs
  workbench state show            # inspect state
  workbench workflow status       # workflow operations

Legacy Commands:
  workbench runner
  workbench chat

OAuth Commands:
  workbench oauth-login [--pool] [--profile name] [--device-code] [--no-browser]
  workbench oauth-import-opencode
  workbench oauth-sync [--watch] [--interval N]
  workbench oauth-manage list|pin|unpin|strategy|enable|disable|remove ...

Global Flags (new CLI):
  --json               Machine-parseable JSON output
  --quiet, -q          Suppress non-essential output
  --no-tty             Force headless mode

OAuth Login Options:
  --pool            Store token into pool (auto-assigns profile name)
  --profile NAME    Store token with specific profile name
  --device-code     Use device code flow (for SSH/headless)
  --no-browser      Don't auto-open browser

OAuth Sync Options:
  --watch           Watch mode: continuously sync on file changes
  --interval N      Watch interval in seconds (default: 10)
EOF
    exit 2
    ;;
esac
