from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class ClaudeCodeTmuxConfig:
    claude_bin: str
    model: Optional[str]
    permission_mode: str
    tmux_session_prefix: str


class ClaudeCodeTmuxProvider:
    """
    Claude Code provider executed via tmux (raw CLI), using --print for non-interactive output.

    This matches the requirement: "for claude, just use tmux and run claude code raw".
    """

    def __init__(self, cfg: ClaudeCodeTmuxConfig):
        self.cfg = cfg

    @staticmethod
    def from_env() -> "ClaudeCodeTmuxProvider":
        claude_bin = (os.environ.get("WORKBENCH_CLAUDE_BIN") or "claude").strip()
        model = (os.environ.get("WORKBENCH_CLAUDE_MODEL") or "").strip() or None
        permission_mode = (os.environ.get("WORKBENCH_CLAUDE_PERMISSION_MODE") or "dontAsk").strip()
        prefix = (os.environ.get("WORKBENCH_CLAUDE_TMUX_PREFIX") or "workbench-claude").strip()
        return ClaudeCodeTmuxProvider(
            ClaudeCodeTmuxConfig(
                claude_bin=claude_bin,
                model=model,
                permission_mode=permission_mode,
                tmux_session_prefix=prefix,
            )
        )

    def doctor(self, timeout_s: float = 2.0) -> Dict[str, Any]:
        return {
            "ok": True,
            "mode": "claude-code-tmux",
            "tmux": self._try_version(["tmux", "-V"], timeout_s=timeout_s),
            "claude": self._try_version([self.cfg.claude_bin, "--version"], timeout_s=timeout_s),
            "model": self.cfg.model,
            "permissionMode": self.cfg.permission_mode,
        }

    def chat(self, messages: List[Dict[str, Any]], timeout_s: float = 60.0) -> Dict[str, Any]:
        prompt = self._messages_to_prompt(messages)
        run_dir_env = (os.environ.get("WORKBENCH_RUN_DIR") or "").strip()
        if run_dir_env:
            run_dir = Path(run_dir_env)
            run_id = run_dir.name
        else:
            run_id = f"run_{int(time.time())}"
            work_dir = Path.cwd()
            state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (work_dir / ".workbench"))
            run_dir = state_dir / "runs" / run_id
            run_dir.mkdir(parents=True, exist_ok=True)

        prompt_path = run_dir / "claude.prompt.txt"
        out_path = run_dir / "claude.stdout.txt"
        err_path = run_dir / "claude.stderr.txt"
        exit_path = run_dir / "claude.exitcode.txt"

        prompt_path.write_text(prompt, encoding="utf-8")

        session = f"{self.cfg.tmux_session_prefix}-{run_id}"
        claude_cmd = [
            self.cfg.claude_bin,
            "--print",
            "--input-format",
            "text",
            "--output-format",
            "text",
            "--permission-mode",
            self.cfg.permission_mode,
            "--tools",
            "",
        ]
        if self.cfg.model:
            claude_cmd += ["--model", self.cfg.model]

        # Run inside tmux; write output to files for durable evidence.
        sh_cmd = (
            f"cat {shlex.quote(str(prompt_path))} | "
            f"{' '.join(shlex.quote(a) for a in claude_cmd)} "
            f"> {shlex.quote(str(out_path))} 2> {shlex.quote(str(err_path))}; "
            f"echo $? > {shlex.quote(str(exit_path))}"
        )
        self._tmux_run(session, ["bash", "-lc", sh_cmd])

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            if exit_path.exists():
                break
            time.sleep(0.2)

        # Best-effort cleanup (session may already have exited).
        self._tmux_kill(session)

        exit_code = None
        try:
            exit_code = int(exit_path.read_text(encoding="utf-8").strip())
        except Exception:
            exit_code = None

        stdout = out_path.read_text(encoding="utf-8", errors="replace") if out_path.exists() else ""
        stderr = err_path.read_text(encoding="utf-8", errors="replace") if err_path.exists() else ""

        if exit_code not in (0, None):
            raise RuntimeError(f"claude exited with code={exit_code}. stderrTail={stderr[-4000:]}")
        if not stdout.strip():
            raise RuntimeError(f"claude produced empty output. stderrTail={stderr[-4000:]}")

        # Return an OpenAI-compat-ish response shape to reuse runner plumbing.
        return {
            "choices": [{"message": {"role": "assistant", "content": stdout.strip()}}],
            "workbench": {
                "provider": "claude-code-tmux",
                "runDir": str(run_dir),
                "stdoutPath": str(out_path),
                "stderrPath": str(err_path),
                "exitPath": str(exit_path),
                "tmuxSession": session,
            },
        }

    def extract_text(self, response: Dict[str, Any]) -> str:
        choices = response.get("choices") or []
        if not choices:
            return ""
        msg = choices[0].get("message") if isinstance(choices[0], dict) else None
        if not isinstance(msg, dict):
            return ""
        return msg.get("content") or ""

    def _messages_to_prompt(self, messages: List[Dict[str, Any]]) -> str:
        parts: List[str] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if not isinstance(content, str):
                continue
            parts.append(f"[{role}]\n{content}")
        return "\n\n".join(parts).strip()

    def _try_version(self, cmd: List[str], timeout_s: float) -> Dict[str, Any]:
        try:
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout_s)
            return {"ok": p.returncode == 0, "stdout": (p.stdout or "").strip(), "stderr": (p.stderr or "").strip()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _tmux_run(self, session: str, command: List[str]) -> None:
        # If session exists, kill it first.
        self._tmux_kill(session)
        subprocess.run(["tmux", "new-session", "-d", "-s", session, "--"] + command, check=True)

    def _tmux_kill(self, session: str) -> None:
        subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
