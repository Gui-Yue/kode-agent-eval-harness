#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TAU_REF="${TAU_REF:-main}"
TAU_GIT_URL="${TAU_GIT_URL:-https://github.com/sierra-research/tau-bench.git}"
TAU_DIR="${TAU_DIR:-${RUNNER_TEMP:-$REPO_ROOT/.tmp}/tau-bench}"

if [[ ! -d "$TAU_DIR/.git" ]]; then
  rm -rf "$TAU_DIR"
  git clone --depth 1 --branch "$TAU_REF" "$TAU_GIT_URL" "$TAU_DIR" >/dev/null 2>&1
fi

printf '%s\n' "$TAU_DIR"
