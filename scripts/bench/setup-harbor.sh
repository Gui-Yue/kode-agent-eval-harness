#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

HARBOR_REF="${HARBOR_REF:-main}"
HARBOR_GIT_URL="${HARBOR_GIT_URL:-https://github.com/harbor-framework/harbor.git}"
HARBOR_DIR="${HARBOR_DIR:-${RUNNER_TEMP:-$REPO_ROOT/.tmp}/harbor}"

if [[ ! -d "$HARBOR_DIR/.git" ]]; then
  rm -rf "$HARBOR_DIR"
  git clone --depth 1 --branch "$HARBOR_REF" "$HARBOR_GIT_URL" "$HARBOR_DIR" >/dev/null 2>&1
fi

printf '%s\n' "$HARBOR_DIR"
