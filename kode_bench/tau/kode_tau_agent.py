import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from tau_bench.agents.base import Agent
from tau_bench.envs.base import Env
from tau_bench.types import Action, RESPOND_ACTION_NAME, SolveResult


class KodeTauAgent(Agent):
    """Tau adapter backed by the KODE provider/tool-calling stack."""

    def __init__(
        self,
        tools_info: List[Dict[str, Any]],
        wiki: str,
        model: str,
        provider: str,
        temperature: float = 0.0,
        step_runner_path: str | None = None,
        node_binary: str = "node",
    ):
        self.tools_info = tools_info
        self.wiki = wiki
        self.model_name = model if "/" in model else f"{provider}/{model}"
        self.temperature = temperature
        self.node_binary = node_binary
        self.step_runner_path = Path(
            step_runner_path or os.environ.get("KODE_TAU_STEP_RUNNER_PATH", "")
        ).expanduser()

        if not self.step_runner_path.exists():
            raise ValueError(
                "KODE Tau step runner bundle was not found. "
                f"Expected: {self.step_runner_path}"
            )

    def _run_step(self, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="kode-tau-step-") as temp_dir_str:
            temp_dir = Path(temp_dir_str)
            messages_path = temp_dir / "messages.json"
            tools_path = temp_dir / "tools.json"
            output_path = temp_dir / "result.json"
            messages_path.write_text(json.dumps(messages, ensure_ascii=False))
            tools_path.write_text(json.dumps(self.tools_info, ensure_ascii=False))

            command = [
                self.node_binary,
                str(self.step_runner_path),
                "--model-name",
                self.model_name,
                "--messages-file",
                str(messages_path),
                "--tools-file",
                str(tools_path),
                "--output",
                str(output_path),
                "--temperature",
                str(self.temperature),
            ]
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                env=os.environ.copy(),
            )
            if completed.returncode != 0:
                raise RuntimeError(
                    "Kode tau step runner failed.\n"
                    f"stdout:\n{completed.stdout}\n"
                    f"stderr:\n{completed.stderr}"
                )

            payload = json.loads(output_path.read_text())
            if not payload.get("ok"):
                raise RuntimeError(payload.get("error") or "Kode tau step failed.")
            return payload

    def solve(
        self, env: Env, task_index: Optional[int] = None, max_num_steps: int = 30
    ) -> SolveResult:
        total_cost = 0.0
        env_reset_res = env.reset(task_index=task_index)
        obs = env_reset_res.observation
        info = env_reset_res.info.model_dump()
        reward = 0.0
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": self.wiki},
            {"role": "user", "content": obs},
        ]

        for _ in range(max_num_steps):
            step = self._run_step(messages)
            usage = step.get("usage") or {}
            if usage.get("cost_usd") is not None:
                total_cost += usage["cost_usd"]

            action_payload = step.get("action") or {}
            action_type = action_payload.get("type")
            if action_type == "tool_call":
                tool_call = action_payload.get("tool_call") or {}
                tool_name = tool_call.get("name")
                tool_arguments = tool_call.get("arguments") or {}
                call_id = tool_call.get("id") or f"{tool_name}-call"
                next_message = {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "arguments": json.dumps(tool_arguments, ensure_ascii=False),
                            },
                        }
                    ],
                }
                env_response = env.step(Action(name=tool_name, kwargs=tool_arguments))
                reward = env_response.reward
                info = {**info, **env_response.info.model_dump()}
                messages.extend(
                    [
                        next_message,
                        {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": tool_name,
                            "content": env_response.observation,
                        },
                    ]
                )
                if env_response.done:
                    break
                continue

            if action_type == "respond":
                text = action_payload.get("text", "")
                env_response = env.step(
                    Action(
                        name=RESPOND_ACTION_NAME,
                        kwargs={"content": text},
                    )
                )
                reward = env_response.reward
                info = {**info, **env_response.info.model_dump()}
                messages.append({"role": "assistant", "content": text})
                if not env_response.done:
                    messages.append(
                        {"role": "user", "content": env_response.observation}
                    )
                if env_response.done:
                    break
                continue

            raise RuntimeError(f"Unsupported Kode tau action: {action_type}")

        return SolveResult(
            reward=reward,
            info=info,
            messages=messages,
            total_cost=total_cost if total_cost else None,
        )
