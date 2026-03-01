import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import type { TaskResult } from '../types';

interface SWEInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  test_patch: string;
  test_command: string;
}

interface SWEPrediction {
  instance_id: string;
  patch: string;
  tokens_used?: number;
}

export interface SWEOfficialOptions {
  casesFile: string;
  predictionsFile: string;
  workDir: string;
  dockerProxy?: string;
  maxInstances?: number;
  imageNamespace?: string;
}

export interface SWEOfficialResult {
  dataset: string;
  tasks: TaskResult[];
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
    .replace(/__/g, normalizedNamespace ? '_1776_' : '__')
    .replace(/[^a-z0-9._-]/g, '_');

  const image = `sweb.eval.x86_64.${slug}:latest`;
  return normalizedNamespace ? `${normalizedNamespace}/${image}` : image;
}

function sanitizeContainerName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 128);
}

function pullImage(imageName: string, proxyUrl?: string): { ok: boolean; error?: string } {
  const inspect = spawnSync('docker', ['image', 'inspect', imageName], {
    stdio: 'ignore',
    timeout: 15000,
  });
  if (inspect.status === 0) {
    console.log(`  [swe] image ready ${imageName}`);
    return { ok: true };
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }

  console.log(`  [swe] pulling image ${imageName}`);
  const pull = spawnSync('docker', ['pull', imageName], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 1200000,
  });

  if (pull.status === 0) {
    console.log(`  [swe] image pulled ${imageName}`);
    return { ok: true };
  }

  return { ok: false, error: `docker pull failed with exit code ${pull.status}` };
}

function evaluateWithDocker(
  instance: SWEInstance,
  patch: string,
  workDir: string,
  imageNamespace?: string,
  proxyUrl?: string,
): { passed: boolean; error?: string; errorCode?: string } {
  const imageName = getSWEBenchImageName(instance.instance_id, imageNamespace);
  const pull = pullImage(imageName, proxyUrl);
  if (!pull.ok) {
    return { passed: false, errorCode: 'IMAGE_PULL_FAILED', error: pull.error || `failed to pull image ${imageName}` };
  }

  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'fix.patch'), patch, 'utf-8');
  if (instance.test_patch) {
    fs.writeFileSync(path.join(workDir, 'test.patch'), instance.test_patch, 'utf-8');
  }

  const script = [
    '#!/bin/bash',
    'set -uo pipefail',
    'source /opt/miniconda3/bin/activate',
    'conda activate testbed',
    'cd /testbed',
    'echo "[swe-docker] applying fix patch"',
    'if git apply --verbose /patches/fix.patch; then',
    '  echo "[swe-docker] fix patch applied"',
    'elif git apply --verbose --reject /patches/fix.patch; then',
    '  echo "[swe-docker] fix patch applied with reject"',
    'elif patch --batch --fuzz=5 -p1 -i /patches/fix.patch; then',
    '  echo "[swe-docker] fix patch applied with patch command"',
    'else',
    '  echo "[swe-docker] fix patch apply failed"',
    '  exit 81',
    'fi',
    'if [ -f /patches/test.patch ] && [ -s /patches/test.patch ]; then',
    '  git apply -v /patches/test.patch || true',
    'fi',
    `echo "[swe-docker] running: ${instance.test_command}"`,
    `if ${instance.test_command}; then`,
    '  echo "[swe-docker] tests passed"',
    'else',
    '  echo "[swe-docker] tests failed"',
    '  exit 82',
    'fi',
  ].join('\n');

  fs.writeFileSync(path.join(workDir, 'evaluate.sh'), script, 'utf-8');

  const containerName = sanitizeContainerName(`swe-${instance.instance_id}-${Date.now()}`);
  const run = spawnSync('docker', [
    'run', '--rm', '--name', containerName,
    '-v', `${workDir}:/patches:ro`,
    imageName,
    'bash', '/patches/evaluate.sh',
  ], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 900000,
  });

  if (run.status === 0) return { passed: true };

  if (run.status === 81) {
    return { passed: false, errorCode: 'PATCH_APPLY_FAILED', error: 'failed to apply patch' };
  }
  if (run.status === 82) {
    return { passed: false, errorCode: 'TEST_FAILED', error: 'test command failed' };
  }
  return { passed: false, errorCode: 'DOCKER_RUN_FAILED', error: `docker run exit code ${run.status}` };
}

function cleanupDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadInstances(casesFile: string): SWEInstance[] {
  const full = path.resolve(process.cwd(), casesFile);
  if (!fs.existsSync(full)) {
    throw new Error(`SWE cases file not found: ${full}`);
  }
  const arr = readJson(full);
  if (!Array.isArray(arr)) {
    throw new Error(`Invalid SWE cases file format: ${full}`);
  }
  return arr as SWEInstance[];
}

function loadPredictions(predictionsFile: string): Map<string, { patch: string; tokens?: number }> {
  const full = path.resolve(process.cwd(), predictionsFile);
  if (!fs.existsSync(full)) {
    throw new Error(`SWE predictions file not found: ${full}`);
  }
  const raw = readJson(full);

  const map = new Map<string, { patch: string; tokens?: number }>();

  if (Array.isArray(raw)) {
    for (const item of raw as SWEPrediction[]) {
      if (!item || typeof item.instance_id !== 'string' || typeof item.patch !== 'string') continue;
      map.set(item.instance_id, { patch: item.patch, tokens: item.tokens_used });
    }
    return map;
  }

  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
      if (typeof v === 'string') {
        map.set(k, { patch: v });
      } else if (v && typeof v === 'object' && typeof v.patch === 'string') {
        map.set(k, { patch: v.patch, tokens: typeof v.tokens_used === 'number' ? v.tokens_used : undefined });
      }
    }
    return map;
  }

  throw new Error(`Unsupported SWE predictions format: ${full}`);
}

export function runSWEOfficialBenchmark(opts: SWEOfficialOptions): SWEOfficialResult {
  if (!isDockerAvailable()) {
    throw new Error('Docker is required for SWE-bench-Verified official evaluation.');
  }

  const instances = loadInstances(opts.casesFile);
  const predictions = loadPredictions(opts.predictionsFile);
  const selected = typeof opts.maxInstances === 'number' && opts.maxInstances > 0
    ? instances.slice(0, opts.maxInstances)
    : instances;

  const tasks: TaskResult[] = [];

  console.log(`[swe] dataset: swe-bench-verified (${selected.length} instances)`);
  console.log(`[swe] image namespace: ${(opts.imageNamespace || 'swebench').trim() || '(local-only)'}`);
  for (const inst of selected) {
    const pred = predictions.get(inst.instance_id);
    if (!pred) {
      console.log(`[swe:${inst.instance_id}] no prediction`);
      tasks.push({
        task_id: inst.instance_id,
        passed: false,
        score: 0,
        duration_ms: 0,
        error_code: 'NO_PREDICTION',
        token_usage: null,
      });
      continue;
    }

    const start = Date.now();
    const instanceWorkDir = path.join(path.resolve(process.cwd(), opts.workDir), `${inst.instance_id}-${Date.now()}`);
    console.log(`[swe:${inst.instance_id}] evaluating`);
    try {
      const evalResult = evaluateWithDocker(inst, pred.patch, instanceWorkDir, opts.imageNamespace, opts.dockerProxy);
      const duration = Date.now() - start;
      if (evalResult.passed) {
        console.log(`[swe:${inst.instance_id}] PASS (${duration}ms)`);
      } else {
        console.log(`[swe:${inst.instance_id}] FAIL ${evalResult.errorCode || 'TEST_FAILED'} (${duration}ms)${evalResult.error ? ` - ${evalResult.error}` : ''}`);
      }
      tasks.push({
        task_id: inst.instance_id,
        passed: evalResult.passed,
        score: evalResult.passed ? 1 : 0,
        duration_ms: duration,
        error_code: evalResult.passed ? undefined : (evalResult.errorCode || 'TEST_FAILED'),
        token_usage: typeof pred.tokens === 'number'
          ? { input_tokens: null, output_tokens: null, cache_tokens: null, total_tokens: pred.tokens, latency_ms: null }
          : null,
      });
    } catch (err: any) {
      tasks.push({
        task_id: inst.instance_id,
        passed: false,
        score: 0,
        duration_ms: Date.now() - start,
        error_code: 'EVAL_ERROR',
        token_usage: typeof pred.tokens === 'number'
          ? { input_tokens: null, output_tokens: null, cache_tokens: null, total_tokens: pred.tokens, latency_ms: null }
          : null,
      });
      console.error(`[swe:${inst.instance_id}] ${err?.message || String(err)}`);
    } finally {
      cleanupDir(instanceWorkDir);
    }
  }

  return {
    dataset: 'swe-bench-verified',
    tasks,
  };
}
