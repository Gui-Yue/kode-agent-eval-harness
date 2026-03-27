#!/usr/bin/env python3
import argparse
import json
import multiprocessing
import os
import random
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from math import comb
from pathlib import Path
from typing import Any, Callable, Dict, List, TypeVar

from kode_bench.tau.kode_tau_agent import KodeTauAgent
from tau_bench.envs import get_env
from tau_bench.envs.user import UserStrategy
from tau_bench.types import EnvRunResult

T = TypeVar("T")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-name", required=True)
    parser.add_argument(
        "--env", type=str, choices=["retail", "airline"], default="retail"
    )
    parser.add_argument("--user-model", type=str, default="gpt-4o")
    parser.add_argument("--user-model-provider", type=str, required=True)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument(
        "--task-split",
        type=str,
        default="test",
        choices=["train", "test", "dev"],
    )
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--end-index", type=int, default=-1)
    parser.add_argument("--task-ids", type=int, nargs="+")
    parser.add_argument("--log-dir", type=Path, default=Path("benchmark-runs/tau"))
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--seed", type=int, default=10)
    parser.add_argument("--shuffle", type=int, default=0)
    parser.add_argument(
        "--user-strategy",
        type=str,
        default="llm",
        choices=[item.value for item in UserStrategy],
    )
    parser.add_argument("--num-trials", type=int, default=1)
    parser.add_argument("--step-runner-path", type=Path, required=True)
    parser.add_argument("--retry-attempts", type=int, default=6)
    parser.add_argument("--retry-initial-delay", type=float, default=5.0)
    parser.add_argument("--retry-max-delay", type=float, default=60.0)
    parser.add_argument("--retry-backoff", type=float, default=2.0)
    return parser.parse_args()


def display_metrics(results: List[EnvRunResult]) -> Dict[str, Any]:
    def is_successful(reward: float) -> bool:
        return (1 - 1e-6) <= reward <= (1 + 1e-6)

    num_trials = len(set([r.trial for r in results]))
    rewards = [r.reward for r in results]
    avg_reward = sum(rewards) / len(rewards) if rewards else 0.0
    c_per_task_id: dict[int, int] = {}
    for result in results:
        if result.task_id not in c_per_task_id:
            c_per_task_id[result.task_id] = 1 if is_successful(result.reward) else 0
        else:
            c_per_task_id[result.task_id] += 1 if is_successful(result.reward) else 0
    pass_hat_ks: dict[int, float] = {}
    for k in range(1, num_trials + 1):
        sum_task_pass_hat_k = 0.0
        for c in c_per_task_id.values():
            sum_task_pass_hat_k += comb(c, k) / comb(num_trials, k)
        pass_hat_ks[k] = sum_task_pass_hat_k / len(c_per_task_id)
    return {
        "average_reward": avg_reward,
        "pass_hat": pass_hat_ks,
    }


def is_retryable_error(exc: Exception) -> bool:
    message = str(exc).lower()
    retry_markers = (
        "429",
        "rate limit",
        "ratelimit",
        "too many requests",
        "timeout",
        "temporarily unavailable",
        "connection reset",
        "service unavailable",
        "internal server error",
        "bad gateway",
        "gateway timeout",
        "apiconnectionerror",
        "apitimeouterror",
        "1302",
    )
    return any(marker in message for marker in retry_markers)


def retry_with_backoff(
    operation: Callable[[], T],
    *,
    label: str,
    attempts: int,
    initial_delay: float,
    max_delay: float,
    backoff: float,
) -> T:
    delay = max(initial_delay, 0.0)
    total_attempts = max(attempts, 1)
    for attempt in range(1, total_attempts + 1):
        try:
            return operation()
        except Exception as exc:
            if attempt >= total_attempts or not is_retryable_error(exc):
                raise
            print(
                f"[tau] retryable error during {label} "
                f"(attempt {attempt}/{total_attempts}): {exc}"
            )
            if delay > 0:
                print(f"[tau] sleeping {delay:.1f}s before retrying {label}")
                time.sleep(delay)
            delay = min(max_delay, delay * max(backoff, 1.0)) if delay else 0.0
    raise RuntimeError(f"Retry loop for {label} exited unexpectedly")


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    args.log_dir.mkdir(parents=True, exist_ok=True)
    env = retry_with_backoff(
        lambda: get_env(
            args.env,
            user_strategy=args.user_strategy,
            user_model=args.user_model,
            user_provider=args.user_model_provider,
            task_split=args.task_split,
        ),
        label="initialize tau environment",
        attempts=args.retry_attempts,
        initial_delay=args.retry_initial_delay,
        max_delay=args.retry_max_delay,
        backoff=args.retry_backoff,
    )

    if "/" not in args.model_name:
        raise ValueError("--model-name must be in provider/model format")
    model_provider, model_id = args.model_name.split("/", 1)
    agent = KodeTauAgent(
        tools_info=env.tools_info,
        wiki=env.wiki,
        model=model_id,
        provider=model_provider,
        temperature=args.temperature,
        step_runner_path=str(args.step_runner_path),
    )

    time_str = datetime.now().strftime("%m%d%H%M%S")
    output_path = (
        args.log_dir
        / f"kode-tau-{args.env}-{model_id.replace('/', '-')}-{time_str}.json"
    )

    end_index = len(env.tasks) if args.end_index == -1 else min(args.end_index, len(env.tasks))
    results: List[EnvRunResult] = []
    lock = multiprocessing.Lock()

    for trial_index in range(args.num_trials):
        if args.task_ids:
            idxs = list(args.task_ids)
        else:
            idxs = list(range(args.start_index, end_index))
        if args.shuffle:
            random.shuffle(idxs)

        def _run(idx: int) -> EnvRunResult:
            try:
                def _solve_once() -> EnvRunResult:
                    isolated_env = get_env(
                        args.env,
                        user_strategy=args.user_strategy,
                        user_model=args.user_model,
                        user_provider=args.user_model_provider,
                        task_split=args.task_split,
                        task_index=idx,
                    )
                    res = agent.solve(env=isolated_env, task_index=idx)
                    return EnvRunResult(
                        task_id=idx,
                        reward=res.reward,
                        info=res.info,
                        traj=res.messages,
                        trial=trial_index,
                    )

                result = retry_with_backoff(
                    _solve_once,
                    label=f"run tau task {idx}",
                    attempts=args.retry_attempts,
                    initial_delay=args.retry_initial_delay,
                    max_delay=args.retry_max_delay,
                    backoff=args.retry_backoff,
                )
            except Exception as exc:
                result = EnvRunResult(
                    task_id=idx,
                    reward=0.0,
                    info={"error": str(exc), "traceback": traceback.format_exc()},
                    traj=[],
                    trial=trial_index,
                )

            with lock:
                current: list[dict] = []
                if output_path.exists():
                    current = json.loads(output_path.read_text())
                output_path.write_text(
                    json.dumps(current + [result.model_dump()], indent=2),
                    encoding="utf-8",
                )
            return result

        with ThreadPoolExecutor(max_workers=args.max_concurrency) as executor:
            res = list(executor.map(_run, idxs))
            results.extend(res)

    metrics = display_metrics(results)
    payload = {
        "config": {
            "model_name": args.model_name,
            "env": args.env,
            "user_model": args.user_model,
            "user_model_provider": args.user_model_provider,
            "user_strategy": args.user_strategy,
            "task_split": args.task_split,
            "num_trials": args.num_trials,
        },
        "metrics": metrics,
        "results": [result.model_dump() for result in results],
    }
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
