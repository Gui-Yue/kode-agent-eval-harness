#!/usr/bin/env python3
import argparse
import fnmatch
import json
import math
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Resolve a Harbor dataset into deterministic task shards."
    )
    parser.add_argument("--registry-path", required=True, type=Path)
    parser.add_argument("--dataset-name", required=True)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--shard-count", required=True, type=int)
    parser.add_argument("--task-names", default="")
    parser.add_argument("--exclude-task-names", default="")
    parser.add_argument("--task-limit", type=int, default=0)
    parser.add_argument("--matrix-output", required=True, type=Path)
    parser.add_argument("--manifest-output", required=True, type=Path)
    return parser.parse_args()


def parse_csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def load_registry_entry(
    registry_path: Path, dataset_name: str, dataset_version: str
) -> dict:
    registry = json.loads(registry_path.read_text())
    for row in registry:
        if row["name"] == dataset_name and row["version"] == dataset_version:
            return row
    raise SystemExit(
        f"Dataset {dataset_name}@{dataset_version} was not found in {registry_path}."
    )


def resolve_all_task_names(dataset: dict) -> list[str]:
    tasks = dataset.get("tasks") or []
    if not tasks:
        raise SystemExit(
            f"Dataset {dataset['name']}@{dataset['version']} did not declare any tasks."
        )
    task_names = [task["name"] for task in tasks if task.get("name")]
    if not task_names:
        raise SystemExit(
            f"Dataset {dataset['name']}@{dataset['version']} has tasks without names."
        )
    return sorted(task_names)


def filter_task_names(
    task_names: list[str], include_patterns: list[str], exclude_patterns: list[str]
) -> list[str]:
    selected = task_names

    if include_patterns:
        included: set[str] = set()
        for pattern in include_patterns:
            matches = [
                task_name
                for task_name in task_names
                if fnmatch.fnmatch(task_name, pattern)
            ]
            if not matches:
                raise SystemExit(f"No tasks matched include pattern: {pattern}")
            included.update(matches)
        selected = sorted(included)

    if exclude_patterns:
        excluded: set[str] = set()
        for pattern in exclude_patterns:
            matches = [
                task_name
                for task_name in selected
                if fnmatch.fnmatch(task_name, pattern)
            ]
            if not matches:
                raise SystemExit(f"No tasks matched exclude pattern: {pattern}")
            excluded.update(matches)
        selected = [task_name for task_name in selected if task_name not in excluded]

    if not selected:
        raise SystemExit("Task selection resolved to an empty set.")

    return selected


def build_shards(task_names: list[str], requested_shards: int) -> list[list[str]]:
    if requested_shards <= 0:
        raise SystemExit("--shard-count must be greater than 0.")

    actual_shards = min(requested_shards, len(task_names))
    chunk_size = math.ceil(len(task_names) / actual_shards)
    return [
        task_names[index : index + chunk_size]
        for index in range(0, len(task_names), chunk_size)
    ]


def apply_task_limit(task_names: list[str], task_limit: int) -> list[str]:
    if task_limit <= 0:
        return task_names
    if task_limit > len(task_names):
        return task_names
    return task_names[:task_limit]


def main() -> None:
    args = parse_args()
    dataset = load_registry_entry(
        args.registry_path, args.dataset_name, args.dataset_version
    )

    task_names = resolve_all_task_names(dataset)
    task_names = filter_task_names(
        task_names=task_names,
        include_patterns=parse_csv(args.task_names),
        exclude_patterns=parse_csv(args.exclude_task_names),
    )
    task_names = apply_task_limit(task_names, args.task_limit)

    shards = build_shards(task_names, args.shard_count)
    shard_count = len(shards)

    matrix = {
        "include": [
            {
                "shard_index": index,
                "shard_label": f"{index + 1:02d}-of-{shard_count:02d}",
                "task_count": len(shard_task_names),
                "task_names": ",".join(shard_task_names),
            }
            for index, shard_task_names in enumerate(shards)
        ]
    }

    manifest = {
        "dataset_name": args.dataset_name,
        "dataset_version": args.dataset_version,
        "task_count": len(task_names),
        "requested_shard_count": args.shard_count,
        "task_limit": args.task_limit,
        "shard_count": shard_count,
        "task_names": task_names,
        "shards": [
            {
                "shard_index": index,
                "shard_label": f"{index + 1:02d}-of-{shard_count:02d}",
                "task_count": len(shard_task_names),
                "task_names": shard_task_names,
            }
            for index, shard_task_names in enumerate(shards)
        ],
    }

    args.matrix_output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_output.parent.mkdir(parents=True, exist_ok=True)
    args.matrix_output.write_text(json.dumps(matrix, separators=(",", ":")))
    args.manifest_output.write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
