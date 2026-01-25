#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from openai_oauth_pool import load_pool, save_pool


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["list", "activate", "pin", "unpin", "strategy", "disable", "enable", "remove"])
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument(
        "--pool-path",
        default=os.environ.get("WORKBENCH_OPENAI_OAUTH_POOL_PATH") or "",
        help="Path to OAuth pool JSON (defaults to .workbench/auth/openai_codex_oauth_pool.json)",
    )
    args = ap.parse_args()

    repo_root = Path.cwd()
    state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
    pool_path = Path(args.pool_path) if args.pool_path else (state_dir / "auth" / "openai_codex_oauth_pool.json")

    pool = load_pool(pool_path)

    if args.cmd == "list":
        out = {
            "poolPath": str(pool_path),
            "version": pool.version,
            "provider": pool.provider,
            "selection": {
                "strategy": pool.selection_strategy,
                "pinnedProfile": pool.pinned_profile,
                "lastUsedProfile": pool.last_used_profile,
            },
            "profiles": [
                {
                    "profile": p.profile,
                    "accountId": p.account_id,
                    "disabled": p.disabled,
                    "rateLimitedUntilMs": p.rate_limited_until_ms,
                    "expiresAtMs": p.expires_at_ms,
                    "updatedAt": p.updated_at,
                }
                for p in (pool.profiles.values())
            ],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "strategy":
        name = (args.arg or "").strip().lower()
        if name not in ("sticky", "round-robin"):
            print("Strategy must be one of: sticky, round-robin", file=sys.stderr)
            return 2
        pool.selection_strategy = name
        save_pool(pool_path, pool)
        print(f"Set selection strategy: {name}")
        return 0

    name = (args.arg or "").strip()
    if not name:
        print("Missing profile name argument", file=sys.stderr)
        return 2

    if args.cmd == "pin":
        if name not in pool.profiles:
            print(f"Profile not found: {name}", file=sys.stderr)
            return 2
        pool.pinned_profile = name
        save_pool(pool_path, pool)
        print(f"Pinned profile: {name}")
        return 0

    if args.cmd == "activate":
        if name not in pool.profiles:
            print(f"Profile not found: {name}", file=sys.stderr)
            return 2
        pool.last_used_profile = name
        save_pool(pool_path, pool)
        print(f"Activated profile (lastUsedProfile): {name}")
        return 0

    if args.cmd == "unpin":
        pool.pinned_profile = None
        save_pool(pool_path, pool)
        print("Unpinned profile")
        return 0

    if args.cmd == "disable":
        if name not in pool.profiles:
            print(f"Profile not found: {name}", file=sys.stderr)
            return 2
        pool.profiles[name].disabled = True
        save_pool(pool_path, pool)
        print(f"Disabled profile: {name}")
        return 0

    if args.cmd == "enable":
        if name not in pool.profiles:
            print(f"Profile not found: {name}", file=sys.stderr)
            return 2
        pool.profiles[name].disabled = False
        save_pool(pool_path, pool)
        print(f"Enabled profile: {name}")
        return 0

    if args.cmd == "remove":
        if name not in pool.profiles:
            print(f"Profile not found: {name}", file=sys.stderr)
            return 2
        del pool.profiles[name]
        if pool.pinned_profile == name:
            pool.pinned_profile = None
        if pool.last_used_profile == name:
            pool.last_used_profile = None
        save_pool(pool_path, pool)
        print(f"Removed profile: {name}")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
