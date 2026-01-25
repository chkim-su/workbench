from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class MockConfig:
    scenario: str = "smoke-v1"


class MockProvider:
    """
    Deterministic offline provider for validating the tool-loop path.

    It emits canned tool-call JSON outputs that drive:
    registry.scan -> workflow.upload -> workflow.status -> workflow.update -> workflow.status -> final
    """

    def __init__(self, cfg: MockConfig | None = None):
        self.cfg = cfg or MockConfig()

    @staticmethod
    def from_env() -> "MockProvider":
        return MockProvider()

    def doctor(self, timeout_s: float = 2.0) -> Dict[str, Any]:
        return {"ok": True, "mode": "mock", "note": "Deterministic offline provider (no network)."}

    def chat(self, messages: List[Dict[str, Any]], timeout_s: float = 60.0) -> Dict[str, Any]:
        step = self._infer_step(messages)
        content = self._next_content(step, messages)
        return {"choices": [{"message": {"role": "assistant", "content": content}}], "mock": True, "step": step}

    def extract_text(self, response: Dict[str, Any]) -> str:
        choices = response.get("choices") or []
        if not choices:
            return ""
        msg = choices[0].get("message") or {}
        return msg.get("content") or ""

    def _infer_step(self, messages: List[Dict[str, Any]]) -> int:
        tool_calls = 0
        for m in messages:
            if m.get("role") != "assistant":
                continue
            txt = m.get("content") or ""
            if isinstance(txt, str) and txt.strip().startswith('{"tool":'):
                tool_calls += 1
        return tool_calls

    def _extract_workflow_id(self, messages: List[Dict[str, Any]]) -> str:
        for m in messages:
            if m.get("role") != "user":
                continue
            txt = m.get("content") or ""
            if not isinstance(txt, str):
                continue
            m_id = re.search(r"\bUse workflow id:\s*(smoke_\d+)\b", txt)
            if m_id:
                return m_id.group(1)
        return f"smoke_{0}"

    def _extract_last_status_state(self, messages: List[Dict[str, Any]]) -> Optional[str]:
        for m in reversed(messages):
            if m.get("role") != "user":
                continue
            txt = m.get("content") or ""
            if not isinstance(txt, str) or "Tool result for workbench.workflow.status" not in txt:
                continue
            start = txt.find("{")
            end = txt.rfind("}")
            if start == -1 or end == -1 or end <= start:
                continue
            try:
                resp = json.loads(txt[start : end + 1])
                state = (
                    resp.get("result", {})
                    .get("content", [{}])[0]
                    .get("json", {})
                    .get("status", {})
                    .get("state")
                )
                if isinstance(state, str):
                    return state
            except Exception:
                continue
        return None

    def _next_content(self, step: int, messages: List[Dict[str, Any]]) -> str:
        wf_id = self._extract_workflow_id(messages)
        if step == 0:
            return '{"tool":"workbench.registry.scan","arguments":{"timeoutMs":10000}}'
        if step == 1:
            wf = {"version": 1, "id": wf_id, "steps": [{"id": "s1", "kind": "note", "note": "hello"}]}
            return '{"tool":"workbench.workflow.upload","arguments":{"workflow":' + json.dumps(wf, separators=(",", ":")) + "}}"
        if step == 2:
            return '{"tool":"workbench.workflow.status","arguments":{"id":"' + wf_id + '"}}'
        if step == 3:
            return '{"tool":"workbench.workflow.update","arguments":{"id":"' + wf_id + '","note":"updated"}}'
        if step == 4:
            return '{"tool":"workbench.workflow.status","arguments":{"id":"' + wf_id + '"}}'

        state = self._extract_last_status_state(messages) or "unknown"
        return '{"final":"smoke ok (mock). last workflow state=' + state + '"}'

