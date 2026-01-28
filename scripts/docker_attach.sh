#!/usr/bin/env bash
# Docker Attach - Auto-attach to workbench container shell
#
# Monitors for running containers and attaches to their shell.
# Similar to how pane0 shows Claude Code directly.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${WORKBENCH_STATE_DIR:-$ROOT/.workbench}"
POLL_INTERVAL="${WORKBENCH_DOCKER_POLL_INTERVAL:-3}"
CONTAINER_PATTERNS="${WORKBENCH_DOCKER_PATTERNS:-workbench sandbox claude}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

log() {
  local ts
  ts=$(date '+%H:%M:%S')
  echo -e "${DIM}[$ts]${NC} $*"
}

find_container() {
  local containers
  containers=$(docker ps --format '{{.Names}}' 2>/dev/null || true)

  if [[ -z "$containers" ]]; then
    return 1
  fi

  # Check for preferred patterns
  for pattern in $CONTAINER_PATTERNS; do
    local match
    match=$(echo "$containers" | grep -i "$pattern" | head -1 || true)
    if [[ -n "$match" ]]; then
      echo "$match"
      return 0
    fi
  done

  # Fall back to first container
  echo "$containers" | head -1
  return 0
}

attach_to_container() {
  local container="$1"
  local shell="${2:-/bin/bash}"

  log "${GREEN}Attaching to container: ${CYAN}$container${NC}"
  log "${DIM}Shell: $shell | Ctrl+D to detach${NC}"
  echo ""

  # Try bash first, fall back to sh
  if docker exec -it "$container" "$shell" 2>/dev/null; then
    return 0
  elif docker exec -it "$container" /bin/sh 2>/dev/null; then
    return 0
  else
    log "${RED}Failed to attach to $container${NC}"
    return 1
  fi
}

show_waiting() {
  clear
  echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}             ${YELLOW}DOCKER PANE - Waiting for Container${NC}            ${CYAN}║${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${DIM}Looking for containers matching:${NC} ${GREEN}$CONTAINER_PATTERNS${NC}"
  echo ""
  echo -e "  ${DIM}To start a container:${NC}"
  echo -e "    ${CYAN}docker-compose -f docker/workbench/docker-compose.yml up -d${NC}"
  echo ""
  echo -e "  ${DIM}Or run directly:${NC}"
  echo -e "    ${CYAN}docker run -it --name myworkbench myworkbench:latest bash${NC}"
  echo ""
  echo -e "  ${DIM}Polling every ${POLL_INTERVAL}s...${NC}"
}

main() {
  log "${CYAN}Docker Attach started${NC}"
  log "${DIM}Patterns: $CONTAINER_PATTERNS${NC}"

  local last_container=""
  local shown_waiting=0

  while true; do
    local container
    container=$(find_container || true)

    if [[ -n "$container" ]]; then
      shown_waiting=0

      if [[ "$container" != "$last_container" ]]; then
        last_container="$container"
        attach_to_container "$container"

        # After detach, show status
        log "${YELLOW}Detached from $container${NC}"
        log "${DIM}Will re-attach if container is still running...${NC}"
        sleep 2
      fi
    else
      last_container=""

      if [[ $shown_waiting -eq 0 ]]; then
        show_waiting
        shown_waiting=1
      fi

      sleep "$POLL_INTERVAL"
    fi
  done
}

# Handle signals
cleanup() {
  log "${YELLOW}Docker Attach exiting${NC}"
  exit 0
}

trap cleanup SIGINT SIGTERM

main "$@"
