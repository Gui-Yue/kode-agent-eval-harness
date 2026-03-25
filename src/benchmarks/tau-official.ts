import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { TaskResult, TokenUsage } from '../types';
import { getEnvValue, resolveEnvFile } from '../utils/env';

const TAU2_SOURCE = 'git+https://github.com/sierra-research/tau2-bench@v0.2.0';
const TAU2_REPO = 'https://github.com/sierra-research/tau2-bench';
const TAU2_REF = 'v0.2.0';
const TAU_PLUGIN_MODULE = 'tau2_protocol_agent_plugin';
const TAU_PLUGIN_DIR = path.join(process.cwd(), 'src');

export interface TAUOfficialOptions {
  domain: string;
  numTrials: number;
  provider: string;
  model: string;
  agentCore?: string;
  runtimeRef?: string;
  userModel?: string;
  dataDir: string;
  envFile?: string;
  dockerProxy?: string;
}

export interface TAUOfficialResult {
  dataset: string;
  tasks: TaskResult[];
}

export async function scoreWithOfficialTauRunner(rawOpts: TAUOfficialOptions): Promise<TAUOfficialResult> {
  return runTAUOfficialBenchmark(rawOpts);
}

interface RunnerSpec {
  cmd: string;
  argsPrefix: string[];
  label: string;
}

interface Tau2Task {
  id?: string;
}

interface Tau2Simulation {
  task_id?: string;
  trial?: number;
  reward_info?: { reward?: number };
  [key: string]: unknown;
}

interface Tau2RunOutput {
  info?: { num_trials?: number };
  tasks?: Tau2Task[];
  simulations?: Tau2Simulation[];
}

function hasCommand(cmd: string, versionArg = '--version'): boolean {
  const r = spawnSync(cmd, [versionArg], { stdio: 'ignore' });
  return r.status === 0;
}

function getDomains(domain: string): string[] {
  if (domain === 'all') return ['airline', 'retail', 'telecom'];
  return [domain];
}

function ensureDataDir(dataDir: string): void {
  fs.mkdirSync(path.join(dataDir, 'simulations'), { recursive: true });
}

function requiredTaskFiles(dataDir: string, domains: string[]): string[] {
  return domains.map(d => path.join(dataDir, 'tau2', 'domains', d, 'tasks.json'));
}

function ensureOfficialDataFiles(dataDir: string, domains: string[]): void {
  const missingBefore = requiredTaskFiles(dataDir, domains).filter(p => !fs.existsSync(p));
  if (missingBefore.length === 0) return;

  if (!hasCommand('git')) {
    throw new Error(`TAU2 data files missing and git is not available. Missing: ${missingBefore.join(', ')}`);
  }

  const sourceDir = path.join(dataDir, '.tau2-source');
  const sourceDataDir = path.join(sourceDir, 'data', 'tau2');

  console.log('TAU2 data missing, bootstrapping official data from repository...');
  if (!fs.existsSync(sourceDataDir)) {
    if (fs.existsSync(sourceDir)) fs.rmSync(sourceDir, { recursive: true, force: true });
    const clone = spawnSync('git', ['clone', '--depth', '1', '--branch', TAU2_REF, TAU2_REPO, sourceDir], { stdio: 'inherit' });
    if (clone.status !== 0) {
      throw new Error(`Failed to clone TAU2 data source (exit code ${clone.status ?? 'unknown'})`);
    }
  }

  if (!fs.existsSync(sourceDataDir)) {
    throw new Error(`TAU2 data source missing expected directory: ${sourceDataDir}`);
  }

  fs.mkdirSync(path.join(dataDir, 'tau2'), { recursive: true });
  fs.cpSync(sourceDataDir, path.join(dataDir, 'tau2'), { recursive: true, force: true });

  const missingAfter = requiredTaskFiles(dataDir, domains).filter(p => !fs.existsSync(p));
  if (missingAfter.length > 0) {
    throw new Error(`TAU2 data bootstrap incomplete. Missing: ${missingAfter.join(', ')}`);
  }
}

function toTau2Model(provider: string, model: string): string {
  if (model.includes('/')) return model;
  if (provider === 'anthropic') return `anthropic/${model}`;
  if (provider === 'gemini') return `gemini/${model}`;
  return `openai/${model}`;
}

function applyProviderEnv(env: NodeJS.ProcessEnv, provider: string, model: string, envFile?: string): void {
  const keyPrefix = provider.toUpperCase();
  const apiKey = getEnvValue(`${keyPrefix}_API_KEY`, envFile);
  const baseUrl = getEnvValue(`${keyPrefix}_BASE_URL`, envFile);

  if (!apiKey) {
    throw new Error(`Missing API key for provider=${provider}. Expected ${keyPrefix}_API_KEY`);
  }

  if (provider === 'anthropic') {
    env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    return;
  }

  if (provider === 'gemini') {
    env.GEMINI_API_KEY = apiKey;
    if (baseUrl) env.GEMINI_BASE_URL = baseUrl;
    return;
  }

  env.OPENAI_API_KEY = apiKey;
  if (baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
    env.OPENAI_API_BASE = baseUrl;
  }
  // Avoid accidental mismatch where model prefix is openai/* but env uses another provider id.
  env.BENCHMARK_PROVIDER = provider;
  env.BENCHMARK_MODEL = model;
}

function resolveRunner(): RunnerSpec {
  if (hasCommand('tau2')) {
    return { cmd: 'tau2', argsPrefix: [], label: 'tau2' };
  }
  if (hasCommand('uvx')) {
    return {
      cmd: 'uvx',
      argsPrefix: ['--python', '3.12', '--from', TAU2_SOURCE, 'tau2'],
      label: `uvx tau2 (${TAU2_SOURCE})`,
    };
  }
  throw new Error('TAU official runner not found. Install `tau2` or `uvx`.');
}

function shouldKeepTauLogLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (s.includes('Provider List: https://docs.litellm.ai/docs/providers')) return false;
  if (s.startsWith('Give Feedback / Get Help: https://github.com/BerriAI/litellm/issues/new')) return false;
  if (s.startsWith('LiteLLM.Info: If you need to debug this error')) return false;
  if (s.includes('tau2.utils.llm_utils:get_response_cost')) return false;
  if (s.includes("This model isn't mapped yet.")) return false;
  return true;
}

function createLineEmitter(isErr: boolean): (chunk: Buffer | string, flush?: boolean) => void {
  let buffer = '';
  return (chunk: Buffer | string, flush = false) => {
    if (chunk) buffer += chunk.toString().replace(/\r/g, '\n');
    const parts = buffer.split('\n');
    if (!flush) buffer = parts.pop() ?? '';
    else buffer = '';

    for (const line of parts) {
      if (!shouldKeepTauLogLine(line)) continue;
      if (isErr) console.error(line);
      else console.log(line);
    }
  };
}

async function runTau2WithFilteredLogs(runner: RunnerSpec, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(runner.cmd, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = createLineEmitter(false);
  const err = createLineEmitter(true);

  child.stdout?.on('data', (chunk: Buffer | string) => out(chunk, false));
  child.stderr?.on('data', (chunk: Buffer | string) => err(chunk, false));

  return await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      out('', true);
      err('', true);
      resolve(code ?? 1);
    });
  });
}

function sanitizeLabel(v: string): string {
  return v.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96);
}

function resolveTauAgentCore(raw?: string): string {
  const v = (raw || '').trim();
  if (!v) return 'llm_agent';
  return v;
}

function isBuiltinTauAgentCore(agentCore: string): boolean {
  return agentCore === 'llm_agent' || agentCore === 'llm_agent_solo' || agentCore === 'llm_agent_gt';
}

function appendPythonPath(env: NodeJS.ProcessEnv, extraPath: string): void {
  const key = 'PYTHONPATH';
  const current = env[key];
  env[key] = current ? `${extraPath}${path.delimiter}${current}` : extraPath;
}

function readJson(filePath: string): Tau2RunOutput {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Tau2RunOutput;
}

function isPass(sim: Tau2Simulation): boolean {
  const reward = sim.reward_info?.reward;
  return typeof reward === 'number' && Math.abs(reward - 1) <= 1e-6;
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

function extractTokenUsage(obj: unknown): TokenUsage | null {
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

function parseTau2Output(domain: string, filePath: string): TaskResult[] {
  const parsed = readJson(filePath);

  const taskIds = new Set<string>();
  for (const t of parsed.tasks ?? []) {
    if (typeof t.id === 'string' && t.id.length > 0) taskIds.add(t.id);
  }
  for (const sim of parsed.simulations ?? []) {
    if (typeof sim.task_id === 'string' && sim.task_id.length > 0) taskIds.add(sim.task_id);
  }

  const trialMatrix = new Map<string, boolean[]>();
  const tokenMatrix = new Map<string, Array<number | undefined>>();
  for (const id of taskIds) {
    trialMatrix.set(id, []);
    tokenMatrix.set(id, []);
  }

  for (const sim of parsed.simulations ?? []) {
    const taskId = sim.task_id;
    if (!taskId || !trialMatrix.has(taskId)) continue;

    const arr = trialMatrix.get(taskId)!;
    const tokenArr = tokenMatrix.get(taskId)!;
    const tokenUsage = extractTokenUsage(sim);
    const tokenVal = tokenUsage?.total_tokens ?? undefined;

    if (typeof sim.trial === 'number' && sim.trial >= 0) {
      arr[sim.trial] = isPass(sim);
      tokenArr[sim.trial] = tokenVal ?? undefined;
    } else {
      arr.push(isPass(sim));
      tokenArr.push(tokenVal ?? undefined);
    }
  }

  const out: TaskResult[] = [];
  for (const taskId of taskIds) {
    const trials = (trialMatrix.get(taskId) ?? []).filter((v): v is boolean => typeof v === 'boolean');
    const tokens = (tokenMatrix.get(taskId) ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const score = trials.length > 0 ? trials.filter(Boolean).length / trials.length : 0;
    const passAt1 = trials.length > 0 ? trials[0] : false;

    out.push({
      task_id: `${domain}/${taskId}`,
      passed: passAt1,
      score,
      duration_ms: 0,
      error_code: trials.length === 0 ? 'NO_TRIAL_RESULTS' : undefined,
      token_usage: tokens.length > 0
        ? {
            input_tokens: null,
            output_tokens: null,
            cache_tokens: null,
            total_tokens: Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length),
            latency_ms: null,
          }
        : null,
    });
  }

  return out;
}

export async function runTAUOfficialBenchmark(rawOpts: TAUOfficialOptions): Promise<TAUOfficialResult> {
  const envFile = resolveEnvFile(rawOpts.envFile);
  const domains = getDomains(rawOpts.domain);
  const runner = resolveRunner();
  const dataDir = path.resolve(rawOpts.dataDir);

  ensureDataDir(dataDir);
  ensureOfficialDataFiles(dataDir, domains);

  const provider = rawOpts.provider || 'openai';
  const model = toTau2Model(provider, rawOpts.model);
  const runtimeRef = (rawOpts.runtimeRef || '').trim();
  const agentCore = runtimeRef ? 'eval_harness_agent' : resolveTauAgentCore(rawOpts.agentCore);
  const builtinAgentCore = runtimeRef ? false : isBuiltinTauAgentCore(agentCore);
  const defaultMaxConcurrency = 1;
  const rawMaxConcurrency = (process.env.TAU2_MAX_CONCURRENCY || '').trim();
  const parsedMaxConcurrency = Number(rawMaxConcurrency);
  const maxConcurrency = Number.isFinite(parsedMaxConcurrency) && parsedMaxConcurrency > 0
    ? Math.floor(parsedMaxConcurrency)
    : defaultMaxConcurrency;
  const userModel = rawOpts.userModel ? toTau2Model(provider, rawOpts.userModel) : model;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TAU2_DATA_DIR: dataDir,
    UV_CACHE_DIR: process.env.UV_CACHE_DIR || '/tmp/uv-cache',
    UV_TOOL_DIR: process.env.UV_TOOL_DIR || '/tmp/uv-tools',
    XDG_DATA_HOME: process.env.XDG_DATA_HOME || '/tmp/xdg-data',
  };

  if (rawOpts.dockerProxy) {
    env.HTTP_PROXY = rawOpts.dockerProxy;
    env.HTTPS_PROXY = rawOpts.dockerProxy;
    env.http_proxy = rawOpts.dockerProxy;
    env.https_proxy = rawOpts.dockerProxy;
  }

  applyProviderEnv(env, provider, rawOpts.model, envFile);

  if (!builtinAgentCore) {
    const pluginModule = TAU_PLUGIN_MODULE;
    const pluginPath = path.resolve(TAU_PLUGIN_DIR);
    const sitecustomizePath = path.join(pluginPath, 'sitecustomize.py');
    if (!fs.existsSync(sitecustomizePath)) {
      throw new Error(
        `TAU custom agent "${agentCore}" requires plugin hook file: ${sitecustomizePath}. ` +
        `Ensure src/sitecustomize.py exists in this repository.`,
      );
    }

    appendPythonPath(env, pluginPath);
    env.TAU2_AGENT_PLUGIN_MODULE = pluginModule;
    env.TAU2_AGENT_PLUGIN_NAME = agentCore;
    if (runtimeRef) env.EVAL_HARNESS_AGENT_REF = runtimeRef;
    env.EVAL_HARNESS_MODEL = model;
    if (!env.EVAL_HARNESS_TIMEOUT_MS) env.EVAL_HARNESS_TIMEOUT_MS = '300000';
    if (!env.TAU2_AGENT_MIN_REQUEST_INTERVAL_MS) env.TAU2_AGENT_MIN_REQUEST_INTERVAL_MS = '2000';
    if (!env.TAU2_USER_MIN_REQUEST_INTERVAL_MS) env.TAU2_USER_MIN_REQUEST_INTERVAL_MS = '5000';
    if (!env.TAU2_USER_REQUEST_JITTER_MS) env.TAU2_USER_REQUEST_JITTER_MS = '2000';
    if (!env.TAU2_USER_RATE_LIMIT_RETRIES) env.TAU2_USER_RATE_LIMIT_RETRIES = '6';
    if (!env.TAU2_USER_RATE_LIMIT_BACKOFF_MS) env.TAU2_USER_RATE_LIMIT_BACKOFF_MS = '5000';
    console.log(`TAU runtime bridge enabled: module=${pluginModule} path=${pluginPath}`);
  }

  const allTasks: TaskResult[] = [];

  console.log(`TAU official source: tau2 (${TAU2_SOURCE})`);
  console.log(`TAU data dir: ${dataDir}`);
  console.log(`TAU agent core: ${agentCore}`);
  console.log(`TAU max concurrency: ${maxConcurrency}`);
  if (!builtinAgentCore) {
    console.log(`TAU runtime bridge min request interval: ${env.TAU2_AGENT_MIN_REQUEST_INTERVAL_MS}ms`);
    console.log(
      `TAU user simulator min request interval: ${env.TAU2_USER_MIN_REQUEST_INTERVAL_MS}ms `
      + `jitter=${env.TAU2_USER_REQUEST_JITTER_MS}ms `
      + `retries=${env.TAU2_USER_RATE_LIMIT_RETRIES} `
      + `backoff=${env.TAU2_USER_RATE_LIMIT_BACKOFF_MS}ms`,
    );
  }

  for (const domain of domains) {
    const saveName = sanitizeLabel(`tau2-${domain}-${provider}-${rawOpts.model}-${Date.now()}`);
    const outputPath = path.join(dataDir, 'simulations', `${saveName}.json`);

    const args = [
      ...runner.argsPrefix,
      'run',
      '--domain', domain,
      '--agent', agentCore,
      '--agent-llm', model,
      '--user-llm', userModel,
      '--max-concurrency', String(maxConcurrency),
      '--num-trials', String(rawOpts.numTrials),
      '--save-to', saveName,
    ];

    console.log(`[${provider}] ${domain}: tau2 run (${runner.label})`);
    const status = await runTau2WithFilteredLogs(runner, args, env);
    if (status !== 0) {
      throw new Error(`tau2 run failed on domain=${domain} with exit code ${status}`);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error(`tau2 output not found: ${outputPath}`);
    }

    const tasks = parseTau2Output(domain, outputPath);
    allTasks.push(...tasks);
  }

  return {
    dataset: `tau2@${TAU2_REF}`,
    tasks: allTasks,
  };
}
