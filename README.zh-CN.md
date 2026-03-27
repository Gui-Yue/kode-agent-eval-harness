# Kode Agent Eval Harness

通过独立 benchmark adapter 层评测 KODE 在 `SWE`、`TB2`、`Tau` 上的表现，而不把 benchmark 逻辑耦合进 SDK 主仓库。

## Features

- 通过 Harbor 运行 `swebench-verified`
- 通过 Harbor 运行 `terminal-bench@2.0`
- 运行官方 `tau-bench`
- 通过 npm 包 `@shareai-lab/kode-sdk` 调用 KODE
- benchmark 框架在运行时动态拉取
- 支持 GitHub Actions 冒烟测试和更大规模评测
- 产出汇总报告和按题拆分的结果文件

## Quick Start

安装依赖：

```bash
npm install
```

做本地检查：

```bash
npm run typecheck
npm run bench:bundle:harbor
npm run bench:bundle:tau
```

模型名使用 `provider/model` 格式。

例如：

```text
glm/glm-5
```

## 架构图

```text
            +----------------------+
            |  GitHub Actions      |
            |  SWE / TB2 / Tau     |
            +----------+-----------+
                       |
          +------------+-------------+
          |                          |
          v                          v
  +---------------+          +---------------+
  | Harbor 路径   |          | Tau 路径      |
  | SWE / TB2     |          | Tau           |
  +-------+-------+          +-------+-------+
          |                          |
          v                          v
  +---------------+          +---------------+
  | Harbor Adapter|          | Tau Adapter   |
  +-------+-------+          +-------+-------+
          |                          |
          v                          v
  +---------------+          +---------------+
  | Node Runner   |          | Step Runner   |
  +-------+-------+          +-------+-------+
          \____________________  ____________/
                               \/
                    +----------------------+
                    | @shareai-lab/kode-sdk|
                    +----------------------+
```

## Run on GitHub Actions

手动 dispatch 这些 workflow：

- `.github/workflows/eval-swe.yml`
- `.github/workflows/eval-tb2.yml`
- `.github/workflows/eval-tau.yml`

最基本的输入：

```text
model_name=provider/model
```

常见仓库配置：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_API`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `MINIMAX_API_KEY`

如果走 OpenAI-compatible 的 GLM 路由，实际读取的是：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`

常用 workflow 输入：

### SWE / TB2

- `model_name`
- `task_names`
- `task_limit`
- `shard_count`
- `max_parallel_shards`
- `n_attempts`
- `n_concurrent`

### Tau

- `model_name`
- `tau_env`
- `task_split`
- `task_ids`
- `start_index`
- `end_index`
- `num_trials`
- `max_concurrency`

## Outputs

### SWE / TB2

每次 run 会产出：

- shard artifacts
- 每题的 `result.json`
- `agent/kode-result.json`
- 合并后的 summary markdown
- 合并后的 results JSON
- 合并后的 per-test details JSON

### Tau

每次 run 会产出：

- 最终 metrics JSON
- 每题 reward 数据
- 每题 trajectory 数据

## English Version

见：

- `README.md`
