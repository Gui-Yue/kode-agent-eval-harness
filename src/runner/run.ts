import fs from 'node:fs';
import path from 'node:path';
import Ajv, { type AnySchema } from 'ajv';
import addFormats from 'ajv-formats';
import { createAdapter } from '../adapters/registry';
import { createBenchmarkDriver } from '../benchmarks';
import { generateSWEPredictions } from '../benchmarks/swe-generate';
import { runSWEOfficialBenchmark } from '../benchmarks/swe-official';
import { runTB2OfficialBenchmark } from '../benchmarks/tb2-official';
import { runTAUOfficialBenchmark } from '../benchmarks/tau-official';
import type { BenchmarkId, TaskResult, UnifiedRunReport } from '../types';
import { writeJson, loadJsonSchema } from '../utils/io';

export interface RunOptions {
  benchmark: BenchmarkId;
  agent: string;
  model: string;
  out: string;
  seed: number;
  timeoutMs: number;

  provider: string;

  sweCasesFile: string;
  swePredictionsFile?: string;
  swePredictionOut: string;
  sweWorkDir: string;
  sweImageNamespace: string;
  sweMaxInstances?: number;
  sweAutoGenerate: boolean;
  sweGenerateOnly: boolean;

  tb2Dataset: string;
  tb2Agent: string;
  tb2JobsDir: string;
  tb2Runner: 'auto' | 'harbor' | 'uvx' | 'docker';
  tb2Python: string;
  tb2DockerImage: string;
  tb2EnvFile?: string;

  tauDomain: string;
  tauNumTrials: number;
  tauDataDir: string;
  tauUserModel?: string;
  tauEnvFile?: string;
}

function getOption(options: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = options[k];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function getEnvValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  return undefined;
}

function withProviderPrefixIfNeeded(model: string, provider: string): string {
  if (!model || model.includes('/')) return model;
  const p = (provider || '').trim();
  if (!p) return model;
  return `${p}/${model}`;
}

function asNumber(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function asBoolean(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

export function parseRunOptions(options: Record<string, string>): RunOptions {
  const tb2RunnerRaw = getOption(options, 'tb2-runner', 'tb2_runner', 'runner') || 'auto';
  const tb2Runner = ['auto', 'harbor', 'uvx', 'docker'].includes(tb2RunnerRaw)
    ? (tb2RunnerRaw as RunOptions['tb2Runner'])
    : 'auto';

  const sweMaxInstancesRaw = getOption(options, 'swe-max-instances', 'swe_max_instances');
  const sweMaxInstances = sweMaxInstancesRaw ? asNumber(sweMaxInstancesRaw, 0) : undefined;

  const provider = getOption(options, 'provider')
    || getEnvValue('BENCHMARK_PROVIDER', 'PROVIDER')
    || 'openai';

  const model = withProviderPrefixIfNeeded(
    getOption(options, 'model')
      || getEnvValue('BENCHMARK_MODEL', 'MODEL_ID', 'OPENAI_MODEL_ID', 'ANTHROPIC_MODEL_ID', 'GEMINI_MODEL_ID')
      || 'openai/glm-5',
    provider,
  );

  return {
    benchmark: (getOption(options, 'benchmark') as BenchmarkId) || 'mock',
    agent: getOption(options, 'agent') || 'mock',
    model,
    out: getOption(options, 'out', 'output') || 'reports/run-report.json',
    seed: asNumber(getOption(options, 'seed'), 42),
    timeoutMs: asNumber(getOption(options, 'timeout_ms', 'timeout-ms'), 120000),

    provider,

    sweCasesFile: getOption(options, 'swe-cases-file', 'swe_cases_file') || 'benchmarks-data/swe/verified-instances.json',
    swePredictionsFile: getOption(options, 'swe-predictions-file', 'swe_predictions_file', 'predictions-file', 'predictions_file'),
    swePredictionOut: getOption(options, 'swe-prediction-out', 'swe_prediction_out') || 'tests/tmp/swe-predictions.generated.json',
    sweWorkDir: getOption(options, 'swe-work-dir', 'swe_work_dir') || 'tests/tmp/swe-work',
    sweImageNamespace: getOption(options, 'swe-image-namespace', 'swe_image_namespace')
      || getEnvValue('BENCHMARK_SWE_IMAGE_NAMESPACE', 'SWE_IMAGE_NAMESPACE')
      || 'swebench',
    sweMaxInstances: sweMaxInstances && sweMaxInstances > 0 ? sweMaxInstances : undefined,
    sweAutoGenerate: asBoolean(getOption(options, 'swe-auto-generate', 'swe_auto_generate'), true),
    sweGenerateOnly: asBoolean(getOption(options, 'swe-generate-only', 'swe_generate_only'), false),

    tb2Dataset: getOption(options, 'tb2-dataset', 'tb2_dataset') || 'terminal-bench@2.0',
    tb2Agent: getOption(options, 'tb2-agent', 'tb2_agent') || 'oracle',
    tb2JobsDir: getOption(options, 'tb2-jobs-dir', 'tb2_jobs_dir') || 'tests/tmp/jobs',
    tb2Runner,
    tb2Python: getOption(options, 'tb2-python', 'tb2_python') || '3.12',
    tb2DockerImage: getOption(options, 'tb2-docker-image', 'tb2_docker_image') || 'ghcr.io/astral-sh/uv:python3.12-bookworm',
    tb2EnvFile: getOption(options, 'tb2-env-file', 'tb2_env_file', 'env-file', 'env_file'),

    tauDomain: getOption(options, 'tau-domain', 'tau_domain') || 'airline',
    tauNumTrials: asNumber(getOption(options, 'num-trials', 'num_trials', 'tau-num-trials'), 1),
    tauDataDir: getOption(options, 'tau-data-dir', 'tau_data_dir') || 'tests/tmp/tau2-data',
    tauUserModel: getOption(options, 'tau-user-model', 'tau_user_model'),
    tauEnvFile: getOption(options, 'tau-env-file', 'tau_env_file', 'env-file', 'env_file'),
  };
}

function summarize(taskResults: TaskResult[]) {
  const passed = taskResults.filter(t => t.passed).length;
  const latencies = taskResults.map(t => t.duration_ms);
  const tokenVals = taskResults
    .map(t => t.token_usage?.total_tokens)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));

  const error_distribution: Record<string, number> = {};
  for (const t of taskResults) {
    if (!t.error_code) continue;
    error_distribution[t.error_code] = (error_distribution[t.error_code] || 0) + 1;
  }

  return {
    pass_rate: taskResults.length > 0 ? passed / taskResults.length : 0,
    avg_latency_ms: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    error_distribution,
    avg_tokens: tokenVals.length > 0 ? Math.round(tokenVals.reduce((a, b) => a + b, 0) / tokenVals.length) : null,
  };
}

function validateReport(report: UnifiedRunReport): void {
  const schema = loadJsonSchema('schema/result.schema.json') as AnySchema;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(report)) {
    throw new Error(`Report schema validation failed: ${ajv.errorsText(validate.errors)}`);
  }
}

async function runMockBenchmark(opts: RunOptions): Promise<{ dataset: string; tasks: TaskResult[] }> {
  const adapter = createAdapter(opts.agent);
  const driver = createBenchmarkDriver('mock');
  const tasks = await driver.loadTasks();

  await adapter.init({
    run_id: 'mock-run',
    benchmark: 'mock',
    dataset: driver.dataset,
    seed: opts.seed,
    timeout_ms: opts.timeoutMs,
    model: opts.model,
    agent_config: {},
  });

  const taskResults: TaskResult[] = [];
  try {
    for (const t of tasks) {
      const t0 = Date.now();
      try {
        const output = await adapter.step(t.input);
        const duration = Date.now() - t0;
        const passed = t.expected_action_types.includes(output.action.type) && !output.error;
        taskResults.push({
          task_id: t.id,
          passed,
          score: passed ? 1 : 0,
          duration_ms: duration,
          error_code: output.error?.code,
          token_usage: output.usage ?? null,
        });
      } catch (err: any) {
        taskResults.push({
          task_id: t.id,
          passed: false,
          score: 0,
          duration_ms: Date.now() - t0,
          error_code: 'INTERNAL_ERROR',
          token_usage: null,
        });
        console.error(`[task:${t.id}] step failed: ${err?.message || String(err)}`);
      }
    }
  } finally {
    await adapter.close();
  }

  return { dataset: driver.dataset, tasks: taskResults };
}

function readPredictionsAsTasks(predictionsFile: string): TaskResult[] {
  const full = path.resolve(process.cwd(), predictionsFile);
  if (!fs.existsSync(full)) {
    throw new Error(`SWE predictions file not found: ${full}`);
  }
  const raw = JSON.parse(fs.readFileSync(full, 'utf-8'));

  const out: TaskResult[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item.instance_id !== 'string') continue;
      const tokens = typeof item.tokens_used === 'number' ? Math.round(item.tokens_used) : null;
      out.push({
        task_id: item.instance_id,
        passed: false,
        score: 0,
        duration_ms: 0,
        error_code: 'NOT_EVALUATED',
        token_usage: tokens !== null
          ? { input_tokens: null, output_tokens: null, cache_tokens: null, total_tokens: tokens, latency_ms: null }
          : null,
      });
    }
    return out;
  }

  if (raw && typeof raw === 'object') {
    for (const [instanceId, v] of Object.entries(raw as Record<string, any>)) {
      const tokens = v && typeof v === 'object' && typeof v.tokens_used === 'number'
        ? Math.round(v.tokens_used)
        : null;
      out.push({
        task_id: instanceId,
        passed: false,
        score: 0,
        duration_ms: 0,
        error_code: 'NOT_EVALUATED',
        token_usage: tokens !== null
          ? { input_tokens: null, output_tokens: null, cache_tokens: null, total_tokens: tokens, latency_ms: null }
          : null,
      });
    }
    return out;
  }

  throw new Error(`Unsupported SWE predictions format: ${full}`);
}

async function runByBenchmark(opts: RunOptions): Promise<{ dataset: string; tasks: TaskResult[] }> {
  switch (opts.benchmark) {
    case 'mock':
      return runMockBenchmark(opts);
    case 'swe': {
      let predictionsFile = opts.swePredictionsFile;
      let generatedTasks: TaskResult[] | undefined;

      if (!predictionsFile) {
        if (!opts.sweAutoGenerate) {
          throw new Error('SWE requires --swe-predictions-file=<path> or enable auto generation.');
        }
        const gen = await generateSWEPredictions({
          casesFile: opts.sweCasesFile,
          outputFile: opts.swePredictionOut,
          adapter: opts.agent,
          model: opts.model,
          seed: opts.seed,
          timeoutMs: opts.timeoutMs,
          imageNamespace: opts.sweImageNamespace,
          dockerProxy: process.env.BENCHMARK_DOCKER_PROXY,
          maxInstances: opts.sweMaxInstances,
        });
        predictionsFile = gen.outputFile;
        generatedTasks = gen.tasks;
        console.log(`SWE predictions generated: ${predictionsFile} (${gen.predictions.length} entries)`);
      }

      if (opts.sweGenerateOnly) {
        const tasks = generatedTasks ?? readPredictionsAsTasks(predictionsFile);
        return { dataset: 'swe-bench-verified/predictions', tasks };
      }

      const r = runSWEOfficialBenchmark({
        casesFile: opts.sweCasesFile,
        predictionsFile,
        workDir: opts.sweWorkDir,
        imageNamespace: opts.sweImageNamespace,
        maxInstances: opts.sweMaxInstances,
        dockerProxy: process.env.BENCHMARK_DOCKER_PROXY,
      });
      return { dataset: r.dataset, tasks: r.tasks };
    }
    case 'tb2': {
      const r = runTB2OfficialBenchmark({
        dataset: opts.tb2Dataset,
        model: opts.model,
        agent: opts.tb2Agent,
        jobsDir: opts.tb2JobsDir,
        runner: opts.tb2Runner,
        dockerImage: opts.tb2DockerImage,
        python: opts.tb2Python,
        envFile: opts.tb2EnvFile,
      });
      console.log(`TB2 job path: ${r.jobPath}`);
      if (r.unknown > 0) console.log(`TB2 unknown trials: ${r.unknown}`);
      return { dataset: r.dataset, tasks: r.tasks };
    }
    case 'tau': {
      const r = await runTAUOfficialBenchmark({
        domain: opts.tauDomain,
        numTrials: opts.tauNumTrials,
        provider: opts.provider,
        model: opts.model,
        userModel: opts.tauUserModel,
        dataDir: opts.tauDataDir,
        envFile: opts.tauEnvFile,
        dockerProxy: process.env.BENCHMARK_DOCKER_PROXY,
      });
      return { dataset: r.dataset, tasks: r.tasks };
    }
    default:
      throw new Error(`Unsupported benchmark: ${opts.benchmark}`);
  }
}

function displayAgentLabel(opts: RunOptions): string {
  if (opts.benchmark === 'tb2') return opts.tb2Agent;
  if (opts.benchmark === 'tau') return 'tau2-llm_agent';
  if (opts.benchmark === 'swe') return opts.agent;
  return opts.agent;
}

export async function runCommand(opts: RunOptions): Promise<UnifiedRunReport> {
  const started = new Date();
  const run_id = `run-${started.toISOString().replace(/[:.]/g, '-')}`;
  const commit_sha = process.env.GIT_SHA || process.env.GITHUB_SHA || 'unknown';

  const executed = await runByBenchmark(opts);
  const report: UnifiedRunReport = {
    run_id,
    benchmark: opts.benchmark,
    dataset: executed.dataset,
    agent: displayAgentLabel(opts),
    model: opts.model,
    commit_sha,
    seed: opts.seed,
    timeout_ms: opts.timeoutMs,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    tasks: executed.tasks,
    summary: summarize(executed.tasks),
  };

  validateReport(report);
  writeJson(opts.out, report);
  return report;
}
