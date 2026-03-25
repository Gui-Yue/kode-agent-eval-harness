"""TB2 solve bridge: vehicle solve path under the official Harbor/TB2 scorer."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

try:
    from harbor import BaseAgent
except Exception:  # noqa: BLE001
    class BaseAgent:  # type: ignore[override]
        pass


ToolHandler = Callable[[Any, dict[str, Any]], Awaitable[dict[str, Any]]]


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
        tools = _tb2_tools()

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
                handler = _TOOL_HANDLERS.get(tool_name)
                if handler is None:
                    messages.append({'role': 'assistant', 'content': f'Unsupported tool: {tool_name}'})
                    continue

                tool_result = await handler(environment, args)
                messages.append({
                    'role': 'assistant',
                    'content': json.dumps({'tool_call': {'name': tool_name, 'arguments': args}}, ensure_ascii=True),
                })
                messages.append({'role': 'tool', 'content': json.dumps(tool_result, ensure_ascii=True)})
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


def _tb2_tools() -> list[dict[str, Any]]:
    return [
        {
            'name': 'exec',
            'description': 'Run a focused shell command inside the official TB2 environment. Prefer this for build, test, git, compiler, package-manager, and general terminal tasks.',
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
        },
        {
            'name': 'list_dir',
            'description': 'List directory entries in structured form. Use this for workspace exploration instead of broad ls/find shell commands.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string'},
                    'recursive': {'type': 'boolean'},
                    'max_entries': {'type': 'integer'},
                },
                'additionalProperties': False,
            },
        },
        {
            'name': 'read_file',
            'description': 'Read a text file with bounded line and character limits. Use this for source inspection instead of cat.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string'},
                    'start_line': {'type': 'integer'},
                    'max_lines': {'type': 'integer'},
                    'max_chars': {'type': 'integer'},
                },
                'required': ['path'],
                'additionalProperties': False,
            },
        },
        {
            'name': 'grep_text',
            'description': 'Search for text or regex in one file or a directory tree. Use this for targeted discovery instead of large recursive shell output.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'pattern': {'type': 'string'},
                    'path': {'type': 'string'},
                    'ignore_case': {'type': 'boolean'},
                    'max_matches': {'type': 'integer'},
                },
                'required': ['pattern'],
                'additionalProperties': False,
            },
        },
        {
            'name': 'write_file',
            'description': 'Create, overwrite, or append a file with exact content. Use this for deterministic file creation or full rewrites.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string'},
                    'content': {'type': 'string'},
                    'append': {'type': 'boolean'},
                },
                'required': ['path', 'content'],
                'additionalProperties': False,
            },
        },
        {
            'name': 'replace_in_file',
            'description': 'Replace exact text in a file. Use this for surgical edits instead of shell sed/perl when possible.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string'},
                    'old_text': {'type': 'string'},
                    'new_text': {'type': 'string'},
                    'replace_all': {'type': 'boolean'},
                },
                'required': ['path', 'old_text', 'new_text'],
                'additionalProperties': False,
            },
        },
    ]


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
    cmd = [
        _tsx_path(),
        str(_repo_root() / 'src' / 'index.ts'),
        'bridge-agent',
        '--mode=tb2',
        f"--agent={os.getenv('EVAL_HARNESS_AGENT_REF', 'mock')}",
        f"--model={os.getenv('EVAL_HARNESS_MODEL', 'openai/glm-5')}",
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


def _parse_positive_int(value: Any, default: int, minimum: int = 1, maximum: int | None = None) -> int:
    try:
        parsed = int(value)
    except Exception:  # noqa: BLE001
        parsed = default
    parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _tool_output_limit() -> int:
    return _parse_positive_int(os.getenv('EVAL_HARNESS_TB2_TOOL_OUTPUT_CHARS'), 12000, minimum=512)


def _truncate_text(text: str, limit: int | None = None) -> tuple[str, bool, int]:
    raw = text if isinstance(text, str) else str(text or '')
    cap = limit or _tool_output_limit()
    if len(raw) <= cap:
        return raw, False, len(raw)
    omitted = len(raw) - cap
    suffix = f'\n...[truncated {omitted} chars]'
    keep = max(0, cap - len(suffix))
    return raw[:keep] + suffix, True, len(raw)


def _normalize_command_result(command: str, cwd: Any, result: Any) -> dict[str, Any]:
    stdout = getattr(result, 'stdout', None)
    stderr = getattr(result, 'stderr', None)
    exit_code = getattr(result, 'exit_code', None)
    if exit_code is None:
        exit_code = getattr(result, 'returncode', None)

    stdout_text, stdout_truncated, stdout_chars = _truncate_text(
        stdout if isinstance(stdout, str) else str(stdout or ''),
    )
    stderr_text, stderr_truncated, stderr_chars = _truncate_text(
        stderr if isinstance(stderr, str) else str(stderr or ''),
    )

    return {
        'command': command,
        'cwd': cwd,
        'stdout': stdout_text,
        'stderr': stderr_text,
        'exit_code': exit_code if isinstance(exit_code, int) else 0,
        'stdout_chars': stdout_chars,
        'stderr_chars': stderr_chars,
        'stdout_truncated': stdout_truncated,
        'stderr_truncated': stderr_truncated,
    }


async def _run_shell(environment, command: str, cwd: Any = None, timeout_sec: Any = None) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    command = str(command or '').strip()

    try:
        result = await environment.exec(command=command, cwd=cwd, timeout_sec=timeout_sec)
    except TypeError:
        result = await environment.exec(command)

    return _normalize_command_result(command, cwd, result)


def _json_python_literal(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)


def _decode_shell_json_result(result: dict[str, Any]) -> dict[str, Any]:
    if int(result.get('exit_code') or 0) != 0:
        return result

    stdout = result.get('stdout')
    if not isinstance(stdout, str):
        return result

    try:
        parsed = json.loads(stdout)
    except Exception:  # noqa: BLE001
        return result

    if isinstance(parsed, dict):
        return parsed
    return {'ok': True, 'value': parsed}


async def _environment_exec(environment, args: dict[str, Any]) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    command = str(args.get('command') or '').strip()
    cwd = args.get('cwd')
    timeout_sec = args.get('timeout_sec')
    return await _run_shell(environment, command, cwd=cwd, timeout_sec=timeout_sec)


async def _list_dir(environment, args: dict[str, Any]) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    path = str(args.get('path') or '.')
    recursive = bool(args.get('recursive'))
    max_entries = _parse_positive_int(args.get('max_entries'), 200, minimum=1, maximum=2000)
    script = f"""
import json
from pathlib import Path

root = Path({_json_python_literal(path)})
if not root.exists():
    print(json.dumps({{'ok': False, 'path': str(root), 'error': 'path does not exist'}}, ensure_ascii=True))
    raise SystemExit(0)

entries = []
truncated = False

def append_entry(item):
    global truncated
    if len(entries) >= {max_entries}:
        truncated = True
        return False
    stat = item.stat()
    entries.append({{
        'path': str(item),
        'type': 'dir' if item.is_dir() else ('file' if item.is_file() else 'other'),
        'size': stat.st_size,
    }})
    return True

if root.is_file():
    append_entry(root)
else:
    iterator = root.rglob('*') if {str(recursive)} else root.iterdir()
    for item in iterator:
        if not append_entry(item):
            break

entries.sort(key=lambda row: row['path'])
print(json.dumps({{
    'ok': True,
    'path': str(root),
    'recursive': {str(recursive)},
    'entries': entries,
    'truncated': truncated,
    'returned_entries': len(entries),
}}, ensure_ascii=True))
""".strip()
    result = await _run_shell(environment, f"python3 - <<'PY'\n{script}\nPY")
    return _decode_shell_json_result(result)


async def _read_file(environment, args: dict[str, Any]) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    path = str(args.get('path') or '').strip()
    start_line = _parse_positive_int(args.get('start_line'), 1, minimum=1)
    max_lines = _parse_positive_int(args.get('max_lines'), 200, minimum=1, maximum=2000)
    max_chars = _parse_positive_int(args.get('max_chars'), 12000, minimum=128, maximum=50000)
    script = f"""
import json
from pathlib import Path

path = Path({_json_python_literal(path)})
if not path.exists():
    print(json.dumps({{'ok': False, 'path': str(path), 'error': 'file does not exist'}}, ensure_ascii=True))
    raise SystemExit(0)
if not path.is_file():
    print(json.dumps({{'ok': False, 'path': str(path), 'error': 'path is not a file'}}, ensure_ascii=True))
    raise SystemExit(0)

text = path.read_text(encoding='utf-8', errors='replace')
lines = text.splitlines()
start_idx = max(0, {start_line} - 1)
selected = lines[start_idx:start_idx + {max_lines}]
content = '\\n'.join(selected)
truncated = False
if len(content) > {max_chars}:
    omitted = len(content) - {max_chars}
    content = content[:{max_chars}] + '\\n...[truncated ' + str(omitted) + ' chars]'
    truncated = True
print(json.dumps({{
    'ok': True,
    'path': str(path),
    'start_line': {start_line},
    'returned_lines': len(selected),
    'total_lines': len(lines),
    'content': content,
    'truncated': truncated or (start_idx + len(selected) < len(lines)),
}}, ensure_ascii=True))
""".strip()
    result = await _run_shell(environment, f"python3 - <<'PY'\n{script}\nPY")
    return _decode_shell_json_result(result)


async def _grep_text(environment, args: dict[str, Any]) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    pattern = str(args.get('pattern') or '').strip()
    path = str(args.get('path') or '.')
    ignore_case = bool(args.get('ignore_case'))
    max_matches = _parse_positive_int(args.get('max_matches'), 50, minimum=1, maximum=500)
    script = f"""
import json
import re
from pathlib import Path

pattern = {_json_python_literal(pattern)}
root = Path({_json_python_literal(path)})
flags = re.IGNORECASE if {str(ignore_case)} else 0
matcher = re.compile(pattern, flags)

if not root.exists():
    print(json.dumps({{'ok': False, 'path': str(root), 'error': 'path does not exist'}}, ensure_ascii=True))
    raise SystemExit(0)

matches = []
truncated = False
paths = [root] if root.is_file() else sorted(root.rglob('*'))
for candidate in paths:
    if not candidate.is_file():
        continue
    try:
        text = candidate.read_text(encoding='utf-8', errors='replace')
    except Exception as exc:
        matches.append({{'path': str(candidate), 'line': None, 'match': '[read error] ' + str(exc)}})
        if len(matches) >= {max_matches}:
            truncated = True
            break
        continue
    for idx, line in enumerate(text.splitlines(), start=1):
        if matcher.search(line):
            line_text = line
            if len(line_text) > 300:
                omitted = len(line_text) - 260
                line_text = line_text[:260] + '...[truncated ' + str(omitted) + ' chars]'
            matches.append({{'path': str(candidate), 'line': idx, 'match': line_text}})
            if len(matches) >= {max_matches}:
                truncated = True
                break
    if truncated:
        break

print(json.dumps({{
    'ok': True,
    'pattern': pattern,
    'path': str(root),
    'ignore_case': {str(ignore_case)},
    'matches': matches,
    'truncated': truncated,
}}, ensure_ascii=True))
""".strip()
    result = await _run_shell(environment, f"python3 - <<'PY'\n{script}\nPY")
    return _decode_shell_json_result(result)


async def _write_file(environment, args: dict[str, Any]) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    path = str(args.get('path') or '').strip()
    content = str(args.get('content') or '')
    append = bool(args.get('append'))
    content_b64 = base64.b64encode(content.encode('utf-8')).decode('ascii')
    script = f"""
import base64
import json
from pathlib import Path

path = Path({_json_python_literal(path)})
path.parent.mkdir(parents=True, exist_ok=True)
data = base64.b64decode({_json_python_literal(content_b64)}).decode('utf-8')
mode = 'a' if {str(append)} else 'w'
with path.open(mode, encoding='utf-8') as f:
    f.write(data)
print(json.dumps({{
    'ok': True,
    'path': str(path),
    'append': {str(append)},
    'bytes_written': len(data.encode('utf-8')),
    'chars_written': len(data),
}}, ensure_ascii=True))
""".strip()
    result = await _run_shell(environment, f"python3 - <<'PY'\n{script}\nPY")
    return _decode_shell_json_result(result)


async def _replace_in_file(environment, args: dict[str, Any]) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    path = str(args.get('path') or '').strip()
    old_text = str(args.get('old_text') or '')
    new_text = str(args.get('new_text') or '')
    replace_all = bool(args.get('replace_all'))
    old_b64 = base64.b64encode(old_text.encode('utf-8')).decode('ascii')
    new_b64 = base64.b64encode(new_text.encode('utf-8')).decode('ascii')
    script = f"""
import base64
import json
from pathlib import Path

path = Path({_json_python_literal(path)})
if not path.exists():
    print(json.dumps({{'ok': False, 'path': str(path), 'error': 'file does not exist'}}, ensure_ascii=True))
    raise SystemExit(0)

old = base64.b64decode({_json_python_literal(old_b64)}).decode('utf-8')
new = base64.b64decode({_json_python_literal(new_b64)}).decode('utf-8')
text = path.read_text(encoding='utf-8', errors='replace')
count = text.count(old)
if count == 0:
    print(json.dumps({{'ok': False, 'path': str(path), 'replacements': 0, 'error': 'old_text not found'}}, ensure_ascii=True))
    raise SystemExit(0)

if {str(replace_all)}:
    updated = text.replace(old, new)
    replacements = count
else:
    updated = text.replace(old, new, 1)
    replacements = 1

path.write_text(updated, encoding='utf-8')
print(json.dumps({{
    'ok': True,
    'path': str(path),
    'replace_all': {str(replace_all)},
    'replacements': replacements,
}}, ensure_ascii=True))
""".strip()
    result = await _run_shell(environment, f"python3 - <<'PY'\n{script}\nPY")
    return _decode_shell_json_result(result)


_TOOL_HANDLERS: dict[str, ToolHandler] = {
    'exec': _environment_exec,
    'list_dir': _list_dir,
    'read_file': _read_file,
    'grep_text': _grep_text,
    'write_file': _write_file,
    'replace_in_file': _replace_in_file,
}


def _set_context_attr(context, name: str, value: Any) -> None:  # type: ignore[no-untyped-def]
    try:
        setattr(context, name, value)
    except Exception:  # noqa: BLE001
        pass
