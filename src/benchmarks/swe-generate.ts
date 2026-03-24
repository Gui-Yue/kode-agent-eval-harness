import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createAgentRuntime } from '../agents/runtime';
import type { BenchmarkId, TaskResult, TokenUsage } from '../types';

interface SWEInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  test_patch: string;
  test_command: string;
}

export interface SWEPrediction {
  instance_id: string;
  patch: string;
  tokens_used?: number;
}

export interface SWEGenerateOptions {
  casesFile: string;
  outputFile: string;
  adapter: string;
  model: string;
  seed: number;
  timeoutMs: number;
  maxInstances?: number;
  dockerProxy?: string;
  imageNamespace?: string;
}

export interface SWEGenerateResult {
  dataset: string;
  outputFile: string;
  predictions: SWEPrediction[];
  tasks: TaskResult[];
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(process.cwd(), filePath)), { recursive: true });
}

function loadInstances(casesFile: string): SWEInstance[] {
  const full = path.resolve(process.cwd(), casesFile);
  if (!fs.existsSync(full)) {
    throw new Error(`SWE cases file not found: ${full}`);
  }
  const arr = readJson<unknown>(full);
  if (!Array.isArray(arr)) {
    throw new Error(`Invalid SWE cases file format: ${full}`);
  }
  return arr as SWEInstance[];
}

function buildPrompt(inst: SWEInstance): string {
  const parts = [
    'You are solving a SWE-bench instance.',
    `Instance ID: ${inst.instance_id}`,
    `Repo: ${inst.repo}`,
    `Base commit: ${inst.base_commit}`,
    '',
    'Problem statement:',
    inst.problem_statement,
  ];

  if (inst.hints_text) {
    parts.push('', 'Hints:', inst.hints_text);
  }

  parts.push(
    '',
    'Return ONLY a valid git unified diff patch as final answer.',
    'Do not include explanation or markdown fences.',
  );

  return parts.join('\n');
}

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function getSWEBenchImageName(instanceId: string, imageNamespace?: string): string {
  const normalizedNamespace = (imageNamespace || 'swebench').trim().replace(/\/+$/, '');
  const slug = instanceId
    .toLowerCase()
    .replace(/__/g, '_1776_')
    .replace(/[^a-z0-9._-]/g, '_');
  const image = `sweb.eval.x86_64.${slug}:latest`;
  return normalizedNamespace ? `${normalizedNamespace}/${image}` : image;
}

function pullImage(imageName: string, proxyUrl?: string): boolean {
  const inspect = spawnSync('docker', ['image', 'inspect', imageName], {
    stdio: 'ignore',
    timeout: 15000,
  });
  if (inspect.status === 0) return true;

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }

  console.log(`[swe-gen] pulling image ${imageName}`);
  const pull = spawnSync('docker', ['pull', imageName], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 1200000,
  });
  return pull.status === 0;
}

function extractRelevantPaths(problemStatement: string, hintsText?: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /`([\w./-]+\.py)`/g,
    /(?:^|\s)((?:[\w-]+\/)+[\w-]+\.py)(?:\s|$|[.,;:)])/gm,
    /(?:in|see|at|file|module)\s+`?([\w]+(?:\.[\w]+){2,})`?/gi,
  ];

  const sources = [hintsText || '', problemStatement || ''].filter(Boolean);
  for (const source of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        let p = match[1].trim();
        if (!p.includes('/') && p.includes('.') && !p.endsWith('.py')) {
          p = p.replace(/\./g, '/') + '.py';
        }
        if (!/^[\w./-]+\.py$/.test(p)) continue;
        if (p.includes('/tests/') || p.startsWith('tests/') || p.includes('_test')) continue;
        paths.add(p);
      }
    }
  }

  return Array.from(paths);
}

function readFilesFromImage(imageName: string, filePaths: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const filePath of filePaths) {
    const res = spawnSync('docker', ['run', '--rm', imageName, 'cat', `/testbed/${filePath}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60000,
      encoding: 'utf-8',
    });
    if (res.status !== 0) continue;
    if (!res.stdout || !res.stdout.trim()) continue;
    files[filePath] = res.stdout;
  }
  return files;
}

function buildPromptWithContext(inst: SWEInstance, files: Record<string, string>): string {
  const MAX_FILE_CHARS = 12000;
  const sourceBlocks = Object.entries(files).map(([filePath, content]) => {
    const text = content.length > MAX_FILE_CHARS
      ? `${content.slice(0, MAX_FILE_CHARS)}\n... [truncated]`
      : content;
    return `--- ${filePath} ---\n${text}`;
  });

  const parts = [
    'You are solving a SWE-bench instance.',
    `Instance ID: ${inst.instance_id}`,
    `Repo: ${inst.repo}`,
    `Base commit: ${inst.base_commit}`,
    '',
    'Problem statement:',
    inst.problem_statement,
  ];

  if (inst.hints_text) {
    parts.push('', 'Hints:', inst.hints_text);
  }

  parts.push(
    '',
    'Relevant source files from repository (/testbed):',
    sourceBlocks.join('\n\n'),
    '',
    'Return ONLY a valid git unified diff patch as final answer.',
    'Do not include explanations or markdown fences.',
    'Do not modify tests unless absolutely required by the issue.',
  );

  return parts.join('\n');
}

function extractPatchText(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const fenced = text.match(/```(?:diff|patch)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  return text;
}

function toTokenUsage(totalTokens?: number): TokenUsage | null {
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) return null;
  return {
    input_tokens: null,
    output_tokens: null,
    cache_tokens: null,
    total_tokens: Math.round(totalTokens),
    latency_ms: null,
  };
}

export async function generateSWEPredictions(opts: SWEGenerateOptions): Promise<SWEGenerateResult> {
  const instances = loadInstances(opts.casesFile);
  const selected = typeof opts.maxInstances === 'number' && opts.maxInstances > 0
    ? instances.slice(0, opts.maxInstances)
    : instances;

  const { adapter } = createAgentRuntime(opts.adapter);
  const predictions: SWEPrediction[] = [];
  const tasks: TaskResult[] = [];
  const dockerAvailable = isDockerAvailable();
  const contextEnabled = dockerAvailable;

  if (!contextEnabled) {
    console.log('[swe-gen] docker not available, fallback to prompt-only generation');
  }

  await adapter.init({
    run_id: `swe-generate-${Date.now()}`,
    benchmark: 'swe' as BenchmarkId,
    dataset: 'swe-bench-verified',
    seed: opts.seed,
    timeout_ms: opts.timeoutMs,
    model: opts.model,
    agent_config: {},
  });

  try {
    for (const inst of selected) {
      const t0 = Date.now();
      try {
        let prompt = buildPrompt(inst);
        if (contextEnabled) {
          const imageName = getSWEBenchImageName(inst.instance_id, opts.imageNamespace);
          if (pullImage(imageName, opts.dockerProxy)) {
            const relevantPaths = extractRelevantPaths(inst.problem_statement, inst.hints_text);
            const selectedPaths = relevantPaths.slice(0, 6);
            if (selectedPaths.length > 0) {
              const files = readFilesFromImage(imageName, selectedPaths);
              const fileCount = Object.keys(files).length;
              if (fileCount > 0) {
                prompt = buildPromptWithContext(inst, files);
                console.log(`[swe-gen] ${inst.instance_id}: loaded ${fileCount} context files`);
              } else {
                console.log(`[swe-gen] ${inst.instance_id}: no readable context files, fallback to prompt-only`);
              }
            } else {
              console.log(`[swe-gen] ${inst.instance_id}: no candidate file paths from statement/hints`);
            }
          } else {
            console.log(`[swe-gen] ${inst.instance_id}: image pull failed for context, fallback to prompt-only`);
          }
        }

        const output = await adapter.step({
          task_id: inst.instance_id,
          turn_id: 1,
          observation: {
            messages: [{ role: 'user', content: prompt }],
            state: {
              repo: inst.repo,
              base_commit: inst.base_commit,
              test_command: inst.test_command,
            },
            tools: [],
          },
          allowed_actions: ['final_answer', 'no_op'],
          deadline_ms: opts.timeoutMs,
          state: {},
        });

        if (output.error) {
          const duration = Date.now() - t0;
          const tokenTotal = output.usage?.total_tokens ?? undefined;
          tasks.push({
            task_id: inst.instance_id,
            passed: false,
            score: 0,
            duration_ms: duration,
            error_code: `ADAPTER_${output.error.code}`,
            token_usage: toTokenUsage(tokenTotal),
          });
          console.log(
            `[swe-gen] ${inst.instance_id}: adapter error (${output.error.code}: ${output.error.message})`,
          );
          continue;
        }

        if (output.action.type !== 'final_answer') {
          const duration = Date.now() - t0;
          const tokenTotal = output.usage?.total_tokens ?? undefined;
          tasks.push({
            task_id: inst.instance_id,
            passed: false,
            score: 0,
            duration_ms: duration,
            error_code: 'INVALID_ACTION',
            token_usage: toTokenUsage(tokenTotal),
          });
          console.log(`[swe-gen] ${inst.instance_id}: invalid action (${output.action.type})`);
          continue;
        }

        const patch = output.action.type === 'final_answer'
          ? extractPatchText(output.action.content || '')
          : '';
        const tokenTotal = output.usage?.total_tokens ?? undefined;
        const duration = Date.now() - t0;

        if (patch.trim().length > 0) {
          predictions.push({
            instance_id: inst.instance_id,
            patch,
            tokens_used: typeof tokenTotal === 'number' ? Math.round(tokenTotal) : undefined,
          });
          tasks.push({
            task_id: inst.instance_id,
            passed: true,
            score: 1,
            duration_ms: duration,
            token_usage: toTokenUsage(tokenTotal),
          });
          console.log(`[swe-gen] ${inst.instance_id}: patch generated`);
        } else {
          tasks.push({
            task_id: inst.instance_id,
            passed: false,
            score: 0,
            duration_ms: duration,
            error_code: 'EMPTY_PATCH',
            token_usage: toTokenUsage(tokenTotal),
          });
          console.log(`[swe-gen] ${inst.instance_id}: empty patch`);
        }
      } catch (err: any) {
        tasks.push({
          task_id: inst.instance_id,
          passed: false,
          score: 0,
          duration_ms: Date.now() - t0,
          error_code: 'GENERATION_ERROR',
          token_usage: null,
        });
        console.log(`[swe-gen] ${inst.instance_id}: generation error (${err?.message || String(err)})`);
      }
    }
  } finally {
    await adapter.close();
  }

  ensureParentDir(opts.outputFile);
  fs.writeFileSync(path.resolve(process.cwd(), opts.outputFile), JSON.stringify(predictions, null, 2), 'utf-8');

  return {
    dataset: 'swe-bench-verified',
    outputFile: opts.outputFile,
    predictions,
    tasks,
  };
}
