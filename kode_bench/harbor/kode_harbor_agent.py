import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class KodeHarborAgent(BaseInstalledAgent):
    """Run the KODE benchmark runner inside a Harbor task environment."""

    _RESULT_FILENAME = "kode-result.json"
    _CONSOLE_FILENAME = "kode-console.log"

    def __init__(
        self,
        logs_dir: Path,
        bundle_path: str | None = None,
        node_version: str = "20.19.0",
        *args,
        **kwargs,
    ):
        super().__init__(logs_dir=logs_dir, *args, **kwargs)
        self._bundle_path = Path(
            bundle_path or os.environ.get("KODE_HARBOR_BUNDLE_PATH", "")
        ).expanduser()
        self._node_version = node_version
        self._install_script_path = (
            Path(__file__).parent.parent / "shared" / "install_node.sh"
        )

        if not self._bundle_path.exists():
            raise ValueError(
                "KODE Harbor runner bundle was not found. "
                f"Expected: {self._bundle_path}"
            )

        if not self._install_script_path.exists():
            raise ValueError(
                "Node install helper script was not found. "
                f"Expected: {self._install_script_path}"
            )

    @staticmethod
    def name() -> str:
        return "kode-sdk"

    def get_version_command(self) -> str | None:
        return "bash -lc 'source /installed-agent/runtime-path.sh && node --version'"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "if command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache bash curl python3 tar gzip >/dev/null 2>&1 || true; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update >/dev/null 2>&1 && "
                "  DEBIAN_FRONTEND=noninteractive apt-get install -y bash curl python3 tar gzip >/dev/null 2>&1 || true; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y bash curl python3 tar gzip >/dev/null 2>&1 || true; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        await environment.upload_file(
            source_path=self._install_script_path,
            target_path="/installed-agent/install_node.sh",
        )
        await environment.upload_file(
            source_path=self._bundle_path,
            target_path=f"/installed-agent/{self._bundle_path.name}",
        )
        await self.exec_as_root(
            environment,
            command=(
                "chmod +x "
                f"{shlex.quote('/installed-agent/install_node.sh')} "
                f"{shlex.quote(f'/installed-agent/{self._bundle_path.name}')}"
            ),
        )

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"export KODE_NODE_VERSION={shlex.quote(self._node_version)}; "
                "bash /installed-agent/install_node.sh"
            ),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        result_path = self.logs_dir / self._RESULT_FILENAME
        if not result_path.exists():
            self.logger.warning(f"No KODE result file found at {result_path}")
            return

        try:
            payload = json.loads(result_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            self.logger.error(f"Failed to parse KODE result file: {exc}")
            return

        metrics = payload.get("usage") or {}
        context.n_input_tokens = metrics.get("input_tokens")
        context.n_output_tokens = metrics.get("output_tokens")
        context.n_cache_tokens = metrics.get("cache_tokens")
        context.cost_usd = metrics.get("cost_usd")
        context.metadata = {
            key: value
            for key, value in {
                "ok": payload.get("ok"),
                "status": payload.get("status"),
                "elapsed_ms": payload.get("elapsedMs"),
                "rounds": payload.get("rounds"),
                "model_name": payload.get("modelName"),
                "git_status": payload.get("gitStatus"),
                "git_diff_stat": payload.get("gitDiffStat"),
                "git_diff_name_only": payload.get("gitDiffNameOnly"),
                "monitor_errors": payload.get("monitorErrors"),
                "error": payload.get("error"),
            }.items()
            if value is not None
        }

    def _build_container_env(self) -> dict[str, str]:
        env: dict[str, str] = {
            "KODE_BENCH_MODEL_NAME": self.model_name or "",
            "KODE_NODE_VERSION": self._node_version,
            "KODE_BENCH_OUTPUT_PATH": (
                f"{EnvironmentPaths.agent_dir.as_posix()}/{self._RESULT_FILENAME}"
            ),
        }

        passthrough_keys = (
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_PROXY_URL",
            "ANTHROPIC_EXTRA_HEADERS",
            "ANTHROPIC_EXTRA_BODY",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_PROXY_URL",
            "OPENAI_API",
            "OPENAI_EXTRA_HEADERS",
            "OPENAI_EXTRA_BODY",
            "GEMINI_API_KEY",
            "GEMINI_BASE_URL",
            "GEMINI_PROXY_URL",
            "GEMINI_EXTRA_HEADERS",
            "GEMINI_EXTRA_BODY",
            "MINIMAX_API_KEY",
            "MINIMAX_BASE_URL",
            "MINIMAX_PROXY_URL",
            "MINIMAX_EXTRA_HEADERS",
            "MINIMAX_EXTRA_BODY",
            "KODE_BENCH_RETRY_MAX_ATTEMPTS",
            "KODE_BENCH_RETRY_INITIAL_DELAY_MS",
            "KODE_BENCH_RETRY_MAX_DELAY_MS",
            "KODE_BENCH_RETRY_BACKOFF_MULTIPLIER",
            "KODE_BENCH_RETRY_JITTER_RATIO",
            "KODE_BENCH_STREAMING_MODE",
            "KODE_BENCH_MAX_ROUNDS",
        )
        for key in passthrough_keys:
            value = os.environ.get(key)
            if value:
                env[key] = value

        return env

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("KodeHarborAgent requires a model name.")

        runner_path = f"/installed-agent/{self._bundle_path.name}"
        output_path = (
            f"{EnvironmentPaths.agent_dir.as_posix()}/{self._RESULT_FILENAME}"
        )
        console_log = (
            f"{EnvironmentPaths.agent_dir.as_posix()}/{self._CONSOLE_FILENAME}"
        )

        command = "".join(
            [
                "set -euo pipefail; ",
                f"mkdir -p {shlex.quote(EnvironmentPaths.agent_dir.as_posix())}; ",
                "source /installed-agent/runtime-path.sh; ",
                f"node {shlex.quote(runner_path)} ",
                f"--instruction {shlex.quote(instruction)} ",
                f"--model-name {shlex.quote(self.model_name)} ",
                '--workdir "$(pwd)" ',
                f"--output {shlex.quote(output_path)} ",
                f"2>&1 | tee {shlex.quote(console_log)}",
            ]
        )

        await self.exec_as_agent(
            environment,
            command=f"bash -lc {shlex.quote(command)}",
            env=self._build_container_env(),
        )
