#!/usr/bin/env bash
set -euo pipefail

# Convenience wrapper for WSL/Linux users.
# (Windows double-click uses install.cmd.)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/scripts/install.sh" "$@"

