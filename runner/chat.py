#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

from run_smoke import ConfigError, redact_obj, redact_text, resolve_provider, write_json, ensure_dir, SUMMARY_SCHEMA_VERSION, EVENT_SCHEMA_VERSION


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class EvidenceWriter:
    def __init__(self, path: Path, max_bytes: int):
        self.path = path
        self.max_bytes = max_bytes
        self._disabled = False

    def append(self, obj: Dict[str, Any]) -> None:
        if self._disabled:
            return
        line = json.dumps({"schemaVersion": EVENT_SCHEMA_VERSION, **obj}, ensure_ascii=False) + "\n"
        try:
            current = self.path.stat().st_size if self.path.exists() else 0
        except Exception:
            current = 0
        if self.max_bytes > 0 and current + len(line.encode("utf-8", errors="replace")) > self.max_bytes:
            self._disabled = True
            return
        with self.path.open("a", encoding="utf-8") as f:
            f.write(line)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--system", default="You are a helpful assistant.", help="System instruction")
    args = ap.parse_args()

    repo_root = Path.cwd()
    state_dir = Path(os.environ.get("WORKBENCH_STATE_DIR") or (repo_root / ".workbench"))
    chat_id = f"chat_{int(time.time())}"
    chat_dir = state_dir / "chats" / chat_id
    ensure_dir(chat_dir)
    os.environ["WORKBENCH_RUN_DIR"] = str(chat_dir)

    evidence_max = int((os.environ.get("WORKBENCH_EVIDENCE_MAX_BYTES") or "20000000").strip() or "20000000")
    events_path = chat_dir / "events.jsonl"
    summary_path = chat_dir / "summary.json"
    evidence = EvidenceWriter(events_path, evidence_max)

    try:
        provider, provider_info, secrets = resolve_provider()
    except ConfigError as e:
        summary = {
            "schemaVersion": SUMMARY_SCHEMA_VERSION,
            "chatId": chat_id,
            "chatDir": str(chat_dir),
            "events": str(events_path),
            "stateDir": str(state_dir),
            "provider": {"mode": "unconfigured"},
            "errorKind": "config",
            "error": str(e).replace("\n", " "),
        }
        write_json(summary_path, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 2

    evidence.append({"type": "chat.start", "at": now_iso(), "chatId": chat_id, "provider": redact_obj(provider_info, secrets)})

    messages: List[Dict[str, Any]] = [{"role": "system", "content": args.system}]

    print(f"[workbench-chat] chatDir={chat_dir}")
    print("[workbench-chat] Type your message. Empty line or /exit to quit.\n")

    while True:
        try:
            user = input("> ").strip()
        except EOFError:
            break
        if not user or user in ("/exit", "/quit"):
            break
        messages.append({"role": "user", "content": user})
        evidence.append({"type": "llm.request", "at": now_iso(), "messages": redact_obj(messages, secrets)})
        try:
            llm_resp = provider.chat(messages, timeout_s=60.0)  # type: ignore[attr-defined]
            content = provider.extract_text(llm_resp)
            content_redacted = redact_text(content, secrets)
            evidence.append(
                {"type": "llm.response", "at": now_iso(), "raw": redact_obj(llm_resp, secrets), "content": content_redacted}
            )
        except Exception as e:
            evidence.append({"type": "llm.error", "at": now_iso(), "error": redact_text(str(e), secrets)})
            print(f"[workbench-chat] ERROR: {e}")
            continue
        print(content)
        messages.append({"role": "assistant", "content": content})

    summary = {
        "schemaVersion": SUMMARY_SCHEMA_VERSION,
        "chatId": chat_id,
        "chatDir": str(chat_dir),
        "events": str(events_path),
        "provider": redact_obj(provider_info, secrets),
        "stateDir": str(state_dir),
        "endedAt": now_iso(),
    }
    write_json(summary_path, summary)
    print(f"\n[workbench-chat] saved: {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

