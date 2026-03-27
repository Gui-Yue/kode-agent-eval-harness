#!/usr/bin/env python3
import argparse
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
CASE_STATUS_RE = re.compile(
    r"^(?P<name>.+?) \.\.\. (?P<status>ok|FAIL|ERROR|skipped|expected failure|unexpected success)$"
)
FAILURE_HEADER_RE = re.compile(r"^(?P<kind>FAIL|ERROR): (?P<name>.+)$")
UNITTEST_SEPARATOR_RE = re.compile(r"^-{10,}$")
RAN_RE = re.compile(r"^Ran (?P<count>\d+) tests? in (?P<seconds>[0-9.]+)s$")
FAILED_RE = re.compile(r"^FAILED \((?P<detail>.+)\)$")
OK_RE = re.compile(r"^OK(?: \((?P<detail>.+)\))?$")
PYTEST_CASE_RE = re.compile(
    r"^(?P<status>PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(?P<name>\S.+?)(?:\s+-\s+(?P<detail>.+))?$"
)
PYTEST_SESSION_RE = re.compile(r"^=+ test session starts =+$")
PYTEST_COLLECTED_RE = re.compile(r"^collected (?P<count>\d+) items")
PYTEST_SHORT_SUMMARY_RE = re.compile(r"^=+ short test summary info =+$")
PYTEST_FINAL_SUMMARY_RE = re.compile(
    r"^=+\s+(?P<detail>.+?)\s+in\s+(?P<seconds>[0-9.]+)s(?:\s+\([^)]+\))?\s+=+$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge per-shard Harbor benchmark results into one report."
    )
    parser.add_argument("--artifacts-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--summary-output", required=True, type=Path)
    parser.add_argument("--details-output", type=Path)
    parser.add_argument("--expected-shards", type=int, default=0)
    parser.add_argument("--expected-results", type=int, default=0)
    return parser.parse_args()


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\r", "")


def normalize_case_status(raw_status: str) -> str:
    mapping = {
        "ok": "passed",
        "FAIL": "failed",
        "ERROR": "error",
        "skipped": "skipped",
        "expected failure": "expected_failure",
        "unexpected success": "unexpected_success",
        "PASSED": "passed",
        "FAILED": "failed",
        "SKIPPED": "skipped",
        "XFAIL": "expected_failure",
        "XPASS": "unexpected_success",
    }
    return mapping.get(raw_status, "unknown")


def parse_parenthetical_counts(text: str | None) -> dict[str, int]:
    if not text:
        return {}

    counts: dict[str, int] = {}
    for part in text.split(","):
        piece = part.strip()
        if "=" not in piece:
            continue
        key, raw_value = piece.split("=", 1)
        key = key.strip().replace(" ", "_")
        try:
            counts[key] = int(raw_value.strip())
        except ValueError:
            continue
    return counts


def parse_pytest_counts(text: str | None) -> dict[str, int]:
    if not text:
        return {}

    counts: dict[str, int] = {}
    mapping = {
        "passed": "passed",
        "failed": "failed",
        "error": "errors",
        "errors": "errors",
        "skipped": "skipped",
        "xfailed": "expected_failures",
        "xpassed": "unexpected_successes",
        "deselected": "deselected",
    }
    for part in text.split(","):
        match = re.search(r"(?P<count>\d+)\s+(?P<label>[A-Za-z]+)", part.strip())
        if not match:
            continue
        label = match.group("label").lower()
        key = mapping.get(label)
        if not key:
            continue
        counts[key] = int(match.group("count"))
    return counts


def parse_test_log(log_path: Path) -> dict | None:
    if not log_path.exists():
        return None

    lines = [
        strip_ansi(line).rstrip()
        for line in log_path.read_text(errors="ignore").splitlines()
    ]
    cases: list[dict] = []
    failures: list[dict] = []
    ran_count: int | None = None
    duration_seconds: float | None = None
    outcome = "unknown"
    outcome_counts: dict[str, int] = {}
    collected_count: int | None = None
    seen_case_names: set[str] = set()
    seen_failure_keys: set[tuple[str, str]] = set()
    seen_unittest_signal = False
    seen_pytest_signal = False
    in_pytest_short_summary = False

    def add_case(name: str, raw_status: str) -> None:
        if name in seen_case_names:
            return
        seen_case_names.add(name)
        cases.append(
            {
                "name": name,
                "status": normalize_case_status(raw_status),
                "raw_status": raw_status,
            }
        )

    def add_failure(name: str, raw_status: str, details: str | None = None) -> None:
        key = (name, raw_status)
        if key in seen_failure_keys:
            return
        seen_failure_keys.add(key)
        failures.append(
            {
                "name": name,
                "status": "failed" if raw_status in {"FAIL", "FAILED"} else "error",
                "raw_status": raw_status,
                "details": details or None,
            }
        )

    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line:
            index += 1
            continue

        if PYTEST_SESSION_RE.match(line):
            seen_pytest_signal = True
            index += 1
            continue

        collected_match = PYTEST_COLLECTED_RE.match(line)
        if collected_match:
            seen_pytest_signal = True
            collected_count = int(collected_match.group("count"))
            index += 1
            continue

        if PYTEST_SHORT_SUMMARY_RE.match(line):
            seen_pytest_signal = True
            in_pytest_short_summary = True
            index += 1
            continue

        pytest_summary_match = PYTEST_FINAL_SUMMARY_RE.match(line)
        if seen_pytest_signal and pytest_summary_match:
            duration_seconds = float(pytest_summary_match.group("seconds"))
            outcome_counts = parse_pytest_counts(pytest_summary_match.group("detail"))
            if outcome_counts.get("failed", 0) or outcome_counts.get("errors", 0):
                outcome = "failed"
            elif outcome_counts.get("passed", 0):
                outcome = "passed"
            if collected_count is None:
                collected_count = sum(
                    outcome_counts.get(key, 0)
                    for key in (
                        "passed",
                        "failed",
                        "errors",
                        "skipped",
                        "expected_failures",
                        "unexpected_successes",
                    )
                )
            if collected_count:
                ran_count = collected_count
            in_pytest_short_summary = False
            index += 1
            continue

        pytest_case_match = PYTEST_CASE_RE.match(line)
        if pytest_case_match:
            seen_pytest_signal = True
            raw_status = pytest_case_match.group("status")
            name = pytest_case_match.group("name")
            if not in_pytest_short_summary:
                add_case(name, raw_status)
            if raw_status in {"FAILED", "ERROR"}:
                add_failure(name, raw_status, pytest_case_match.group("detail"))
            index += 1
            continue

        case_match = CASE_STATUS_RE.match(line)
        if case_match:
            seen_unittest_signal = True
            raw_status = case_match.group("status")
            add_case(case_match.group("name"), raw_status)
            index += 1
            continue

        if UNITTEST_SEPARATOR_RE.match(line):
            seen_unittest_signal = True
            index += 1
            continue

        failure_match = FAILURE_HEADER_RE.match(line)
        if failure_match and seen_unittest_signal:
            failure_lines: list[str] = []
            lookahead = index + 1
            while lookahead < len(lines):
                candidate = lines[lookahead].strip()
                if (
                    not candidate
                    or CASE_STATUS_RE.match(candidate)
                    or FAILURE_HEADER_RE.match(candidate)
                    or RAN_RE.match(candidate)
                    or FAILED_RE.match(candidate)
                    or OK_RE.match(candidate)
                ):
                    break
                failure_lines.append(candidate)
                lookahead += 1
            add_failure(
                failure_match.group("name"),
                failure_match.group("kind"),
                "\n".join(failure_lines) if failure_lines else None,
            )
            index = lookahead
            continue

        ran_match = RAN_RE.match(line)
        if ran_match:
            seen_unittest_signal = True
            ran_count = int(ran_match.group("count"))
            duration_seconds = float(ran_match.group("seconds"))
            index += 1
            continue

        failed_match = FAILED_RE.match(line)
        if failed_match and seen_unittest_signal:
            outcome = "failed"
            outcome_counts = parse_parenthetical_counts(failed_match.group("detail"))
            index += 1
            continue

        ok_match = OK_RE.match(line)
        if ok_match and seen_unittest_signal:
            outcome = "passed"
            outcome_counts = parse_parenthetical_counts(ok_match.group("detail"))
            index += 1
            continue

        index += 1

    return {
        "outcome": outcome,
        "counts": outcome_counts,
        "duration_seconds": duration_seconds,
        "ran_count": ran_count,
        "cases": cases,
        "failures": failures,
    }


def find_job_results(artifacts_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in artifacts_dir.rglob("result.json")
        if path.parent.is_dir()
        and (path.parent / "config.json").exists()
        and not (path.parent / "agent").is_dir()
    )


def find_trial_results(artifacts_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in artifacts_dir.rglob("result.json")
        if path.parent.is_dir()
        and (path.parent / "agent").is_dir()
        and (path.parent / "verifier").is_dir()
    )


def pass_at_k(results: list[dict]) -> dict[int, float]:
    if not results:
        return {}

    task_counts: dict[str, list[int]] = defaultdict(list)
    for result in results:
        task_counts[result["task_name"]].append(1 if result.get("is_resolved") else 0)

    min_attempts = min(len(counts) for counts in task_counts.values())
    if min_attempts < 2:
        return {}

    k_values = sorted({2**i for i in range(1, int(math.log2(min_attempts)) + 1)})
    if min_attempts >= 5:
        k_values.append(5)
    if min_attempts >= 10:
        k_values.append(10)

    def estimator(n: int, c: int, k: int) -> float:
        if n - c < k:
            return 1.0
        product = 1.0
        for value in range(n - c + 1, n + 1):
            product *= 1.0 - (k / value)
        return 1.0 - product

    metrics: dict[int, float] = {}
    for k in k_values:
        values: list[float] = []
        for counts in task_counts.values():
            if len(counts) < k:
                continue
            values.append(estimator(len(counts), sum(counts), k))
        if values:
            metrics[k] = statistics.fmean(values)

    return metrics


def classify_agent_issue(agent_result: dict | None) -> str | None:
    if not agent_result:
        return None

    monitor_errors = agent_result.get("monitor_errors") or []
    messages = "\n".join(error.get("message", "") for error in monitor_errors)
    if "429" in messages or "速率限制" in messages:
        return "provider_rate_limit"
    if "1214" in messages or "messages 参数非法" in messages:
        return "provider_request_error"
    if monitor_errors:
        return "provider_or_agent_error"
    if agent_result.get("status") == "error":
        return "agent_runtime_error"
    return None


def parse_agent_result(agent_result_path: Path) -> dict | None:
    if not agent_result_path.exists():
        return None

    payload = json.loads(agent_result_path.read_text(errors="ignore"))
    monitor_errors = payload.get("monitorErrors") or []
    agent_result = {
        "ok": payload.get("ok"),
        "status": payload.get("status"),
        "error": payload.get("error"),
        "monitor_errors": monitor_errors,
        "model_name": payload.get("modelName"),
        "rounds": payload.get("rounds"),
        "elapsed_ms": payload.get("elapsedMs"),
        "git_diff_name_only": payload.get("gitDiffNameOnly") or [],
    }
    agent_result["issue_type"] = classify_agent_issue(agent_result)
    return agent_result


def parse_verifier_report(report_path: Path) -> dict | None:
    if not report_path.exists():
        return None

    payload = json.loads(report_path.read_text(errors="ignore"))
    if not isinstance(payload, dict) or not payload:
        return None

    _, task_report = next(iter(payload.items()))
    if not isinstance(task_report, dict):
        return None

    tests_status = task_report.get("tests_status") or {}

    def bucket(name: str) -> dict[str, list[str]]:
        raw_bucket = tests_status.get(name) or {}
        success = raw_bucket.get("success") or []
        failure = raw_bucket.get("failure") or []
        return {
            "success": [str(item) for item in success],
            "failure": [str(item) for item in failure],
        }

    fail_to_pass = bucket("FAIL_TO_PASS")
    pass_to_pass = bucket("PASS_TO_PASS")
    fail_to_fail = bucket("FAIL_TO_FAIL")
    pass_to_fail = bucket("PASS_TO_FAIL")

    return {
        "resolved": bool(task_report.get("resolved")),
        "patch_exists": bool(task_report.get("patch_exists")),
        "patch_successfully_applied": bool(
            task_report.get("patch_successfully_applied")
        ),
        "fail_to_pass": fail_to_pass,
        "pass_to_pass": pass_to_pass,
        "fail_to_fail": fail_to_fail,
        "pass_to_fail": pass_to_fail,
        "target_failures": fail_to_pass["failure"],
        "target_successes": fail_to_pass["success"],
        "regressions": pass_to_fail["failure"],
        "regression_successes": pass_to_fail["success"],
    }


def load_trial_results(trial_result_paths: list[Path]) -> list[dict]:
    merged: list[dict] = []
    for result_path in trial_result_paths:
        trial_dir = result_path.parent
        trial_payload = json.loads(result_path.read_text())
        rewards = (
            (trial_payload.get("verifier_result") or {}).get("rewards") or {}
        )
        reward_values = [
            float(value)
            for value in rewards.values()
            if isinstance(value, (int, float))
        ]
        is_resolved = bool(reward_values) and all(
            value >= 1.0 - 1e-9 for value in reward_values
        )
        test_log = parse_test_log(trial_dir / "verifier" / "test-stdout.txt")
        agent_result = parse_agent_result(trial_dir / "agent" / "kode-result.json")
        verifier_report = parse_verifier_report(trial_dir / "verifier" / "report.json")
        raw_failed_tests = [
            failure["name"] for failure in (test_log or {}).get("failures", [])
        ]
        classified_failures = set()
        if verifier_report:
            classified_failures.update(verifier_report.get("target_failures") or [])
            classified_failures.update(verifier_report.get("regressions") or [])
        additional_failed_tests = [
            name for name in raw_failed_tests if name not in classified_failures
        ]

        merged.append(
            {
                "task_name": trial_payload.get("task_name"),
                "trial_name": trial_payload.get("trial_name"),
                "source": trial_payload.get("source"),
                "is_resolved": is_resolved,
                "rewards": rewards,
                "exception_info": trial_payload.get("exception_info"),
                "agent_result": agent_result,
                "verifier_report": verifier_report,
                "additional_failed_tests": additional_failed_tests,
                "test_log": test_log,
                "trial_result_path": str(result_path),
                "agent_result_path": str(trial_dir / "agent" / "kode-result.json"),
                "test_stdout_path": str(trial_dir / "verifier" / "test-stdout.txt"),
                "test_stderr_path": str(trial_dir / "verifier" / "test-stderr.txt"),
            }
        )
    return merged


def format_summary(
    merged_results: list[dict],
    pass_metrics: dict[int, float],
    expected_shards: int,
    actual_shards: int,
    expected_results: int,
    actual_results: int,
) -> str:
    resolved = sum(1 for item in merged_results if item["is_resolved"])
    unresolved = actual_results - resolved
    accuracy = (resolved / actual_results) if actual_results else 0.0
    unresolved_results = [item for item in merged_results if not item["is_resolved"]]
    test_detail_coverage = sum(1 for item in merged_results if item.get("test_log"))
    reward_coverage = sum(1 for item in merged_results if item.get("rewards"))
    verifier_report_coverage = sum(
        1 for item in merged_results if item.get("verifier_report")
    )
    tasks_with_target_failures = [
        item["task_name"]
        for item in unresolved_results
        if (item.get("verifier_report") or {}).get("target_failures")
    ]
    tasks_with_regressions = [
        item["task_name"]
        for item in unresolved_results
        if (item.get("verifier_report") or {}).get("regressions")
    ]
    tasks_with_additional_failures = [
        item["task_name"]
        for item in unresolved_results
        if item.get("additional_failed_tests")
    ]
    raw_log_conflicts = [
        item["task_name"]
        for item in merged_results
        if item.get("test_log")
        and item["test_log"].get("outcome") != "unknown"
        and ((item["is_resolved"] and item["test_log"]["outcome"] != "passed")
             or (not item["is_resolved"] and item["test_log"]["outcome"] == "passed"))
    ]

    failure_modes: dict[str, int] = defaultdict(int)
    for item in unresolved_results:
        agent_issue = (item.get("agent_result") or {}).get("issue_type")
        if agent_issue:
            failure_modes[agent_issue] += 1
            continue
        if item.get("exception_info"):
            failure_modes[item["exception_info"].get("exception_type", "exception")] += 1
            continue
        verifier_report = item.get("verifier_report") or {}
        target_failures = verifier_report.get("target_failures") or []
        regressions = verifier_report.get("regressions") or []
        additional_failed_tests = item.get("additional_failed_tests") or []
        if target_failures and regressions:
            failure_modes["target_failure_with_regression"] += 1
            continue
        if target_failures and additional_failed_tests:
            failure_modes["target_failure_with_additional_failures"] += 1
            continue
        if target_failures:
            failure_modes["target_failure"] += 1
            continue
        if regressions:
            failure_modes["regression"] += 1
            continue
        if additional_failed_tests:
            failure_modes["additional_failed_tests"] += 1
            continue
        if not item["is_resolved"]:
            failure_modes["unset"] += 1

    lines = [
        "# Harbor Benchmark Summary",
        "",
        f"- Results merged: `{actual_results}`",
        f"- Resolved: `{resolved}`",
        f"- Unresolved: `{unresolved}`",
        f"- Accuracy: `{accuracy:.1%}`",
        f"- Test detail coverage: `{test_detail_coverage}/{actual_results}`",
        f"- Reward coverage: `{reward_coverage}/{actual_results}`",
        f"- Verifier report coverage: `{verifier_report_coverage}/{actual_results}`",
    ]
    if expected_results:
        lines.append(f"- Expected results: `{expected_results}`")
    if expected_shards:
        lines.append(f"- Shards found: `{actual_shards}/{expected_shards}`")
    if tasks_with_target_failures:
        lines.append(
            f"- Tasks with target failures: `{len(set(tasks_with_target_failures))}`"
        )
    if tasks_with_regressions:
        lines.append(
            f"- Tasks with regressions: `{len(set(tasks_with_regressions))}`"
        )
    if tasks_with_additional_failures:
        lines.append(
            f"- Tasks with additional failed tests: `{len(set(tasks_with_additional_failures))}`"
        )
    if raw_log_conflicts:
        lines.append(
            f"- Raw log conflicts: `{', '.join(sorted(set(raw_log_conflicts)))}`"
        )
    if failure_modes:
        lines.append(
            "- Failure Modes: "
            + ", ".join(
                f"{name}={count}" for name, count in sorted(failure_modes.items())
            )
        )
    if pass_metrics:
        lines.append("")
        lines.append("## pass@k")
        lines.extend(f"- pass@{k}: `{value:.3f}`" for k, value in sorted(pass_metrics.items()))

    lines.append("")
    lines.append("## Task Results")
    lines.append("| Task | Status | Main Signal |")
    lines.append("| --- | --- | --- |")
    for item in merged_results:
        status = "resolved" if item["is_resolved"] else "unresolved"
        verifier_report = item.get("verifier_report") or {}
        target_failures = verifier_report.get("target_failures") or []
        regressions = verifier_report.get("regressions") or []
        additional_failed_tests = item.get("additional_failed_tests") or []
        exception_info = item.get("exception_info") or {}
        agent_issue = (item.get("agent_result") or {}).get("issue_type")

        if item["is_resolved"]:
            signal = "passed"
        elif exception_info.get("exception_type"):
            signal = exception_info["exception_type"]
        elif agent_issue:
            signal = agent_issue
        elif target_failures:
            signal = f"target failures: {len(target_failures)}"
        elif regressions:
            signal = f"regressions: {len(regressions)}"
        elif additional_failed_tests:
            signal = f"additional failed tests: {len(additional_failed_tests)}"
        else:
            signal = "unresolved"

        signal = signal.replace("\n", " ").replace("|", "\\|")
        lines.append(f"| `{item['task_name']}` | `{status}` | {signal} |")

    if unresolved_results:
        lines.append("")
        lines.append("## Unresolved Tasks")
        for item in unresolved_results:
            verifier_report = item.get("verifier_report") or {}
            target_failures = verifier_report.get("target_failures") or []
            regressions = verifier_report.get("regressions") or []
            additional_failed_tests = item.get("additional_failed_tests") or []
            lines.append(f"- `{item['task_name']}`")
            if item.get("exception_info"):
                lines.append(
                    f"  exception: {item['exception_info'].get('exception_type')}: "
                    f"{item['exception_info'].get('exception_message')}"
                )
            agent_result = item.get("agent_result") or {}
            if agent_result.get("error"):
                lines.append(f"  agent: {agent_result['error']}")
            if target_failures:
                lines.append(
                    "  target failures: "
                    + ", ".join(target_failures[:8])
                )
            if regressions:
                lines.append(
                    "  regressions: "
                    + ", ".join(regressions[:8])
                )
            if additional_failed_tests:
                lines.append(
                    "  additional failed tests: "
                    + ", ".join(additional_failed_tests[:8])
                )
            elif not target_failures and item.get("test_log", {}).get("failures"):
                failure_names = ", ".join(
                    failure["name"] for failure in item["test_log"]["failures"][:8]
                )
                lines.append(f"  failed tests: {failure_names}")

    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    job_results = find_job_results(args.artifacts_dir)
    trial_results = find_trial_results(args.artifacts_dir)
    merged_results = load_trial_results(trial_results)
    pass_metrics = pass_at_k(merged_results)

    payload = {
        "job_results": [str(path) for path in job_results],
        "trial_results": merged_results,
        "pass_at_k": pass_metrics,
        "expected_shards": args.expected_shards,
        "actual_shards": len(job_results),
        "expected_results": args.expected_results,
        "actual_results": len(merged_results),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2))

    summary = format_summary(
        merged_results=merged_results,
        pass_metrics=pass_metrics,
        expected_shards=args.expected_shards,
        actual_shards=len(job_results),
        expected_results=args.expected_results,
        actual_results=len(merged_results),
    )
    args.summary_output.parent.mkdir(parents=True, exist_ok=True)
    args.summary_output.write_text(summary)

    if args.details_output:
        args.details_output.parent.mkdir(parents=True, exist_ok=True)
        args.details_output.write_text(json.dumps(merged_results, indent=2))

    if args.expected_shards and len(job_results) != args.expected_shards:
        raise SystemExit(
            f"Expected {args.expected_shards} Harbor shard results, found {len(job_results)}."
        )
    if args.expected_results and len(merged_results) != args.expected_results:
        raise SystemExit(
            f"Expected {args.expected_results} Harbor trial results, found {len(merged_results)}."
        )


if __name__ == "__main__":
    main()
