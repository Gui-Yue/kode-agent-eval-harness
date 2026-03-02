"""Auto-load TAU2 plugin module when Python starts.

Enable by setting:
- PYTHONPATH=<plugin path>:...
- TAU2_AGENT_PLUGIN_MODULE=<module name>
- TAU2_AGENT_PLUGIN_NAME=<agent id to register>
"""

from __future__ import annotations

import importlib
import os
import random
import sys
import threading
import time
import traceback

_USER_THROTTLE_LOCK = threading.Lock()
_USER_LAST_TS = 0.0


def _log(msg: str) -> None:
    sys.stderr.write(f"[tau2-plugin-hook] {msg}\n")
    sys.stderr.flush()


def _run() -> None:
    module_name = (os.getenv("TAU2_AGENT_PLUGIN_MODULE") or "").strip()
    if not module_name:
        return

    plugin_name = (os.getenv("TAU2_AGENT_PLUGIN_NAME") or "").strip()
    _log(f"loading module={module_name} plugin_name={plugin_name or '(default)'}")

    try:
        mod = importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001
        _log(f"import failed: {exc}")
        _log(traceback.format_exc())
        return

    register = getattr(mod, "register", None)
    if not callable(register):
        _log("module has no register() function, skipped")
        return

    try:
        register(plugin_name or None)
        _log("register() completed")
    except Exception as exc:  # noqa: BLE001
        _log(f"register() failed: {exc}")
        _log(traceback.format_exc())


def _throttle_user_simulator_requests() -> None:
    interval_ms = int((os.getenv("TAU2_USER_MIN_REQUEST_INTERVAL_MS") or "0").strip() or "0")
    jitter_ms = int((os.getenv("TAU2_USER_REQUEST_JITTER_MS") or "0").strip() or "0")
    if interval_ms <= 0 and jitter_ms <= 0:
        return

    global _USER_LAST_TS
    with _USER_THROTTLE_LOCK:
        now = time.monotonic()
        interval_s = max(0.0, interval_ms / 1000.0)
        next_allowed = _USER_LAST_TS + interval_s
        if now < next_allowed:
            time.sleep(next_allowed - now)
            now = time.monotonic()

        if jitter_ms > 0:
            time.sleep(random.uniform(0.0, jitter_ms / 1000.0))
            now = time.monotonic()

        _USER_LAST_TS = now


def _is_user_rate_limit_error(exc: Exception) -> bool:
    s = str(exc).lower()
    return any(
        key in s
        for key in [
            "rate limit",
            "ratelimit",
            "429",
            "达到速率限制",
            "control request frequency",
        ]
    )


def _patch_user_simulator() -> None:
    try:
        mod = importlib.import_module("tau2.user.user_simulator")
    except Exception as exc:  # noqa: BLE001
        _log(f"user simulator patch skipped (import failed): {exc}")
        return

    cls = getattr(mod, "UserSimulator", None)
    if cls is None:
        _log("user simulator patch skipped (UserSimulator not found)")
        return
    if getattr(cls, "__kode_throttle_patched__", False):
        return

    original = getattr(cls, "generate_next_message", None)
    if not callable(original):
        _log("user simulator patch skipped (generate_next_message not callable)")
        return

    def wrapped(self, message, state):  # type: ignore[no-untyped-def]
        retries = max(0, int((os.getenv("TAU2_USER_RATE_LIMIT_RETRIES") or "0").strip() or "0"))
        base_backoff_ms = max(
            0,
            int((os.getenv("TAU2_USER_RATE_LIMIT_BACKOFF_MS") or "0").strip() or "0"),
        )

        for attempt in range(retries + 1):
            _throttle_user_simulator_requests()
            try:
                return original(self, message, state)
            except Exception as exc:  # noqa: BLE001
                if attempt >= retries or not _is_user_rate_limit_error(exc):
                    raise
                sleep_s = min(
                    120.0,
                    (base_backoff_ms / 1000.0) * (2 ** attempt)
                    + random.uniform(0.0, 1.5),
                )
                _log(
                    "user simulator rate-limit retry "
                    f"{attempt + 1}/{retries} sleep={sleep_s:.2f}s: {exc}"
                )
                time.sleep(sleep_s)

    setattr(cls, "generate_next_message", wrapped)
    setattr(cls, "__kode_throttle_patched__", True)
    _log(
        "user simulator throttle patched: "
        f"interval={os.getenv('TAU2_USER_MIN_REQUEST_INTERVAL_MS', '0')}ms "
        f"jitter={os.getenv('TAU2_USER_REQUEST_JITTER_MS', '0')}ms "
        f"retries={os.getenv('TAU2_USER_RATE_LIMIT_RETRIES', '0')} "
        f"backoff={os.getenv('TAU2_USER_RATE_LIMIT_BACKOFF_MS', '0')}ms"
    )


_run()
_patch_user_simulator()
