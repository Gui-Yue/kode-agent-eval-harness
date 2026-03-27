#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

MODEL_NAME="${MODEL_NAME:-${1:-}}"
if [[ -z "${MODEL_NAME}" ]]; then
  echo "MODEL_NAME is required, in provider/model-id format" >&2
  exit 1
fi

DATASET_NAME="${DATASET_NAME:-swebench-verified}"
DATASET_VERSION="${DATASET_VERSION:-1.0}"
HARBOR_REF="${HARBOR_REF:-main}"
HARBOR_GIT_URL="${HARBOR_GIT_URL:-https://github.com/harbor-framework/harbor.git}"
HARBOR_DIR="${HARBOR_DIR:-${RUNNER_TEMP:-$REPO_ROOT/.tmp}/harbor}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/benchmark-runs/harbor}"
RUN_ID="${RUN_ID:-${DATASET_NAME//[^a-zA-Z0-9_-]/-}-$(date +%Y%m%d-%H%M%S)}"
N_CONCURRENT="${N_CONCURRENT:-1}"
N_ATTEMPTS="${N_ATTEMPTS:-1}"
N_TASKS="${N_TASKS:-1}"
TASK_NAMES="${TASK_NAMES:-}"
TIMEOUT_MULTIPLIER="${TIMEOUT_MULTIPLIER:-1.0}"
HARBOR_MAX_RETRIES="${HARBOR_MAX_RETRIES:-0}"
HARBOR_RETRY_INCLUDE="${HARBOR_RETRY_INCLUDE:-}"
HARBOR_RETRY_EXCLUDE="${HARBOR_RETRY_EXCLUDE:-}"
BUNDLE_PATH="${BUNDLE_PATH:-$REPO_ROOT/.bench/kode-harbor-runner.cjs}"
AGENT_IMPORT_PATH="kode_bench.harbor.kode_harbor_agent:KodeHarborAgent"
AGENT_NODE_VERSION="${AGENT_NODE_VERSION:-20.19.0}"

if ! command -v harbor >/dev/null 2>&1; then
  echo "harbor CLI is required to run Harbor benchmarks." >&2
  exit 1
fi

HARBOR_DIR="$(HARBOR_DIR="$HARBOR_DIR" HARBOR_REF="$HARBOR_REF" HARBOR_GIT_URL="$HARBOR_GIT_URL" bash "$REPO_ROOT/scripts/bench/setup-harbor.sh")"

mkdir -p "$OUTPUT_DIR"

pushd "$REPO_ROOT" >/dev/null
npm run bench:bundle:harbor
popd >/dev/null

DATASET_SPEC="$DATASET_NAME"
if [[ -n "$DATASET_VERSION" ]]; then
  DATASET_SPEC="${DATASET_NAME}@${DATASET_VERSION}"
fi

CMD=(
  harbor jobs start
  --dataset "$DATASET_SPEC"
  --registry-path "$HARBOR_DIR/registry.json"
  --agent-import-path "$AGENT_IMPORT_PATH"
  --model "$MODEL_NAME"
  --job-name "$RUN_ID"
  --jobs-dir "$OUTPUT_DIR"
  --n-concurrent "$N_CONCURRENT"
  --n-attempts "$N_ATTEMPTS"
  --timeout-multiplier "$TIMEOUT_MULTIPLIER"
  --max-retries "$HARBOR_MAX_RETRIES"
  --agent-kwarg "bundle_path=$BUNDLE_PATH"
  --agent-kwarg "node_version=$AGENT_NODE_VERSION"
  --yes
  --quiet
)

if [[ -n "$TASK_NAMES" ]]; then
  IFS=',' read -r -a TASK_ARRAY <<< "$TASK_NAMES"
  for task_name in "${TASK_ARRAY[@]}"; do
    trimmed="${task_name// /}"
    if [[ -n "$trimmed" ]]; then
      CMD+=(--task-name "$trimmed")
    fi
  done
else
  CMD+=(--n-tasks "$N_TASKS")
fi

if [[ -n "$HARBOR_RETRY_INCLUDE" ]]; then
  IFS=',' read -r -a RETRY_INCLUDE_ARRAY <<< "$HARBOR_RETRY_INCLUDE"
  for exception_type in "${RETRY_INCLUDE_ARRAY[@]}"; do
    trimmed="${exception_type// /}"
    if [[ -n "$trimmed" ]]; then
      CMD+=(--retry-include "$trimmed")
    fi
  done
fi

if [[ -n "$HARBOR_RETRY_EXCLUDE" ]]; then
  IFS=',' read -r -a RETRY_EXCLUDE_ARRAY <<< "$HARBOR_RETRY_EXCLUDE"
  for exception_type in "${RETRY_EXCLUDE_ARRAY[@]}"; do
    trimmed="${exception_type// /}"
    if [[ -n "$trimmed" ]]; then
      CMD+=(--retry-exclude "$trimmed")
    fi
  done
fi

export PYTHONPATH="$REPO_ROOT${PYTHONPATH:+:$PYTHONPATH}"
export KODE_HARBOR_BUNDLE_PATH="$BUNDLE_PATH"

printf 'Running Harbor benchmark %s with model %s\n' "$DATASET_SPEC" "$MODEL_NAME"
printf 'Run output: %s/%s\n' "$OUTPUT_DIR" "$RUN_ID"
"${CMD[@]}"
