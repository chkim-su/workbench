#!/usr/bin/env bash
# If invoked as `sh scripts/install.sh`, re-exec under bash so process substitution works.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Update from git if this is a git repo
update_from_git() {
  if [[ -d "$ROOT/.git" ]]; then
    if command -v git >/dev/null 2>&1; then
      echo "[workbench-install] Checking for updates..."
      local current_commit
      current_commit="$(git rev-parse HEAD 2>/dev/null || echo "")"

      if git fetch origin main >/dev/null 2>&1; then
        local remote_commit
        remote_commit="$(git rev-parse origin/main 2>/dev/null || echo "")"

        if [[ -n "$current_commit" && -n "$remote_commit" && "$current_commit" != "$remote_commit" ]]; then
          echo "[workbench-install] Updates available. Pulling latest..."
          if git pull origin main 2>&1; then
            echo "[workbench-install] Updated to latest version."
            # Re-exec the updated script
            echo "[workbench-install] Restarting with updated installer..."
            exec bash "$0" "$@"
          else
            echo "[workbench-install] WARNING: git pull failed. Continuing with current version."
          fi
        else
          echo "[workbench-install] Already up to date."
        fi
      else
        echo "[workbench-install] WARNING: Could not fetch updates. Continuing with current version."
      fi
    fi
  fi
}

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

Installs or updates My LLM Workbench and its dependencies.

Options:
  --check            Check prerequisites only
  --skip-bun-install Skip bun install step
  --no-launch        Don't launch TUI after install
  --no-verify        Skip verification gates
  --no-update        Skip git pull update check
  --no-pause         Don't pause for Enter at end
  -h, --help         Show this help

EOF
}

CHECK_ONLY=0
SKIP_BUN=0
NO_PAUSE=0
RUN_VERIFY=1
VERIFY_REAL=0
LAUNCH=1

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --skip-bun-install) SKIP_BUN=1 ;;
    --no-pause) NO_PAUSE=1 ;;
    --verify) RUN_VERIFY=1 ;;
    --no-verify) RUN_VERIFY=0 ;;
    --verify-real) VERIFY_REAL=1 ;;
    --launch) LAUNCH=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help) usage; exit 0 ;;
    --no-update) NO_UPDATE=1 ;;
    *) echo "Unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

# Check for updates (unless --no-update is passed)
NO_UPDATE="${NO_UPDATE:-0}"
if [[ "$NO_UPDATE" -eq 0 ]]; then
  update_from_git "$@"
fi

need_cmd() {
  local c="$1"
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "[workbench-install] Missing command: $c" >&2
    return 1
  fi
  return 0
}

install_prerequisites() {
  echo "[workbench-install] Auto-installing missing prerequisites..."

  # Detect OS
  local OS=""
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS="$ID"
  fi

  case "$OS" in
    ubuntu|debian)
      # Update apt quietly
      echo "[workbench-install] Updating package lists..."
      sudo apt-get update -qq 2>/dev/null || true

      # Install common dependencies (curl, unzip needed for bun)
      if ! command -v unzip >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
        echo "[workbench-install] Installing curl and unzip..."
        sudo apt-get install -y curl unzip >/dev/null 2>&1
      fi

      # Node.js (via NodeSource LTS)
      if ! command -v node >/dev/null 2>&1; then
        echo "[workbench-install] Installing Node.js (LTS)..."
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - >/dev/null 2>&1
        sudo apt-get install -y nodejs >/dev/null 2>&1
      fi

      # Python3
      if ! command -v python3 >/dev/null 2>&1; then
        echo "[workbench-install] Installing Python3..."
        sudo apt-get install -y python3 python3-pip >/dev/null 2>&1
      fi

      # Bun
      if ! command -v bun >/dev/null 2>&1; then
        echo "[workbench-install] Installing Bun..."
        curl -fsSL https://bun.sh/install | bash
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
      fi

      # Docker (optional but recommended)
      if ! command -v docker >/dev/null 2>&1; then
        echo "[workbench-install] Installing Docker..."
        sudo apt-get install -y docker.io >/dev/null 2>&1
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        echo "[workbench-install] Docker installed. You may need to log out and back in for group permissions."
      fi
      ;;
    fedora|rhel|centos|rocky|almalinux)
      # Install common dependencies (curl, unzip needed for bun)
      if ! command -v unzip >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
        echo "[workbench-install] Installing curl and unzip..."
        sudo dnf install -y curl unzip >/dev/null 2>&1 || sudo yum install -y curl unzip >/dev/null 2>&1
      fi

      # Node.js
      if ! command -v node >/dev/null 2>&1; then
        echo "[workbench-install] Installing Node.js..."
        sudo dnf install -y nodejs >/dev/null 2>&1 || sudo yum install -y nodejs >/dev/null 2>&1
      fi

      # Python3
      if ! command -v python3 >/dev/null 2>&1; then
        echo "[workbench-install] Installing Python3..."
        sudo dnf install -y python3 >/dev/null 2>&1 || sudo yum install -y python3 >/dev/null 2>&1
      fi

      # Bun
      if ! command -v bun >/dev/null 2>&1; then
        echo "[workbench-install] Installing Bun..."
        curl -fsSL https://bun.sh/install | bash
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
      fi

      # Docker (optional but recommended)
      if ! command -v docker >/dev/null 2>&1; then
        echo "[workbench-install] Installing Docker..."
        sudo dnf install -y docker >/dev/null 2>&1 || sudo yum install -y docker >/dev/null 2>&1
        sudo systemctl enable docker >/dev/null 2>&1 || true
        sudo systemctl start docker >/dev/null 2>&1 || true
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        echo "[workbench-install] Docker installed. You may need to log out and back in for group permissions."
      fi
      ;;
    arch|manjaro)
      # Install common dependencies (curl, unzip needed for bun)
      if ! command -v unzip >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
        echo "[workbench-install] Installing curl and unzip..."
        sudo pacman -Sy --noconfirm curl unzip >/dev/null 2>&1
      fi

      # Node.js
      if ! command -v node >/dev/null 2>&1; then
        echo "[workbench-install] Installing Node.js..."
        sudo pacman -Sy --noconfirm nodejs npm >/dev/null 2>&1
      fi

      # Python3
      if ! command -v python3 >/dev/null 2>&1; then
        echo "[workbench-install] Installing Python3..."
        sudo pacman -Sy --noconfirm python >/dev/null 2>&1
      fi

      # Bun
      if ! command -v bun >/dev/null 2>&1; then
        echo "[workbench-install] Installing Bun..."
        curl -fsSL https://bun.sh/install | bash
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
      fi

      # Docker (optional but recommended)
      if ! command -v docker >/dev/null 2>&1; then
        echo "[workbench-install] Installing Docker..."
        sudo pacman -Sy --noconfirm docker >/dev/null 2>&1
        sudo systemctl enable docker >/dev/null 2>&1 || true
        sudo systemctl start docker >/dev/null 2>&1 || true
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        echo "[workbench-install] Docker installed. You may need to log out and back in for group permissions."
      fi
      ;;
    *)
      echo "[workbench-install] Cannot auto-install on OS: ${OS:-unknown}"
      echo "[workbench-install] Please install manually: node, python3, bun"
      return 1
      ;;
  esac
  return 0
}

timestamp() { date -u +"%Y%m%dT%H%M%SZ"; }

LOG_DIR="$ROOT/.workbench/install"
mkdir -p "$LOG_DIR"
LOG_PATH="$LOG_DIR/install_$(timestamp).log"

if ! command -v tee >/dev/null 2>&1; then
  echo "[workbench-install] Missing command: tee" >&2
  echo "[workbench-install] Cannot mirror logs to terminal; will write to: $LOG_PATH" >&2
  exec >>"$LOG_PATH" 2>&1
else
  exec > >(tee -a "$LOG_PATH") 2>&1
fi

pause_if_tty() {
  if [[ "$NO_PAUSE" -eq 1 ]]; then
    return 0
  fi
  # stdout is piped through `tee`, so `-t 1` is often false even in an interactive terminal.
  # Use stdin + /dev/tty when available.
  if [[ -t 0 && -w /dev/tty ]]; then
    echo "" >/dev/tty || true
    printf "%s" "[workbench-install] Press Enter to exit..." >/dev/tty || true
    # shellcheck disable=SC2162
    read _ </dev/tty || true
  fi
}

on_exit() {
  local code="$?"
  if [[ "$code" -ne 0 ]]; then
    echo
    echo "[workbench-install] FAILED (exitCode=$code)"
    echo "[workbench-install] Log: $LOG_PATH"
    pause_if_tty
  fi
  return "$code"
}
trap on_exit EXIT

# Ensure bun is on PATH if already installed (e.g., from previous run)
if [[ -d "$HOME/.bun/bin" && ":$PATH:" != *":$HOME/.bun/bin:"* ]]; then
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Install Go if not present (required for Bubble Tea TUI)
install_go_if_missing() {
  if command -v go >/dev/null 2>&1; then
    return 0
  fi

  local OS=""
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS="$ID"
  fi

  echo "[workbench-install] Installing Go..."
  case "$OS" in
    ubuntu|debian)
      sudo apt-get update -qq 2>/dev/null || true
      sudo apt-get install -y golang-go >/dev/null 2>&1
      ;;
    fedora|rhel|centos|rocky|almalinux)
      sudo dnf install -y golang >/dev/null 2>&1 || sudo yum install -y golang >/dev/null 2>&1
      ;;
    arch|manjaro)
      sudo pacman -Sy --noconfirm go >/dev/null 2>&1
      ;;
    *)
      echo "[workbench-install] WARNING: Cannot auto-install Go on ${OS:-unknown}"
      echo "[workbench-install] Install manually: https://go.dev/dl/"
      return 1
      ;;
  esac

  if command -v go >/dev/null 2>&1; then
    echo "[workbench-install] Go installed successfully."
  else
    echo "[workbench-install] WARNING: Go installation may have failed."
  fi
}

# Install Docker if not present (separate from other prerequisites)
install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi

  local OS=""
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS="$ID"
  fi

  echo "[workbench-install] Installing Docker..."
  case "$OS" in
    ubuntu|debian)
      sudo apt-get update -qq 2>/dev/null || true
      sudo apt-get install -y docker.io >/dev/null 2>&1
      ;;
    fedora|rhel|centos|rocky|almalinux)
      sudo dnf install -y docker >/dev/null 2>&1 || sudo yum install -y docker >/dev/null 2>&1
      sudo systemctl enable docker >/dev/null 2>&1 || true
      sudo systemctl start docker >/dev/null 2>&1 || true
      ;;
    arch|manjaro)
      sudo pacman -Sy --noconfirm docker >/dev/null 2>&1
      sudo systemctl enable docker >/dev/null 2>&1 || true
      sudo systemctl start docker >/dev/null 2>&1 || true
      ;;
    *)
      echo "[workbench-install] WARNING: Cannot auto-install Docker on ${OS:-unknown}"
      return 1
      ;;
  esac

  if command -v docker >/dev/null 2>&1; then
    sudo usermod -aG docker "$USER" 2>/dev/null || true
    echo "[workbench-install] Docker installed. Log out and back in for group permissions."
  else
    echo "[workbench-install] WARNING: Docker installation may have failed."
  fi
}

missing=0
need_cmd node || missing=1
need_cmd python3 || missing=1
need_cmd bun || missing=1

if [[ "$missing" -ne 0 ]]; then
  echo "[workbench-install] Missing prerequisites detected. Attempting auto-install..."
  if install_prerequisites; then
    # Ensure bun is on PATH after installation
    if [[ -d "$HOME/.bun/bin" ]]; then
      export BUN_INSTALL="$HOME/.bun"
      export PATH="$BUN_INSTALL/bin:$PATH"
    fi
    # Re-check after install
    missing=0
    need_cmd node || missing=1
    need_cmd python3 || missing=1
    need_cmd bun || missing=1
  fi

  if [[ "$missing" -ne 0 ]]; then
    echo "[workbench-install] Failed to install prerequisites." >&2
    echo "Please install manually:" >&2
    echo "- node: https://nodejs.org" >&2
    echo "- python3: https://www.python.org" >&2
    echo "- bun: https://bun.sh" >&2
    exit 2
  fi
fi

mkdir -p .workbench/auth .workbench/runs .workbench/verify .workbench/state || true

# Initialize state/current.json pointer if missing
if [[ ! -f ".workbench/state/current.json" ]]; then
  echo '{"schemaVersion":1,"updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > ".workbench/state/current.json"
fi

# Install Go (required for Bubble Tea TUI with reasoning traces)
install_go_if_missing || true

# Install Docker (optional but recommended for full verification)
install_docker_if_missing || true

echo "[workbench-install] Log: $LOG_PATH"
echo "[workbench-install] node=$(node --version)"
echo "[workbench-install] python=$(python3 --version)"
echo "[workbench-install] bun=$(bun --version)"

# Check for Go (required for Bubble Tea TUI)
if command -v go >/dev/null 2>&1; then
  echo "[workbench-install] go=$(go version | awk '{print $3}')"
else
  echo "[workbench-install] WARNING: go not found"
  echo "[workbench-install]   The Bubble Tea TUI requires Go. Using legacy Ink TUI."
fi

# Check for tmux (optional but recommended for 4-pane layout)
if command -v tmux >/dev/null 2>&1; then
  echo "[workbench-install] tmux=$(tmux -V)"
else
  echo "[workbench-install] WARNING: tmux not found"
  echo "[workbench-install]   The TUI will work but without the 4-pane layout."
fi

# Check for docker
if command -v docker >/dev/null 2>&1; then
  echo "[workbench-install] docker=$(docker --version | head -1)"
else
  echo "[workbench-install] WARNING: docker not found"
  echo "[workbench-install]   Docker MCP features will not be available."
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "[workbench-install] check: ok"
  pause_if_tty
  exit 0
fi

if [[ "$SKIP_BUN" -eq 0 ]]; then
  echo "[workbench-install] bun install..."
  bun install
else
  echo "[workbench-install] skipping bun install"
fi

if [[ "$RUN_VERIFY" -eq 1 ]]; then
  echo "[workbench-install] running: bun run verify (baseline; real LLM disabled)"
  # Allow verification to fail (e.g., Docker not available) - installation continues
  if WORKBENCH_VERIFY_REAL_LLM=0 bun run verify; then
    echo "[workbench-install] verification: all gates passed"
  else
    echo "[workbench-install] WARNING: some verification gates failed (this is OK if Docker is not available)"
  fi
  if [[ "$VERIFY_REAL" -eq 1 ]]; then
    echo "[workbench-install] running: bun run verify (real LLM enabled)"
    WORKBENCH_VERIFY_REAL_LLM=1 bun run verify || echo "[workbench-install] WARNING: real LLM verification had failures"
  fi
fi

echo "[workbench-install] installing command: workbench"
INSTALL_BIN="${WORKBENCH_INSTALL_BIN_DIR:-}"
WORKBENCH_CMD=""
WORKBENCH_INSTALL_DIR=""

best_effort_install_also=()

write_wrapper() {
  local cmd_path="$1"
  local tmp="${cmd_path}.tmp"
  if ! (
    cat >"$tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
ROOT="${ROOT}"
exec "\${ROOT}/bin/workbench" "\$@"
EOF
  ) 2>/dev/null; then
    return 1
  fi
  chmod +x "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$cmd_path" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  return 0
}

install_cmd_into() {
  local d="$1"
  if [[ -z "$d" ]]; then return 1; fi
  if [[ ! -d "$d" ]]; then
    mkdir -p "$d" 2>/dev/null || true
  fi
  if [[ ! -d "$d" || ! -w "$d" ]]; then
    return 1
  fi
  local cmd_path="${d}/workbench"
  if ! write_wrapper "$cmd_path"; then
    return 1
  fi
  WORKBENCH_CMD="$cmd_path"
  WORKBENCH_INSTALL_DIR="$d"
  return 0
}

first_writable_dir_on_path() {
  local d
  IFS=':' read -r -a _path_dirs <<< "${PATH:-}"
  for d in "${_path_dirs[@]}"; do
    [[ -z "$d" ]] && continue
    # Prefer user-controlled dirs to avoid surprising writes to system locations.
    if [[ "$d" == "$HOME"* ]] && [[ -d "$d" && -w "$d" ]]; then
      echo "$d"
      return 0
    fi
  done
  for d in "${_path_dirs[@]}"; do
    [[ -z "$d" ]] && continue
    if [[ -d "$d" && -w "$d" ]]; then
      echo "$d"
      return 0
    fi
  done
  return 1
}

if [[ -n "$INSTALL_BIN" ]]; then
  install_cmd_into "$INSTALL_BIN" || true
else
  # Prefer dirs that are already on PATH, so `workbench` works immediately in this shell.
  PATH_DIR="$(first_writable_dir_on_path || true)"
  if [[ -n "${PATH_DIR:-}" ]]; then
    install_cmd_into "$PATH_DIR" || true
  fi

  # Also try common user bins (even if not currently on PATH), for future shells.
  best_effort_install_also=("${HOME}/.opencode/bin" "${HOME}/.local/bin")
  if [[ -z "$WORKBENCH_CMD" ]]; then
    for d in "${best_effort_install_also[@]}"; do
      if install_cmd_into "$d"; then
        break
      fi
    done
  fi
fi

if [[ -n "$WORKBENCH_CMD" ]]; then
  echo "[workbench-install] command install dir: $WORKBENCH_INSTALL_DIR"
else
  echo "[workbench-install] WARNING: could not install a global 'workbench' command (no writable bin dir found)."
  echo "[workbench-install] You can still run: $ROOT/bin/workbench tui"
fi

# Best-effort install additional wrappers (does not change the primary install dir).
if [[ -n "$WORKBENCH_CMD" ]]; then
  PRIMARY_DIR="$WORKBENCH_INSTALL_DIR"
  PRIMARY_CMD="$WORKBENCH_CMD"
  for d in "${best_effort_install_also[@]:-}"; do
    if [[ "$d" != "$PRIMARY_DIR" ]]; then
      if [[ ! -d "$d" ]]; then
        mkdir -p "$d" 2>/dev/null || true
      fi
      if [[ -d "$d" && -w "$d" ]]; then
        write_wrapper "${d}/workbench" >/dev/null 2>&1 || true
      fi
    fi
  done
  WORKBENCH_INSTALL_DIR="$PRIMARY_DIR"
  WORKBENCH_CMD="$PRIMARY_CMD"
fi

# Ensure the chosen install dir is on PATH for future shells.
if [[ -n "$WORKBENCH_INSTALL_DIR" && -n "$WORKBENCH_CMD" ]]; then
  if [[ ":${PATH}:" != *":${WORKBENCH_INSTALL_DIR}:"* ]]; then
    BASHRC="${HOME}/.bashrc"
    MARK_BEGIN="# workbench: add bin (auto)"
    MARK_LINE="export PATH=\"${WORKBENCH_INSTALL_DIR}:\$PATH\""
    if [[ -f "$BASHRC" ]]; then
      if ! grep -Fq "$MARK_LINE" "$BASHRC"; then
        {
          echo ""
          echo "$MARK_BEGIN"
          echo "$MARK_LINE"
        } >>"$BASHRC"
      fi
    else
      {
        echo "$MARK_BEGIN"
        echo "$MARK_LINE"
      } >"$BASHRC"
    fi
  fi
fi

echo "[workbench-install] done"
if [[ -n "$WORKBENCH_CMD" ]]; then
  echo "[workbench-install] command: workbench (installed to $WORKBENCH_CMD)"
  echo "[workbench-install] next: workbench  # default: host-native TUI (Bubble Tea if Go is installed; otherwise Ink legacy). Docker is opt-in via: workbench tui-docker"
else
  echo "[workbench-install] next: $ROOT/bin/workbench  # default: host-native TUI (Bubble Tea if Go is installed; otherwise Ink legacy). Docker is opt-in via: workbench tui-docker"
fi

if [[ "$LAUNCH" -eq 1 ]]; then
  # Auto-launch only when an interactive terminal is available.
  # Note: installer stdout is piped through `tee`, so stdout is often not a TTY.
  # Launching tmux without a controlling TTY can fail with: "open terminal failed: can't use /dev/tty".
  if [[ -t 0 && -t 1 && -z "${TMUX:-}" ]]; then
    echo "[workbench-install] launching: workbench"
    "$ROOT/bin/workbench" || true
  else
    echo "[workbench-install] skipping auto-launch (no controlling TTY). Run: workbench"
  fi
fi
pause_if_tty
