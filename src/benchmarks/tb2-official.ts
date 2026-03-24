import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TaskResult, TokenUsage } from '../types';
import { getEnvValue, resolveEnvFile } from '../utils/env';

export interface TB2OfficialOptions {
  dataset: string;
  model?: string;
  agent: string;
  runtimeRef?: string;
  jobsDir: string;
  runner: 'auto' | 'harbor' | 'uvx' | 'docker';
  dockerImage: string;
  python: string;
  envFile?: string;
}

export interface TB2OfficialResult {
  dataset: string;
  jobPath: string;
  tasks: TaskResult[];
  unknown: number;
}

export function scoreWithOfficialTB2Runner(rawOpts: TB2OfficialOptions): TB2OfficialResult {
  return runTB2OfficialBenchmark(rawOpts);
}

interface RunnerSpec {
  cmd: string;
  argsPrefix: string[];
  label: string;
  env?: NodeJS.ProcessEnv;
}

function hasCommand(cmd: string, versionArg = '--version'): boolean {
  const r = spawnSync(cmd, [versionArg], { stdio: 'ignore' });
  return r.status === 0;
}

function appendPythonPath(env: NodeJS.ProcessEnv, extraPath: string): void {
  const key = 'PYTHONPATH';
  const current = env[key];
  env[key] = current ? `${extraPath}${path.delimiter}${current}` : extraPath;
}

function proxyLooksLocalhost(proxyUrl?: string): boolean {
  if (!proxyUrl) return false;
  try {
    const u = new URL(proxyUrl);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return proxyUrl.includes('127.0.0.1') || proxyUrl.includes('localhost');
  }
}

function listDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map(name => path.join(root, name))
    .filter(p => fs.existsSync(p) && fs.statSync(p).isDirectory());
}

function findLatestJobDir(jobsDir: string, before: Set<string>): string {
  const after = listDirs(jobsDir);
  const created = after.filter(p => !before.has(path.resolve(p)));
  const candidates = created.length > 0 ? created : after;
  if (candidates.length === 0) {
    throw new Error(`No job directory found under ${jobsDir}`);
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function findFilesRecursive(root: string, fileName: string): string[] {
  const out: string[] = [];
  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === fileName) out.push(full);
    }
  }
  walk(root);
  return out;
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickBooleanResult(obj: Record<string, any>): boolean | undefined {
  for (const k of ['success', 'passed', 'resolved', 'solved', 'is_success', 'is_passed', 'pass']) {
    if (typeof obj[k] === 'boolean') return obj[k];
  }
  for (const nk of ['result', 'outcome', 'evaluation', 'metrics', 'summary']) {
    const v = obj[nk];
    if (!isObject(v)) continue;
    for (const k of ['success', 'passed', 'resolved', 'solved', 'is_success', 'is_passed', 'pass']) {
      if (typeof v[k] === 'boolean') return v[k];
    }
  }
  return undefined;
}

function pickResultFromRewardFile(resultJsonPath: string): boolean | undefined {
  const rewardPath = path.join(path.dirname(resultJsonPath), 'verifier', 'reward.txt');
  if (!fs.existsSync(rewardPath)) return undefined;
  try {
    const n = Number(fs.readFileSync(rewardPath, 'utf-8').trim());
    if (!Number.isFinite(n)) return undefined;
    return n > 0;
  } catch {
    return undefined;
  }
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function getPathNumber(obj: unknown, keys: string[]): number | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return asFiniteNumber(cur);
}

function findNumberByKeys(obj: unknown, candidates: string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const queue: unknown[] = [obj];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      for (const v of cur) queue.push(v);
      continue;
    }
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (candidates.includes(k)) {
        const n = asFiniteNumber(v);
        if (n !== undefined) return n;
      }
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return undefined;
}

function extractTokenUsage(obj: Record<string, any>): TokenUsage | null {
  const input = getPathNumber(obj, ['agent_result', 'n_input_tokens'])
    ?? getPathNumber(obj, ['agent_result', 'usage', 'input_tokens'])
    ?? findNumberByKeys(obj, ['n_input_tokens', 'input_tokens', 'prompt_tokens']);
  const output = getPathNumber(obj, ['agent_result', 'n_output_tokens'])
    ?? getPathNumber(obj, ['agent_result', 'usage', 'output_tokens'])
    ?? findNumberByKeys(obj, ['n_output_tokens', 'output_tokens', 'completion_tokens']);
  const cache = getPathNumber(obj, ['agent_result', 'n_cache_tokens'])
    ?? findNumberByKeys(obj, ['n_cache_tokens', 'cache_tokens']);
  const total = getPathNumber(obj, ['agent_result', 'n_total_tokens'])
    ?? getPathNumber(obj, ['agent_result', 'usage', 'total_tokens'])
    ?? findNumberByKeys(obj, ['n_total_tokens', 'total_tokens']);

  if (input === undefined && output === undefined && cache === undefined && total === undefined) {
    return null;
  }

  return {
    input_tokens: input ?? null,
    output_tokens: output ?? null,
    cache_tokens: cache ?? null,
    total_tokens: total ?? ((input ?? 0) + (output ?? 0) + (cache ?? 0)),
    latency_ms: null,
  };
}

function resolveRunner(opts: TB2OfficialOptions, envFile?: string): RunnerSpec {
  const fallbackProxy = getEnvValue('BENCHMARK_DOCKER_PROXY', envFile);
  const cwdForRun = path.dirname(path.resolve(opts.jobsDir));

  if (opts.runner === 'harbor') {
    if (!hasCommand('harbor')) throw new Error('harbor not found for --tb2-runner=harbor');
    return { cmd: 'harbor', argsPrefix: [], label: 'harbor' };
  }

  if (opts.runner === 'uvx') {
    if (!hasCommand('uvx')) throw new Error('uvx not found for --tb2-runner=uvx');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR || '/tmp/uv-cache',
      UV_TOOL_DIR: process.env.UV_TOOL_DIR || '/tmp/uv-tools',
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || '/tmp/xdg-data',
    };
    if (fallbackProxy) {
      env.HTTP_PROXY = fallbackProxy;
      env.HTTPS_PROXY = fallbackProxy;
      env.http_proxy = fallbackProxy;
      env.https_proxy = fallbackProxy;
    }
    return {
      cmd: 'uvx',
      argsPrefix: ['--python', opts.python, 'harbor'],
      label: `uvx harbor (python ${opts.python})`,
      env,
    };
  }

  function buildDockerRunner(): RunnerSpec {
    if (!hasCommand('docker')) {
      throw new Error('docker not found, cannot use --tb2-runner=docker');
    }
    const cacheHostDir = path.resolve(path.dirname(opts.jobsDir), '.tb2-uv-cache');
    fs.mkdirSync(cacheHostDir, { recursive: true });

    const argsPrefix = [
      'run', '--rm',
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${cwdForRun}:${cwdForRun}`,
      '-v', `${cacheHostDir}:/tmp/uv-cache`,
      '-w', cwdForRun,
      '-e', 'UV_CACHE_DIR=/tmp/uv-cache',
    ];

    if (envFile && fs.existsSync(envFile)) argsPrefix.push('--env-file', envFile);

    let usedHostNetwork = false;
    if (process.platform === 'linux' && proxyLooksLocalhost(fallbackProxy)) {
      argsPrefix.push('--network', 'host');
      usedHostNetwork = true;
    }

    if (fallbackProxy) {
      argsPrefix.push(
        '-e', `HTTP_PROXY=${fallbackProxy}`,
        '-e', `HTTPS_PROXY=${fallbackProxy}`,
        '-e', `http_proxy=${fallbackProxy}`,
        '-e', `https_proxy=${fallbackProxy}`,
      );
    }

    argsPrefix.push(opts.dockerImage, 'uvx', 'harbor');

    return {
      cmd: 'docker',
      argsPrefix,
      label: `docker(${opts.dockerImage}) -> uvx harbor${usedHostNetwork ? ' [host-network]' : ''}`,
    };
  }

  if (opts.runner === 'docker') return buildDockerRunner();

  // auto
  if (hasCommand('harbor')) return { cmd: 'harbor', argsPrefix: [], label: 'harbor' };
  if (hasCommand('uvx')) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR || '/tmp/uv-cache',
      UV_TOOL_DIR: process.env.UV_TOOL_DIR || '/tmp/uv-tools',
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || '/tmp/xdg-data',
    };
    if (fallbackProxy) {
      env.HTTP_PROXY = fallbackProxy;
      env.HTTPS_PROXY = fallbackProxy;
      env.http_proxy = fallbackProxy;
      env.https_proxy = fallbackProxy;
    }
    return {
      cmd: 'uvx',
      argsPrefix: ['--python', opts.python, 'harbor'],
      label: `uvx harbor (python ${opts.python})`,
      env,
    };
  }
  return buildDockerRunner();
}

function runOfficialTB2(opts: TB2OfficialOptions, envFile?: string): string {
  const jobsDir = path.resolve(opts.jobsDir);
  fs.mkdirSync(jobsDir, { recursive: true });
  const before = new Set(listDirs(jobsDir).map(p => path.resolve(p)));
  const cwdForRun = path.dirname(jobsDir);

  const runner = resolveRunner(opts, envFile);
  const harborArgs = ['run', '-d', opts.dataset];
  if (opts.model) harborArgs.push('-m', opts.model);

  const env = { ...(runner.env ?? process.env) };
  if (opts.runtimeRef) {
    harborArgs.push('--agent-import-path', 'src.tb2_protocol_agent:ProtocolHarnessAgent');
    env.EVAL_HARNESS_AGENT_REF = opts.runtimeRef;
    if (opts.model) env.EVAL_HARNESS_MODEL = opts.model;
    appendPythonPath(env, process.cwd());
  } else {
    harborArgs.push('-a', opts.agent);
  }

  const fullArgs = [...runner.argsPrefix, ...harborArgs];

  console.log(`Runner: ${runner.label}`);
  console.log(`Running: ${runner.cmd} ${fullArgs.join(' ')}`);
  console.log(`Working dir: ${cwdForRun}`);

  const run = spawnSync(runner.cmd, fullArgs, {
    cwd: cwdForRun,
    env,
    stdio: 'inherit',
  });

  if (run.status !== 0) {
    throw new Error(`TB2 run failed with exit code ${run.status ?? 'unknown'}`);
  }

  return findLatestJobDir(jobsDir, before);
}

function scoreJob(jobPath: string): { tasks: TaskResult[]; unknown: number } {
  const summaryPath = path.resolve(jobPath, 'result.json');
  const allResultFiles = findFilesRecursive(jobPath, 'result.json');
  if (allResultFiles.length === 0) {
    throw new Error(`No result.json found under job path: ${jobPath}`);
  }

  const resultFiles = allResultFiles
    .map(p => path.resolve(p))
    .filter(p => p !== summaryPath);

  const tasks: TaskResult[] = [];
  let unknown = 0;

  for (const file of resultFiles) {
    const taskId = path.relative(jobPath, path.dirname(file)).replace(/\\/g, '/');
    try {
      const data = readJson(file);
      if (!isObject(data)) {
        unknown += 1;
        tasks.push({ task_id: taskId || 'unknown', passed: false, score: 0, duration_ms: 0, error_code: 'UNPARSEABLE_RESULT', token_usage: null });
        continue;
      }

      let ok = pickBooleanResult(data);
      if (typeof ok !== 'boolean') ok = pickResultFromRewardFile(file);
      const usage = extractTokenUsage(data);
      const duration = getPathNumber(data, ['duration_ms'])
        ?? ((getPathNumber(data, ['duration_s']) ?? getPathNumber(data, ['agent_result', 'duration_s'])) ?? 0) * 1000;

      if (typeof ok === 'boolean') {
        tasks.push({
          task_id: taskId || 'unknown',
          passed: ok,
          score: ok ? 1 : 0,
          duration_ms: Math.round(duration),
          token_usage: usage,
        });
      } else {
        unknown += 1;
        tasks.push({
          task_id: taskId || 'unknown',
          passed: false,
          score: 0,
          duration_ms: Math.round(duration),
          error_code: 'UNPARSEABLE_RESULT',
          token_usage: usage,
        });
      }
    } catch {
      unknown += 1;
      tasks.push({ task_id: taskId || 'unknown', passed: false, score: 0, duration_ms: 0, error_code: 'READ_ERROR', token_usage: null });
    }
  }

  if (tasks.length === 0 && fs.existsSync(summaryPath)) {
    const summary = readJson(summaryPath);
    const evals = summary?.stats?.evals;
    const nTotal = typeof summary?.n_total_trials === 'number' ? summary.n_total_trials : undefined;
    if (isObject(evals)) {
      const firstEval = Object.values(evals)[0] as any;
      const mean = typeof firstEval?.metrics?.[0]?.mean === 'number' ? firstEval.metrics[0].mean : undefined;
      const nErrors = typeof firstEval?.n_errors === 'number' ? firstEval.n_errors : 0;
      const nTrials = typeof firstEval?.n_trials === 'number' ? firstEval.n_trials : 0;
      const totalFromSummary = nTotal ?? (nTrials + nErrors);
      if (typeof mean === 'number' && totalFromSummary > 0) {
        const approxPassed = Math.round(mean * totalFromSummary);
        for (let i = 0; i < totalFromSummary; i++) {
          const passed = i < approxPassed;
          tasks.push({
            task_id: `summary-trial-${i + 1}`,
            passed,
            score: passed ? 1 : 0,
            duration_ms: 0,
            token_usage: null,
          });
        }
      }
    }
  }

  return { tasks, unknown };
}

export function runTB2OfficialBenchmark(rawOpts: TB2OfficialOptions): TB2OfficialResult {
  const envFile = resolveEnvFile(rawOpts.envFile);
  const opts: TB2OfficialOptions = {
    ...rawOpts,
    jobsDir: path.resolve(rawOpts.jobsDir),
  };

  const jobPath = runOfficialTB2(opts, envFile);
  const scored = scoreJob(jobPath);

  return {
    dataset: opts.dataset,
    jobPath,
    tasks: scored.tasks,
    unknown: scored.unknown,
  };
}
