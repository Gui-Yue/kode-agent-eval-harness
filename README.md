# Kode Agent Eval Harness

A pluggable evaluation harness focused on **agent system capability** instead of model-only ranking.

## Quick Start

```bash
npm install
npm run build

# mock end-to-end
npm run run -- --benchmark=mock --agent=mock --out=reports/mock-run.json

# compliance L1 suite
npm run compliance -- --adapter=mock --suite=l1
```

## GitHub Workflows

Three official-eval workflows are provided:

- `.github/workflows/eval-swe.yml`
- `.github/workflows/eval-tau.yml`
- `.github/workflows/eval-tb2.yml`

Auto-run switches (Repository Variables):

- `RUN_EVAL_SWE=true|false`
- `RUN_EVAL_TAU=true|false`
- `RUN_EVAL_TB2=true|false`

Shared runtime variables:

- `EVAL_AGENT_CORE` (`kode-sdk` or `kode-agent`, used by SWE workflow)
- `EVAL_PROVIDER` (for TAU, default `openai`)
- `EVAL_MODEL` (default `openai/glm-5`)
- `OPENAI_BASE_URL` (if using OpenAI-compatible endpoints)
- `BENCHMARK_DOCKER_PROXY` (optional)

Benchmark-specific variables:

- SWE: `EVAL_SWE_MAX_INSTANCES`
- TAU: `EVAL_TAU_DOMAIN`, `EVAL_TAU_NUM_TRIALS`
- TB2: `EVAL_TB2_DATASET`, `EVAL_TB2_AGENT`, `EVAL_TB2_RUNNER`, `EVAL_TB2_PYTHON`, `EVAL_TB2_DOCKER_IMAGE`

Required secrets (set based on provider):

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

Note:

- SWE workflow uses pluggable adapter core (`EVAL_AGENT_CORE`).
- TAU/TB2 workflows execute official harness paths; they are controlled by provider/model and benchmark-specific vars.

## Real KODE Runtime Adapters

Two adapter names are available:

- `--agent=kode-agent`: load SDK from local/global installation
- `--agent=kode-sdk`: plugin mode, auto-install SDK at runtime and auto-clean after test

Recommended setup via `.env`:

```bash
cp .env.example .env
# then fill provider keys/base url in .env
```

The CLI auto-loads root `.env` on startup.

### Common env vars

- `BENCHMARK_PROVIDER` / `BENCHMARK_MODEL` (defaults when `--provider` / `--model` are not passed)
- `MODEL_ID` / `OPENAI_MODEL_ID` / `ANTHROPIC_MODEL_ID` / `GEMINI_MODEL_ID` (also used as model fallback)
- `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
- `GEMINI_API_KEY` / `GEMINI_BASE_URL`

### Smoke run

```bash
npm run run -- \
  --benchmark=mock \
  --agent=kode-sdk \
  --model=openai/glm-5 \
  --out=reports/mock-kode-sdk.json
```

### SWE prediction generation with real adapter

```bash
npm run run -- \
  --benchmark=swe \
  --agent=kode-sdk \
  --model=openai/glm-5 \
  --swe-generate-only=true \
  --swe-max-instances=2 \
  --out=reports/swe-kode-sdk-generate.json
```

## Run Commands

### 1) Mock benchmark (local contract smoke)

```bash
npm run run -- --benchmark=mock --agent=mock --out=reports/mock-run.json
```

### 2) SWE-bench-Verified: adapter prediction generation only (no docker eval)

```bash
npm run run -- \
  --benchmark=swe \
  --agent=mock \
  --swe-generate-only=true \
  --swe-max-instances=2 \
  --out=reports/swe-generate.json
```

This writes generated predictions to `tests/tmp/swe-predictions.generated.json` by default.

### 3) SWE-bench-Verified: auto-generate predictions + official docker scoring

```bash
npm run run -- \
  --benchmark=swe \
  --agent=mock \
  --swe-auto-generate=true \
  --swe-max-instances=2 \
  --out=reports/swe-run.json
```

Or provide a predictions file directly:

```bash
npm run run -- \
  --benchmark=swe \
  --swe-predictions-file=reports/swe-preds.json \
  --out=reports/swe-run.json
```

Prediction file formats supported:

- array format:

```json
[
  { "instance_id": "django__django-12700", "patch": "... unified diff ...", "tokens_used": 12345 }
]
```

- map format:

```json
{
  "django__django-12700": { "patch": "... unified diff ...", "tokens_used": 12345 }
}
```

### 4) Terminal Bench 2.0 official runner

```bash
npm run run -- \
  --benchmark=tb2 \
  --model=openai/glm-5 \
  --tb2-agent=oracle \
  --tb2-runner=uvx \
  --tb2-jobs-dir=tests/tmp/jobs \
  --out=reports/tb2-run.json
```

### 5) TAU2 official runner

```bash
npm run run -- \
  --benchmark=tau \
  --provider=openai \
  --model=glm-5 \
  --tau-domain=airline \
  --num-trials=1 \
  --tau-data-dir=tests/tmp/tau2-data \
  --out=reports/tau-run.json
```

## Compliance Commands

Single case:

```bash
npm run compliance -- --adapter=mock --case=compliance/cases/l1_03_step_schema_valid.json
```

Suite:

```bash
npm run compliance -- --adapter=mock --suite=l1
```

## Other Commands

- `compare`: compare two unified reports.
- `report`: render markdown/table summary from one report.

## Current Status

Implemented:
- v1 adapter contract skeleton
- compliance runner + L1 suite
- unified run report schema
- SWE official scorer + adapter-driven prediction generation
- official TB2 runner integration (`harbor` / `uvx` / `docker`)
- official TAU2 runner integration (`tau2` / `uvx` + official data bootstrap)
- real KODE runtime adapters (`kode-agent` + `kode-sdk` plugin mode)

Planned next:
- non-mock adapter implementations (`codex`, `claude-code`, `gemini`)
- adapter-level retry/timeout profiles per benchmark
