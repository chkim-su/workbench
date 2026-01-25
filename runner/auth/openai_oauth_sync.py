#!/usr/bin/env python3
"""
OpenCode OAuth Token Sync

Watches OpenCode auth files and automatically syncs changes to the Workbench pool.
Supports both single-account (auth.json) and multi-account plugins.

Usage:
  python3 runner/auth/openai_oauth_sync.py              # One-time sync
  python3 runner/auth/openai_oauth_sync.py --watch      # Watch mode (continuous)
  python3 runner/auth/openai_oauth_sync.py --watch --interval 30  # Custom interval
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from openai_oauth_pool import OAuthProfile, load_pool, save_pool, now_iso


def file_hash(path: Path) -> Optional[str]:
    """Get SHA256 hash of file contents, or None if file doesn't exist."""
    if not path.exists():
        return None
    try:
        content = path.read_bytes()
        return hashlib.sha256(content).hexdigest()
    except Exception:
        return None


def detect_opencode_files() -> Dict[str, Path]:
    """Detect all OpenCode auth-related files."""
    files: Dict[str, Path] = {}

    # Single account: ~/.local/share/opencode/auth.json
    env = (os.environ.get("OPENCODE_AUTH_JSON") or "").strip()
    if env:
        p = Path(env).expanduser()
    else:
        p = Path.home() / ".local" / "share" / "opencode" / "auth.json"
    if p.exists():
        files["auth.json"] = p

    # Multi-account: ~/.opencode/openai-codex-accounts.json
    env2 = (os.environ.get("OPENCODE_OPENAI_CODEX_ACCOUNTS_JSON") or "").strip()
    if env2:
        p2 = Path(env2).expanduser()
    else:
        p2 = Path.home() / ".opencode" / "openai-codex-accounts.json"
    if p2.exists():
        files["multi-accounts"] = p2

    return files


def default_pool_path() -> Path:
    repo_root = Path.cwd()
    state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
    return Path(os.environ.get("WORKBENCH_OPENAI_OAUTH_POOL_PATH") or (state_dir / "auth" / "openai_codex_oauth_pool.json"))


def infer_client_id() -> str:
    env = (os.environ.get("WORKBENCH_OPENAI_OAUTH_CLIENT_ID") or "").strip()
    if env:
        return env
    # Default: OpenCode's public client ID
    return "app_EMoamEEZ73f0CkXaXp7hrann"


def normalize_expires_ms(expires: Any) -> int:
    if isinstance(expires, int):
        return expires
    if isinstance(expires, float):
        return int(expires)
    return int(time.time() * 1000) + 30 * 60 * 1000


def extract_openai_oauth_from_auth_json(data: Any) -> Optional[Dict[str, Any]]:
    """Extract OpenAI OAuth entry from auth.json."""
    if not isinstance(data, dict):
        return None
    for key in ("openai", "codex"):
        v = data.get(key)
        if isinstance(v, dict) and v.get("type") == "oauth":
            return v
    for _, v in data.items():
        if isinstance(v, dict) and v.get("type") == "oauth":
            if isinstance(v.get("refresh"), str) and isinstance(v.get("access"), str):
                return v
    return None


def parse_multi_accounts(data: Any) -> List[Dict[str, Any]]:
    """Parse multi-account file."""
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        if isinstance(data.get("accounts"), list):
            return [x for x in data.get("accounts") if isinstance(x, dict)]
        out: List[Dict[str, Any]] = []
        for k, v in data.items():
            if isinstance(v, dict):
                out.append({"profile": k, **v})
        return out
    return []


def sync_from_opencode(
    pool_path: Path,
    issuer: str = "https://auth.openai.com",
    model: str = "gpt-5.2-codex",
    codex_endpoint: str = "https://chatgpt.com/backend-api/codex/responses",
) -> Dict[str, Any]:
    """
    Sync OAuth tokens from OpenCode files to Workbench pool.
    Returns sync result with imported profiles.
    """
    files = detect_opencode_files()
    if not files:
        return {"ok": False, "error": "No OpenCode auth files found", "imported": []}

    client_id = infer_client_id()
    imported: List[str] = []
    pool = load_pool(pool_path)

    # Sync multi-account file first (takes priority)
    if "multi-accounts" in files:
        try:
            raw = json.loads(files["multi-accounts"].read_text(encoding="utf-8"))
            accounts = parse_multi_accounts(raw)
            for idx, a in enumerate(accounts):
                refresh = a.get("refresh") or a.get("refreshToken") or a.get("refresh_token")
                access = a.get("access") or a.get("accessToken") or a.get("access_token")
                expires = a.get("expires") or a.get("expiresAtMs") or a.get("expires_at_ms")
                if not isinstance(refresh, str) or not isinstance(access, str):
                    continue
                prof_name = (a.get("profile") if isinstance(a.get("profile"), str) else "") or f"opencode{idx+1}"
                account_id = a.get("accountId") if isinstance(a.get("accountId"), str) else None

                profile = OAuthProfile(
                    profile=prof_name,
                    issuer=issuer,
                    client_id=client_id,
                    account_id=account_id,
                    access_token=access,
                    refresh_token=refresh,
                    expires_at_ms=normalize_expires_ms(expires),
                    updated_at=now_iso(),
                )
                pool.profiles[prof_name] = profile
                imported.append(prof_name)
        except Exception as e:
            return {"ok": False, "error": f"Failed to parse multi-accounts: {e}", "imported": []}

    # Sync single auth.json (only if no multi-account imported)
    if not imported and "auth.json" in files:
        try:
            data = json.loads(files["auth.json"].read_text(encoding="utf-8"))
            entry = extract_openai_oauth_from_auth_json(data)
            if entry:
                refresh = entry.get("refresh")
                access = entry.get("access")
                expires = entry.get("expires")
                if isinstance(refresh, str) and isinstance(access, str):
                    prof_name = "opencode1"
                    profile = OAuthProfile(
                        profile=prof_name,
                        issuer=issuer,
                        client_id=client_id,
                        account_id=None,
                        access_token=access,
                        refresh_token=refresh,
                        expires_at_ms=normalize_expires_ms(expires),
                        updated_at=now_iso(),
                    )
                    pool.profiles[prof_name] = profile
                    imported.append(prof_name)
        except Exception as e:
            return {"ok": False, "error": f"Failed to parse auth.json: {e}", "imported": []}

    if not imported:
        return {"ok": False, "error": "No valid OAuth entries found in OpenCode files", "imported": []}

    # Update pool metadata
    pool.issuer = pool.issuer or issuer
    pool.client_id = pool.client_id or client_id
    pool.model = pool.model or model
    pool.codex_endpoint = pool.codex_endpoint or codex_endpoint
    pool.updated_at = now_iso()

    # Save pool
    save_pool(pool_path, pool)

    return {
        "ok": True,
        "imported": imported,
        "poolPath": str(pool_path),
        "sources": {k: str(v) for k, v in files.items()},
    }


def watch_and_sync(
    pool_path: Path,
    interval: int = 10,
    issuer: str = "https://auth.openai.com",
    model: str = "gpt-5.2-codex",
    codex_endpoint: str = "https://chatgpt.com/backend-api/codex/responses",
) -> None:
    """Watch OpenCode files and sync changes automatically."""
    print(f"[workbench-sync] Watching OpenCode files (interval: {interval}s)")
    print(f"[workbench-sync] Pool: {pool_path}")
    print("[workbench-sync] Press Ctrl+C to stop")
    print("")

    last_hashes: Dict[str, Optional[str]] = {}

    while True:
        try:
            files = detect_opencode_files()
            current_hashes = {k: file_hash(v) for k, v in files.items()}

            # Check for changes
            changed = False
            for name, h in current_hashes.items():
                if name not in last_hashes or last_hashes[name] != h:
                    changed = True
                    if name in last_hashes:
                        print(f"[workbench-sync] Detected change in {name}")
                    break

            # Also check for removed files
            for name in last_hashes:
                if name not in current_hashes:
                    changed = True
                    print(f"[workbench-sync] File removed: {name}")

            if changed and files:
                result = sync_from_opencode(pool_path, issuer, model, codex_endpoint)
                if result["ok"]:
                    print(f"[workbench-sync] Synced {len(result['imported'])} profile(s): {', '.join(result['imported'])}")
                else:
                    print(f"[workbench-sync] Sync failed: {result.get('error', 'unknown')}")

            last_hashes = current_hashes
            time.sleep(interval)

        except KeyboardInterrupt:
            print("\n[workbench-sync] Stopped")
            break
        except Exception as e:
            print(f"[workbench-sync] Error: {e}")
            time.sleep(interval)


def main() -> int:
    ap = argparse.ArgumentParser(description="Sync OpenCode OAuth tokens to Workbench pool")
    ap.add_argument("--pool-path", default=str(default_pool_path()), help="Workbench OAuth pool path")
    ap.add_argument("--watch", action="store_true", help="Watch mode: continuously sync on file changes")
    ap.add_argument("--interval", type=int, default=10, help="Watch interval in seconds (default: 10)")
    ap.add_argument("--issuer", default="https://auth.openai.com", help="OAuth issuer")
    ap.add_argument("--model", default=os.environ.get("WORKBENCH_OPENAI_MODEL") or "gpt-5.2-codex", help="Default model")
    ap.add_argument("--codex-endpoint", default="https://chatgpt.com/backend-api/codex/responses", help="Codex endpoint")
    args = ap.parse_args()

    pool_path = Path(args.pool_path).expanduser()

    if args.watch:
        watch_and_sync(
            pool_path,
            interval=args.interval,
            issuer=args.issuer,
            model=args.model,
            codex_endpoint=args.codex_endpoint,
        )
        return 0
    else:
        result = sync_from_opencode(
            pool_path,
            issuer=args.issuer,
            model=args.model,
            codex_endpoint=args.codex_endpoint,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
