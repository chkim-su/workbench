#!/usr/bin/env python3
"""
Registry scan helper (Python).

Why Python?
- In this environment, Bun cannot reliably spawn a child process and interact over stdin/stdout pipes.
- Python's subprocess + pipes are stable for stdio JSON-RPC.

This script:
- Discovers `mcp/servers/*/manifest.json`
- Starts each server (stdio)
- Performs `initialize` and `tools/list`
- Writes `.workbench/registry/mcp.json`
- Prints a JSON summary to stdout
"""

from __future__ import annotations

import argparse
import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


HEADER_SEPARATOR = b"\r\n\r\n"


def encode_message(obj: Dict[str, Any]) -> bytes:
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    return header + body


def try_parse_one(buffer: bytes) -> Tuple[Optional[Dict[str, Any]], bytes]:
    header_end = buffer.find(HEADER_SEPARATOR)
    if header_end == -1:
        return None, buffer

    header_text = buffer[:header_end].decode("utf-8", errors="replace")
    content_length: Optional[int] = None
    for line in header_text.split("\r\n"):
        parts = line.split(":", 1)
        if len(parts) != 2:
            continue
        k = parts[0].strip().lower()
        v = parts[1].strip()
        if k == "content-length":
            try:
                content_length = int(v)
            except Exception:
                content_length = None
            break
    if content_length is None:
        return None, buffer

    body_start = header_end + len(HEADER_SEPARATOR)
    body_end = body_start + content_length
    if len(buffer) < body_end:
        return None, buffer

    body = buffer[body_start:body_end]
    rest = buffer[body_end:]
    try:
        return json.loads(body.decode("utf-8")), rest
    except Exception:
        return None, rest


def read_response(
    proc: subprocess.Popen[bytes],
    want_id: int,
    timeout_s: float,
    buf: bytes,
) -> Tuple[Dict[str, Any], bytes]:
    deadline = time.time() + timeout_s
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise TimeoutError(f"Timed out waiting for response id={want_id}")

        if proc.stdout is None:
            raise RuntimeError("process stdout is not available")

        fd = proc.stdout.fileno()
        readable, _, _ = select.select([fd], [], [], min(0.25, remaining))
        if not readable:
            if proc.poll() is not None:
                raise RuntimeError("process exited before response")
            continue

        chunk = os.read(fd, 4096)
        if not chunk:
            if proc.poll() is not None:
                raise RuntimeError("process exited before response")
            continue

        buf += chunk
        while True:
            msg, buf = try_parse_one(buf)
            if msg is None:
                break
            if isinstance(msg, dict) and msg.get("id") == want_id:
                return msg, buf


def run_one(manifest: Dict[str, Any], repo_root: Path, timeout_ms: int) -> Dict[str, Any]:
    name = manifest.get("name") or "unknown"
    cmd = manifest.get("command") or []
    cwd = manifest.get("cwd") or "."
    result: Dict[str, Any] = {
        "name": name,
        "lastHandshakeOk": False,
        "tools": None,
        "lastError": None,
    }

    proc = subprocess.Popen(
        cmd,
        cwd=str((repo_root / cwd).resolve()),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        buf = b""
        # initialize
        proc.stdin.write(
            encode_message(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "registry-scan", "version": "0"}},
                }
            )
        )
        proc.stdin.flush()
        init, buf = read_response(proc, 1, timeout_ms / 1000.0, buf)
        if "error" in init:
            result["lastError"] = init["error"].get("message") if isinstance(init["error"], dict) else "initialize error"
            return result
        result["lastHandshakeOk"] = True

        # tools/list
        proc.stdin.write(encode_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        proc.stdin.flush()
        listed, buf = read_response(proc, 2, timeout_ms / 1000.0, buf)
        if "error" in listed:
            result["lastError"] = listed["error"].get("message") if isinstance(listed["error"], dict) else "tools/list error"
            return result

        tools = None
        if isinstance(listed.get("result"), dict) and isinstance(listed["result"].get("tools"), list):
            tools = [t.get("name") for t in listed["result"]["tools"] if isinstance(t, dict) and isinstance(t.get("name"), str)]
        result["tools"] = tools or []
        return result
    except Exception as exc:
        result["lastError"] = str(exc)
        return result
    finally:
        try:
            proc.kill()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout-ms", type=int, default=10_000)
    args = ap.parse_args()

    repo_root = Path.cwd()
    servers_dir = repo_root / "mcp" / "servers"

    manifests: List[Dict[str, Any]] = []
    for child in servers_dir.iterdir() if servers_dir.exists() else []:
        if not child.is_dir():
            continue
        mf = child / "manifest.json"
        if not mf.exists():
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except Exception:
            continue
        if m.get("version") != 1:
            continue
        if m.get("transport") != "stdio":
            continue
        if not isinstance(m.get("command"), list):
            continue
        if m.get("name") == "workbench.registry":
            continue
        manifests.append(m)

    results = [run_one(m, repo_root, args.timeout_ms) for m in manifests]

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    base_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
    registry_path = base_dir / "registry" / "mcp.json"
    registry_path.parent.mkdir(parents=True, exist_ok=True)

    servers: Dict[str, Any] = {}
    for m, r in zip(manifests, results):
        servers[r["name"]] = {
            "version": 1,
            "name": r["name"],
            "manifest": m,
            "lastScannedAt": now,
            "lastHandshakeOk": bool(r["lastHandshakeOk"]),
            "lastError": r.get("lastError"),
            "tools": r.get("tools") or [],
        }

    registry = {"version": 1, "updatedAt": now, "servers": servers}
    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {"scanned": len(results), "results": results, "registryPath": str(registry_path)}
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
