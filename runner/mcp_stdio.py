from __future__ import annotations

import json
import os
import select
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


HEADER_SEPARATOR = b"\r\n\r\n"


def encode_message(obj: Dict[str, Any]) -> bytes:
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    return header + body


def _try_parse_one(buffer: bytes) -> Tuple[Optional[Dict[str, Any]], bytes]:
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
    return json.loads(body.decode("utf-8")), rest


@dataclass
class ProcResult:
    proc: subprocess.Popen[bytes]
    stdout_buf: bytes = b""
    stderr_buf: bytes = b""


class McpStdioClient:
    def __init__(self, command: list[str], cwd: str, env: dict[str, str]):
        self.command = command
        self.cwd = cwd
        self.env = env
        self._next_id = 1
        self._proc: Optional[ProcResult] = None

    def start(self) -> None:
        if self._proc is not None:
            return
        p = subprocess.Popen(
            self.command,
            cwd=self.cwd,
            env=self.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._proc = ProcResult(proc=p)

    def stop(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.proc.kill()
        except Exception:
            pass
        self._proc = None

    def request(self, method: str, params: Any | None, timeout_s: float) -> Dict[str, Any]:
        _, resp, _ = self.request_with_meta(method, params, timeout_s)
        return resp

    def request_with_meta(self, method: str, params: Any | None, timeout_s: float) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
        self.start()
        assert self._proc is not None
        proc = self._proc.proc
        msg_id = self._next_id
        self._next_id += 1

        payload: Dict[str, Any] = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params is not None:
            payload["params"] = params

        assert proc.stdin is not None
        proc.stdin.write(encode_message(payload))
        proc.stdin.flush()

        resp = self._read_response(msg_id, timeout_s)
        meta = self._collect_meta()
        return payload, resp, meta

    def _read_response(self, want_id: int, timeout_s: float) -> Dict[str, Any]:
        assert self._proc is not None
        proc = self._proc.proc
        deadline = time.time() + timeout_s
        buf = self._proc.stdout_buf

        if proc.stdout is None:
            raise RuntimeError("stdout not available")

        fd = proc.stdout.fileno()
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError(f"Timed out waiting for response id={want_id}")

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
                msg, buf = _try_parse_one(buf)
                if msg is None:
                    break
                if isinstance(msg, dict) and msg.get("id") == want_id:
                    self._proc.stdout_buf = buf
                    return msg

    def _collect_meta(self) -> Dict[str, Any]:
        assert self._proc is not None
        self._drain_stderr()
        proc = self._proc.proc
        stderr_tail = self._proc.stderr_buf[-8000:].decode("utf-8", errors="replace") if self._proc.stderr_buf else ""
        return {
            "pid": proc.pid,
            "returncode": proc.poll(),
            "stderrTail": stderr_tail,
            "command": self.command,
            "cwd": self.cwd,
        }

    def _drain_stderr(self) -> None:
        assert self._proc is not None
        proc = self._proc.proc
        if proc.stderr is None:
            return
        fd = proc.stderr.fileno()
        while True:
            readable, _, _ = select.select([fd], [], [], 0)
            if not readable:
                break
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            self._proc.stderr_buf += chunk


def mcp_initialize(client: McpStdioClient, timeout_s: float = 10.0) -> Dict[str, Any]:
    return client.request(
        "initialize",
        {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "workbench-runner", "version": "0.0.0"}},
        timeout_s,
    )


def mcp_tools_list(client: McpStdioClient, timeout_s: float = 10.0) -> Dict[str, Any]:
    return client.request("tools/list", None, timeout_s)


def mcp_tools_call(client: McpStdioClient, name: str, arguments: Any, timeout_s: float = 30.0) -> Dict[str, Any]:
    return client.request("tools/call", {"name": name, "arguments": arguments}, timeout_s)
