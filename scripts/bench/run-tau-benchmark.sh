#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

MODEL_NAME="${MODEL_NAME:-${1:-}}"
if [[ -z "${MODEL_NAME}" ]]; then
  echo "MODEL_NAME is required, in provider/model-id format" >&2
  exit 1
fi

TAU_ENV="${TAU_ENV:-retail}"
TAU_TASK_SPLIT="${TAU_TASK_SPLIT:-test}"
TAU_USER_MODEL="${TAU_USER_MODEL:-${OPENAI_MODEL_ID:-${EVAL_MODEL:-gpt-4o}}}"
TAU_USER_MODEL_PROVIDER="${TAU_USER_MODEL_PROVIDER:-openai}"
TAU_USER_STRATEGY="${TAU_USER_STRATEGY:-llm}"
TAU_NUM_TRIALS="${TAU_NUM_TRIALS:-1}"
TAU_MAX_CONCURRENCY="${TAU_MAX_CONCURRENCY:-1}"
TAU_START_INDEX="${TAU_START_INDEX:-0}"
TAU_END_INDEX="${TAU_END_INDEX:--1}"
TAU_TASK_IDS="${TAU_TASK_IDS:-}"
TAU_SEED="${TAU_SEED:-10}"
TAU_SHUFFLE="${TAU_SHUFFLE:-0}"
TAU_TEMPERATURE="${TAU_TEMPERATURE:-0.0}"
TAU_REF="${TAU_REF:-main}"
TAU_RETRY_ATTEMPTS="${TAU_RETRY_ATTEMPTS:-6}"
TAU_RETRY_INITIAL_DELAY="${TAU_RETRY_INITIAL_DELAY:-5}"
TAU_RETRY_MAX_DELAY="${TAU_RETRY_MAX_DELAY:-60}"
TAU_RETRY_BACKOFF="${TAU_RETRY_BACKOFF:-2}"
TAU_GIT_URL="${TAU_GIT_URL:-https://github.com/sierra-research/tau-bench.git}"
TAU_DIR="${TAU_DIR:-${RUNNER_TEMP:-$REPO_ROOT/.tmp}/tau-bench}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/benchmark-runs/tau}"
STEP_RUNNER_PATH="${STEP_RUNNER_PATH:-$REPO_ROOT/.bench/kode-tau-step-runner.cjs}"

TAU_DIR="$(TAU_DIR="$TAU_DIR" TAU_REF="$TAU_REF" TAU_GIT_URL="$TAU_GIT_URL" bash "$REPO_ROOT/scripts/bench/setup-tau-bench.sh")"

mkdir -p "$OUTPUT_DIR"

pushd "$REPO_ROOT" >/dev/null
npm run bench:bundle:tau
popd >/dev/null

python -m pip install \
  "openai>=1.13.3" \
  "mistralai>=0.4.0" \
  "anthropic>=0.26.1" \
  "google-generativeai>=0.5.4" \
  "tenacity>=8.3.0" \
  "termcolor>=2.4.0" \
  "numpy>=1.26.4" \
  "litellm==1.82.6"
python -m pip install --no-deps -e "$TAU_DIR"

export PYTHONPATH="$REPO_ROOT:$TAU_DIR${PYTHONPATH:+:$PYTHONPATH}"
export KODE_TAU_STEP_RUNNER_PATH="$STEP_RUNNER_PATH"

CMD=(
  python3 "$REPO_ROOT/scripts/bench/run_tau_adapter.py"
  --model-name "$MODEL_NAME"
  --env "$TAU_ENV"
  --user-model "$TAU_USER_MODEL"
  --user-model-provider "$TAU_USER_MODEL_PROVIDER"
  --user-strategy "$TAU_USER_STRATEGY"
  --task-split "$TAU_TASK_SPLIT"
  --num-trials "$TAU_NUM_TRIALS"
  --max-concurrency "$TAU_MAX_CONCURRENCY"
  --start-index "$TAU_START_INDEX"
  --end-index "$TAU_END_INDEX"
  --seed "$TAU_SEED"
  --shuffle "$TAU_SHUFFLE"
  --temperature "$TAU_TEMPERATURE"
  --retry-attempts "$TAU_RETRY_ATTEMPTS"
  --retry-initial-delay "$TAU_RETRY_INITIAL_DELAY"
  --retry-max-delay "$TAU_RETRY_MAX_DELAY"
  --retry-backoff "$TAU_RETRY_BACKOFF"
  --log-dir "$OUTPUT_DIR"
  --step-runner-path "$STEP_RUNNER_PATH"
)

if [[ -n "$TAU_TASK_IDS" ]]; then
  IFS=',' read -r -a TASK_ID_ARRAY <<< "$TAU_TASK_IDS"
  CMD+=(--task-ids)
  for task_id in "${TASK_ID_ARRAY[@]}"; do
    trimmed="${task_id// /}"
    if [[ -n "$trimmed" ]]; then
      CMD+=("$trimmed")
    fi
  done
fi

printf 'Running Tau benchmark %s/%s with model %s\n' "$TAU_ENV" "$TAU_TASK_SPLIT" "$MODEL_NAME"
"${CMD[@]}"
