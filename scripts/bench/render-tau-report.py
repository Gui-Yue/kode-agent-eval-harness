#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render a human-readable markdown report from a Tau benchmark JSON result."
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    config = payload.get("config") or {}
    metrics = payload.get("metrics") or {}
    results = payload.get("results") or []

    average_reward = metrics.get("average_reward")
    pass_hat = metrics.get("pass_hat") or {}
    passed = sum(1 for result in results if float(result.get("reward", 0.0)) >= 1.0 - 1e-9)
    total = len(results)

    lines = [
        "# Tau Benchmark Report",
        "",
        "## Run",
        "",
        f"- Model: `{config.get('model_name', '')}`",
        f"- Environment: `{config.get('env', '')}`",
        f"- Task split: `{config.get('task_split', '')}`",
        f"- User model: `{config.get('user_model', '')}`",
        f"- User provider: `{config.get('user_model_provider', '')}`",
        f"- User strategy: `{config.get('user_strategy', '')}`",
        f"- Trials: `{config.get('num_trials', '')}`",
        "",
        "## Metrics",
        "",
        f"- Tasks evaluated: `{total}`",
        f"- Passed: `{passed}`",
        f"- Average reward: `{average_reward}`",
    ]

    if pass_hat:
        lines.append("- pass_hat:")
        for key, value in sorted(pass_hat.items(), key=lambda item: int(item[0])):
            lines.append(f"  - k={key}: `{value}`")

    lines.extend(
        [
            "",
            "## Task Results",
            "",
            "| Task ID | Reward | Status | Main Signal |",
            "| --- | --- | --- | --- |",
        ]
    )

    unresolved = []
    for result in results:
        reward = float(result.get("reward", 0.0))
        status = "passed" if reward >= 1.0 - 1e-9 else "failed"
        info = result.get("info") or {}
        signal = "passed"
        if status == "failed":
            signal = info.get("error") or "reward < 1.0"
            signal = str(signal).replace("\n", " ").replace("|", "\\|")
            unresolved.append((result, signal))
        lines.append(
            f"| `{result.get('task_id')}` | `{reward}` | `{status}` | {signal} |"
        )

    if unresolved:
        lines.extend(["", "## Failed Tasks", ""])
        for result, signal in unresolved:
            lines.append(f"- `{result.get('task_id')}`: {signal}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
