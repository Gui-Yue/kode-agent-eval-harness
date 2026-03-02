"""TAU2 plugin: register a real KODE-backed LLM agent."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from tau2.agent.llm_agent import LLMAgent
from tau2.data_model.message import AssistantMessage, ToolCall
from tau2.registry import registry
from tau2.utils.llm_utils import get_response_cost

_REQUEST_THROTTLE_LOCK = threading.Lock()
_LAST_REQUEST_TS = 0.0


def _to_bridge_message(message: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "role": getattr(message, "role", ""),
        "content": getattr(message, "content", None),
    }
    tool_calls = getattr(message, "tool_calls", None)
    if tool_calls:
        out["tool_calls"] = [
            {
                "id": tc.id,
                "name": tc.name,
                "arguments": tc.arguments,
                "requestor": tc.requestor,
            }
            for tc in tool_calls
        ]
    tool_call_id = getattr(message, "id", None)
    if tool_call_id:
        out["tool_call_id"] = tool_call_id
    return out


def _extract_usage(usage: dict[str, Any] | None) -> dict[str, int] | None:
    if not isinstance(usage, dict):
        return None
    in_tok = usage.get("input_tokens")
    out_tok = usage.get("output_tokens")
    if not isinstance(in_tok, int) or not isinstance(out_tok, int):
        return None
    return {"prompt_tokens": in_tok, "completion_tokens": out_tok}


def _resolve_bridge_path() -> str:
    env_path = (os.getenv("TAU2_KODE_BRIDGE_PATH") or "").strip()
    if env_path:
        return str(Path(env_path).resolve())
    return str(Path(__file__).resolve().with_name("tau2_kode_bridge.mjs"))


def _invoke_kode_bridge(
    *,
    model: str | None,
    llm_args: dict[str, Any] | None,
    tools: list[Any],
    messages: list[Any],
) -> dict[str, Any]:
    payload = {
        "model": model,
        "llm_args": llm_args or {},
        "tools": [t.openai_schema for t in tools],
        "messages": [_to_bridge_message(m) for m in messages],
    }

    cmd = ["node", _resolve_bridge_path()]
    timeout_ms = int(os.getenv("TAU2_KODE_BRIDGE_TIMEOUT_MS") or "300000")
    retries = max(0, int(os.getenv("TAU2_KODE_BRIDGE_RETRIES") or "2"))

    def _retryable(err_msg: str) -> bool:
        s = err_msg.lower()
        return any(
            key in s
            for key in [
                "timed out",
                "timeout",
                "429",
                "rate limit",
                "connection error",
                "econnreset",
                "etimedout",
                "502",
                "503",
                "504",
            ]
        )

    last_error = "kode bridge failed"
    total_attempts = retries + 1
    for attempt in range(total_attempts):
        try:
            proc = subprocess.run(
                cmd,
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                timeout=max(1, timeout_ms) / 1000.0,
                check=False,
            )
        except subprocess.TimeoutExpired:
            last_error = f"kode bridge timed out after {timeout_ms}ms"
            if attempt < total_attempts - 1:
                time.sleep(min(2 ** attempt, 3))
                continue
            raise RuntimeError(last_error) from None

        if proc.returncode == 0:
            try:
                return json.loads(proc.stdout)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"invalid bridge JSON output: {exc}; raw={proc.stdout[:500]}") from exc

        last_error = f"kode bridge failed (exit={proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}"
        if attempt < total_attempts - 1 and _retryable(last_error):
            time.sleep(min(2 ** attempt, 3))
            continue
        raise RuntimeError(last_error)

    raise RuntimeError(last_error)


def _throttle_bridge_requests() -> None:
    interval_ms = int(os.getenv("TAU2_KODE_MIN_REQUEST_INTERVAL_MS") or "0")
    if interval_ms <= 0:
        return

    global _LAST_REQUEST_TS
    interval_s = interval_ms / 1000.0
    with _REQUEST_THROTTLE_LOCK:
        now = time.monotonic()
        next_allowed = _LAST_REQUEST_TS + interval_s
        if now < next_allowed:
            time.sleep(next_allowed - now)
            now = time.monotonic()
        _LAST_REQUEST_TS = now


class KodeLLMAgent(LLMAgent):
    """Drop-in LLMAgent replacement backed by KODE SDK."""

    def generate_next_message(self, message, state):  # type: ignore[override]
        if message.__class__.__name__ == "MultiToolMessage":
            state.messages.extend(message.tool_messages)
        else:
            state.messages.append(message)

        messages = state.system_messages + state.messages
        try:
            _throttle_bridge_requests()
            bridge = _invoke_kode_bridge(
                model=self.llm,
                llm_args=self.llm_args,
                tools=self.tools,
                messages=messages,
            )
        except Exception as exc:  # noqa: BLE001
            err = str(exc).strip()[:500]
            assistant_message = AssistantMessage(
                role="assistant",
                content=f"Temporary upstream error. Please retry. ({err})",
                tool_calls=None,
                cost=0.0,
                usage=None,
                raw_data={"bridge_error": err},
            )
            state.messages.append(assistant_message)
            return assistant_message, state

        mode = bridge.get("mode")
        usage = _extract_usage(bridge.get("usage"))
        raw_data = {"bridge": bridge}

        if mode == "tool_call":
            tool_name = str(bridge.get("name") or "").strip()
            if not tool_name:
                assistant_message = AssistantMessage(
                    role="assistant",
                    content="Tool call generation failed. Please retry with a concise instruction.",
                    tool_calls=None,
                    cost=0.0,
                    usage=usage,
                    raw_data=raw_data,
                )
                state.messages.append(assistant_message)
                return assistant_message, state
            args = bridge.get("arguments")
            if not isinstance(args, dict):
                args = {}
            tc = ToolCall(
                id=str(bridge.get("id") or f"kode_{uuid.uuid4().hex[:12]}"),
                name=tool_name,
                arguments=args,
            )
            assistant_message = AssistantMessage(
                role="assistant",
                content=None,
                tool_calls=[tc],
                cost=0.0,
                usage=usage,
                raw_data=raw_data,
            )
        else:
            content = bridge.get("content")
            if not isinstance(content, str):
                content = str(content or "")
            content = content.strip()
            if not content:
                raw_text = bridge.get("raw_text")
                if isinstance(raw_text, str) and raw_text.strip():
                    content = raw_text.strip()
                else:
                    content = "I need more context to continue. Please restate your request."
            assistant_message = AssistantMessage(
                role="assistant",
                content=content,
                tool_calls=None,
                cost=0.0,
                usage=usage,
                raw_data=raw_data,
            )

        # Try to compute cost if response shape is compatible, otherwise keep 0.
        try:
            # no-op: placeholder to keep parity with llm_utils path
            _ = get_response_cost  # keep import used for future extension
        except Exception:
            pass

        state.messages.append(assistant_message)
        return assistant_message, state


def register(agent_name: str | None = None) -> None:
    name = (agent_name or os.getenv("TAU2_AGENT_PLUGIN_NAME") or "kode_agent").strip()
    if not name:
        raise ValueError("empty target agent name")

    # Allow re-registration safely.
    try:
        registry._agents[name] = KodeLLMAgent  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"failed to register agent {name}: {exc}") from exc
