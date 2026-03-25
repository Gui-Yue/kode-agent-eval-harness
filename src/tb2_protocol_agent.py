"""TB2 solve bridge: vehicle solve path under the official Harbor/TB2 scorer."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    from harbor import BaseAgent
except Exception:  # noqa: BLE001
    class BaseAgent:  # type: ignore[override]
        pass


class ProtocolHarnessAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return 'eval-harness-protocol-agent'

    @staticmethod
    def version() -> str:
        return '0.1.0'

    async def setup(self, environment) -> None:  # type: ignore[no-untyped-def]
        _ = environment

    async def run(self, instruction, environment, context):  # type: ignore[no-untyped-def]
        max_steps = max(1, int(os.getenv('EVAL_HARNESS_TB2_MAX_STEPS') or '48'))
        timeout_ms = max(
            1000,
            int(
                os.getenv('EVAL_HARNESS_SOLVE_TIMEOUT_MS')
                or os.getenv('EVAL_HARNESS_TIMEOUT_MS')
                or '300000'
            ),
        )

        messages: list[dict[str, Any]] = [
            {'role': 'user', 'content': str(instruction or '')},
        ]
        tools = [
            {
                'name': 'exec',
                'parameters': {
                    'type': 'object',
                    'properties': {
                        'command': {'type': 'string'},
                        'cwd': {'type': 'string'},
                        'timeout_sec': {'type': 'number'},
                    },
                    'required': ['command'],
                    'additionalProperties': False,
                },
            }
        ]

        total_input = 0
        total_output = 0
        final_content = ''

        for turn in range(max_steps):
            bridge = await _invoke_bridge(
                payload={
                    'task_id': getattr(context, 'task_id', None) or 'tb2-task',
                    'messages': messages,
                    'tools': tools,
                    'state': {},
                },
                turn=turn,
                timeout_ms=timeout_ms,
            )
            usage = bridge.get('usage') if isinstance(bridge, dict) else None
            if isinstance(usage, dict):
                total_input += int(usage.get('input_tokens') or 0)
                total_output += int(usage.get('output_tokens') or 0)

            if bridge.get('mode') == 'tool_call':
                tool_name = str(bridge.get('name') or '').strip()
                args = bridge.get('arguments') if isinstance(bridge.get('arguments'), dict) else {}
                if tool_name != 'exec':
                    messages.append({'role': 'assistant', 'content': f'Unsupported tool: {tool_name}'})
                    continue

                exec_result = await _environment_exec(environment, args)
                messages.append({'role': 'assistant', 'content': json.dumps({'tool_call': {'name': tool_name, 'arguments': args}}, ensure_ascii=True)})
                messages.append({'role': 'tool', 'content': json.dumps(exec_result, ensure_ascii=True)})
                continue

            final_content = str(bridge.get('content') or '').strip()
            if not final_content:
                final_content = 'Completed without a final message.'
            messages.append({'role': 'assistant', 'content': final_content})
            break
        else:
            final_content = 'Step budget exhausted before completion.'
            messages.append({'role': 'assistant', 'content': final_content})

        _set_context_attr(context, 'final_output', final_content)
        _set_context_attr(context, 'output', final_content)
        _set_context_attr(context, 'n_input_tokens', total_input)
        _set_context_attr(context, 'n_output_tokens', total_output)
        _set_context_attr(context, 'n_total_tokens', total_input + total_output)
        return final_content


def _log(message: str) -> None:
    sys.stderr.write(f'[tb2-bridge] {message}\n')
    sys.stderr.flush()


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _tsx_path() -> str:
    local = _repo_root() / 'node_modules' / '.bin' / 'tsx'
    if local.exists():
        return str(local)
    return 'tsx'


async def _invoke_bridge(*, payload: dict[str, Any], turn: int, timeout_ms: int) -> dict[str, Any]:
    task_id = str(payload.get('task_id') or 'tb2-task')
    cmd = [
        _tsx_path(),
        str(_repo_root() / 'src' / 'index.ts'),
        'bridge-agent',
        '--mode=tb2',
        f"--agent={os.getenv('EVAL_HARNESS_AGENT_REF', 'mock')}",
        f"--model={os.getenv('EVAL_HARNESS_MODEL', 'openai/glm-5')}",
        f'--task-id={task_id}',
        f'--turn-id={turn}',
        f'--deadline-ms={timeout_ms}',
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=None,
        cwd=str(_repo_root()),
    )
    _log(f'invoke turn={turn} timeout_ms={timeout_ms}')
    stdout, _ = await asyncio.wait_for(
        proc.communicate(json.dumps(payload).encode('utf-8')),
        timeout=max(1.0, timeout_ms / 1000.0),
    )
    if proc.returncode != 0:
        raise RuntimeError(stdout.decode('utf-8', errors='ignore').strip() or f'bridge exit={proc.returncode}')
    _log(f'bridge response received turn={turn}')
    return json.loads(stdout.decode('utf-8'))


async def _environment_exec(environment, args: dict[str, Any]) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    command = str(args.get('command') or '').strip()
    cwd = args.get('cwd')
    timeout_sec = args.get('timeout_sec')

    try:
        result = await environment.exec(command=command, cwd=cwd, timeout_sec=timeout_sec)
    except TypeError:
        result = await environment.exec(command)

    stdout = getattr(result, 'stdout', None)
    stderr = getattr(result, 'stderr', None)
    exit_code = getattr(result, 'exit_code', None)
    if exit_code is None:
        exit_code = getattr(result, 'returncode', None)

    return {
        'command': command,
        'cwd': cwd,
        'stdout': stdout if isinstance(stdout, str) else str(stdout or ''),
        'stderr': stderr if isinstance(stderr, str) else str(stderr or ''),
        'exit_code': exit_code if isinstance(exit_code, int) else 0,
    }


def _set_context_attr(context, name: str, value: Any) -> None:  # type: ignore[no-untyped-def]
    try:
        setattr(context, name, value)
    except Exception:  # noqa: BLE001
        pass
