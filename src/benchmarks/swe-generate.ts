import fs from 'node:fs';
import path from 'node:path';
import { createAdapter } from '../adapters/registry';
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

  const adapter = createAdapter(opts.adapter);
  const predictions: SWEPrediction[] = [];
  const tasks: TaskResult[] = [];

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
        const output = await adapter.step({
          task_id: inst.instance_id,
          turn_id: 1,
          observation: {
            messages: [{ role: 'user', content: buildPrompt(inst) }],
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

        const patch = output.action.type === 'final_answer' ? (output.action.content || '') : '';
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
