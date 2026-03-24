import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createAgentRuntime } from '../agents/runtime';
import { runCockpitTurn, runWorkspaceTask } from '../cockpit/runtime';
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

interface SWEAgentRun {
  text: string;
  usageTotal: number;
  error: import('../types').AgentError | null;
  workspaceStatus?: string;
  workspaceTrace?: import('../cockpit/contracts').WorkspaceTaskTrace;
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
    'Start directly with "diff --git ..." or "--- a/...".',
    'Do not return shell commands, Python snippets, or analysis text.',
  );

  return parts.join('\n');
}

function buildWorkspacePrompt(inst: SWEInstance, workDir: string): string {
  const candidatePaths = extractRelevantPaths(inst.problem_statement, inst.hints_text).slice(0, 8);
  const parts = [
    'You are solving a SWE-bench instance inside a local repository workspace.',
    `Instance ID: ${inst.instance_id}`,
    `Repo: ${inst.repo}`,
    `Base commit: ${inst.base_commit}`,
    `Workspace: ${workDir}`,
    '',
    'Modify the repository files directly to fix the issue.',
    'Inspect the codebase, edit files in place, and run only minimal focused checks if your runtime supports it.',
    'Do not run the full test suite or long-running commands unless absolutely necessary.',
    'Prefer reading likely relevant files first, then making the smallest plausible fix.',
    'Do not return a git patch unless you are completely unable to modify the workspace directly.',
    'When you are done, return a short plain-text summary of what you changed.',
    '',
    'Problem statement:',
    inst.problem_statement,
  ];

  if (inst.hints_text) {
    parts.push('', 'Hints:', inst.hints_text);
  }

  if (candidatePaths.length > 0) {
    parts.push('', 'Likely relevant paths:', ...candidatePaths.map(p => `- ${p}`));
  }

  return parts.join('\n');
}

async function runSWEAgentOnce(
  adapter: ReturnType<typeof createAgentRuntime>['adapter'],
  inst: SWEInstance,
  prompt: string,
  runtimeState: Record<string, unknown>,
  deadlineMs: number,
  workspaceDir: string | null,
): Promise<SWEAgentRun> {
  if (workspaceDir) {
    const workspace = await runWorkspaceTask(adapter, {
      task_id: inst.instance_id,
      prompt,
      deadline_ms: deadlineMs,
      state: runtimeState,
      workdir: workspaceDir,
    });
    if (workspace) {
      return {
        text: workspace.text,
        usageTotal: workspace.usage?.total_tokens ?? 0,
        error: workspace.error ?? null,
        workspaceStatus: workspace.status,
        workspaceTrace: workspace.trace,
      };
    }
  }

  const output = await runCockpitTurn(adapter, {
    task_id: inst.instance_id,
    turn_id: 1,
    observation: {
      messages: [{ role: 'user', content: prompt }],
      state: runtimeState,
      tools: [],
    },
    allowed_actions: ['final_answer', 'no_op'],
    deadline_ms: deadlineMs,
    state: runtimeState,
  });

  if (output.error) {
    return {
      text: '',
      usageTotal: output.usage?.total_tokens ?? 0,
      error: output.error,
    };
  }

  if (output.action.type !== 'final_answer') {
    return {
      text: output.action.content || '',
      usageTotal: output.usage?.total_tokens ?? 0,
      error: {
        code: 'INVALID_ACTION',
        message: `invalid action (${output.action.type})`,
        retryable: false,
      },
    };
  }

  return {
    text: output.action.content || '',
    usageTotal: output.usage?.total_tokens ?? 0,
    error: null,
  };
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

function cleanupDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}

function materializeWorkspaceFromImage(imageName: string, workDir: string): { ok: boolean; error?: string } {
  cleanupDir(workDir);
  fs.mkdirSync(workDir, { recursive: true });

  const create = spawnSync('docker', ['create', imageName, 'bash', '-lc', 'exit 0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 60000,
  });

  if (create.status !== 0 || !create.stdout.trim()) {
    return {
      ok: false,
      error: `docker create failed (${create.status ?? 'unknown'}): ${(create.stderr || '').trim()}`,
    };
  }

  const containerId = create.stdout.trim();
  try {
    const copy = spawnSync('docker', ['cp', `${containerId}:/testbed/.`, workDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 900000,
    });

    if (copy.status !== 0) {
      return {
        ok: false,
        error: `docker cp failed (${copy.status ?? 'unknown'}): ${(copy.stderr || '').trim()}`,
      };
    }

    return { ok: true };
  } finally {
    spawnSync('docker', ['rm', '-f', containerId], {
      stdio: 'ignore',
      timeout: 60000,
    });
  }
}

function collectWorkspacePatch(workDir: string): string {
  const res = spawnSync(
    'git',
    ['-C', workDir, 'diff', '--binary', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 120000,
    },
  );

  if (res.status !== 0) {
    const err = (res.stderr || '').trim();
    if (err) {
      console.log(`[swe-gen] git diff failed in ${workDir}: ${err}`);
    }
    return '';
  }

  return extractPatchText(res.stdout || '');
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
    'Start directly with "diff --git ..." or "--- a/...".',
    'Do not return shell commands, Python snippets, or analysis text.',
    'Do not modify tests unless absolutely required by the issue.',
  );

  return parts.join('\n');
}

function selectPatchCandidate(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const fenced = [...trimmed.matchAll(/```(?:[a-z0-9_-]+)?\s*([\s\S]*?)```/gi)]
    .map(match => (match[1] || '').trim())
    .filter(Boolean);

  if (fenced.length === 0) return trimmed;

  const withPatchStart = fenced.findIndex(candidate => findPatchStart(candidate) >= 0);
  if (withPatchStart >= 0) return fenced[withPatchStart];
  return fenced.sort((a, b) => b.length - a.length)[0];
}

function findPatchStart(text: string): number {
  const markers = [/^diff --git\b/m, /^--- (?:a\/|\/dev\/null|\S+)/m, /^Index: \S+/m];
  const indexes = markers
    .map(pattern => {
      const match = pattern.exec(text);
      return match?.index ?? -1;
    })
    .filter(index => index >= 0);

  if (indexes.length === 0) return -1;
  return Math.min(...indexes);
}

function normalizePatchHeaders(text: string): string {
  return text
    .replace(/^--- (?!a\/|\/dev\/null)(\S.*)$/gm, '--- a/$1')
    .replace(/^\+\+\+ (?!b\/|\/dev\/null)(\S.*)$/gm, '+++ b/$1');
}

function formatHunkCount(count: number): string {
  return count === 1 ? '' : `,${count}`;
}

function recountUnifiedDiffHunkHeaders(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = hunkHeader.exec(line);
    if (!match) {
      out.push(line);
      i += 1;
      continue;
    }

    const oldStart = Number(match[1]);
    const newStart = Number(match[3]);
    const suffix = match[5] || '';

    let oldCount = 0;
    let newCount = 0;
    let j = i + 1;

    while (j < lines.length) {
      const bodyLine = lines[j];
      if (
        bodyLine.startsWith('@@ ') ||
        bodyLine === '@@' ||
        bodyLine.startsWith('diff --git ') ||
        bodyLine.startsWith('--- ') ||
        bodyLine.startsWith('Index: ')
      ) {
        break;
      }

      if (bodyLine.startsWith('-')) {
        oldCount += 1;
      } else if (bodyLine.startsWith('+')) {
        newCount += 1;
      } else if (bodyLine.startsWith(' ')) {
        oldCount += 1;
        newCount += 1;
      } else if (bodyLine.startsWith('\\ No newline at end of file')) {
        // metadata line, does not affect hunk counts
      } else if (bodyLine.length === 0) {
        // Preserve malformed empty body lines without changing counts.
      } else {
        // Keep unknown lines unchanged; downstream validation decides if the patch is still usable.
      }

      j += 1;
    }

    out.push(`@@ -${oldStart}${formatHunkCount(oldCount)} +${newStart}${formatHunkCount(newCount)} @@${suffix}`);
    for (let k = i + 1; k < j; k += 1) {
      out.push(lines[k]);
    }
    i = j;
  }

  return out.join('\n');
}

function isLikelyPatch(text: string): boolean {
  if (!text.trim()) return false;

  const hasDiffHeader = /^diff --git\b/m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text));
  const hasHunk = /^@@(?: .+)?@@/m.test(text);
  return hasDiffHeader && hasHunk;
}

function extractPatchText(raw: string): string {
  const candidate = selectPatchCandidate(raw).replace(/\r\n/g, '\n').trim();
  if (!candidate) return '';

  const patchStart = findPatchStart(candidate);
  if (patchStart < 0) return '';

  const sliced = candidate.slice(patchStart).trim();
  const normalized = recountUnifiedDiffHunkHeaders(normalizePatchHeaders(sliced));
  if (!isLikelyPatch(normalized)) return '';

  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function buildPatchRepairPrompt(inst: SWEInstance, rawOutput: string): string {
  const clipped = rawOutput.trim().slice(0, 12000);
  return [
    'Your previous answer was not a valid git unified diff patch.',
    `Instance ID: ${inst.instance_id}`,
    '',
    'Rewrite the solution as ONLY a valid git unified diff patch.',
    'Start directly with "diff --git ..." or "--- a/...".',
    'Do not include explanations, markdown fences, shell commands, or analysis text.',
    'If you cannot produce a valid patch, return an empty response.',
    '',
    'Previous answer:',
    clipped,
  ].join('\n');
}

function buildWorkspaceRepairPrompt(inst: SWEInstance, workDir: string, rawOutput: string): string {
  const clipped = rawOutput.trim().slice(0, 8000);
  return [
    'No repository changes were detected in the workspace after your previous turn.',
    `Instance ID: ${inst.instance_id}`,
    `Workspace: ${workDir}`,
    '',
    'You must modify files in the workspace directly.',
    'Do not just describe the fix.',
    'After editing the repository, reply with a short summary only.',
    '',
    'Previous answer:',
    clipped,
  ].join('\n');
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
      let workspaceDir: string | null = null;
      try {
        let prompt = buildPrompt(inst);
        let runtimeState: Record<string, unknown> = {
          repo: inst.repo,
          base_commit: inst.base_commit,
          test_command: inst.test_command,
        };

        if (contextEnabled) {
          const imageName = getSWEBenchImageName(inst.instance_id, opts.imageNamespace);
          if (pullImage(imageName, opts.dockerProxy)) {
            workspaceDir = path.resolve(
              process.cwd(),
              'tests/tmp/swe-workspaces',
              `${inst.instance_id}-${Date.now()}`,
            );
            const materialized = materializeWorkspaceFromImage(imageName, workspaceDir);
            if (materialized.ok) {
              prompt = buildWorkspacePrompt(inst, workspaceDir);
              runtimeState = {
                ...runtimeState,
                workdir: workspaceDir,
                repo_root: workspaceDir,
              };
              console.log(`[swe-gen] ${inst.instance_id}: workspace ready at ${workspaceDir}`);
            } else {
              console.log(`[swe-gen] ${inst.instance_id}: workspace setup failed, fallback to prompt-only (${materialized.error})`);
              cleanupDir(workspaceDir);
              workspaceDir = null;
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
            }
          } else {
            console.log(`[swe-gen] ${inst.instance_id}: image pull failed for context, fallback to prompt-only`);
          }
        }

        const output = await runSWEAgentOnce(
          adapter,
          inst,
          prompt,
          runtimeState,
          opts.timeoutMs,
          workspaceDir,
        );

        if (output.error) {
          const duration = Date.now() - t0;
          const tokenTotal = output.usageTotal || undefined;
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
        if (workspaceDir && output.workspaceTrace) {
          console.log(
            `[swe-gen] ${inst.instance_id}: workspace trace tools=${output.workspaceTrace.tool_calls} tool_errors=${output.workspaceTrace.tool_errors} approvals=${output.workspaceTrace.permission_requests} status=${output.workspaceTrace.final_status}`,
          );
        }

        let rawAnswer = output.text || '';
        let patch = workspaceDir ? collectWorkspacePatch(workspaceDir) : '';
        if (!patch) {
          patch = extractPatchText(rawAnswer);
        }
        let tokenTotal = output.usageTotal ?? 0;
        let repairAttempted = false;

        if (!patch && rawAnswer.trim()) {
          repairAttempted = true;
          const repairPrompt = workspaceDir
            ? buildWorkspaceRepairPrompt(inst, workspaceDir, rawAnswer)
            : buildPatchRepairPrompt(inst, rawAnswer);
          console.log(
            `[swe-gen] ${inst.instance_id}: ${workspaceDir ? 'no workspace diff' : 'invalid patch format'}, requesting retry`,
          );
          const repair = await runSWEAgentOnce(
            adapter,
            inst,
            repairPrompt,
            runtimeState,
            opts.timeoutMs,
            workspaceDir,
          );

          if (workspaceDir && repair.workspaceTrace) {
            console.log(
              `[swe-gen] ${inst.instance_id}: repair trace tools=${repair.workspaceTrace.tool_calls} tool_errors=${repair.workspaceTrace.tool_errors} approvals=${repair.workspaceTrace.permission_requests} status=${repair.workspaceTrace.final_status}`,
            );
          }

          if (!repair.error) {
            rawAnswer = repair.text || '';
            patch = workspaceDir ? collectWorkspacePatch(workspaceDir) : '';
            if (!patch) {
              patch = extractPatchText(rawAnswer);
            }
          }

          if (typeof repair.usageTotal === 'number' && Number.isFinite(repair.usageTotal)) {
            tokenTotal += repair.usageTotal;
          }
        }

        const tokenTotalMaybe = tokenTotal > 0 ? tokenTotal : undefined;
        const duration = Date.now() - t0;

        if (patch.trim().length > 0) {
          predictions.push({
            instance_id: inst.instance_id,
            patch,
            tokens_used: typeof tokenTotalMaybe === 'number' ? Math.round(tokenTotalMaybe) : undefined,
          });
          tasks.push({
            task_id: inst.instance_id,
            passed: true,
            score: 1,
            duration_ms: duration,
            token_usage: toTokenUsage(tokenTotalMaybe),
          });
          console.log(`[swe-gen] ${inst.instance_id}: patch generated`);
        } else {
          tasks.push({
            task_id: inst.instance_id,
            passed: false,
            score: 0,
            duration_ms: duration,
            error_code: repairAttempted ? (workspaceDir ? 'NO_WORKSPACE_DIFF' : 'INVALID_PATCH') : 'EMPTY_PATCH',
            token_usage: toTokenUsage(tokenTotalMaybe),
          });
          console.log(
            `[swe-gen] ${inst.instance_id}: ${
              repairAttempted ? (workspaceDir ? 'no workspace diff' : 'invalid patch') : 'empty patch'
            }`,
          );
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
      } finally {
        if (workspaceDir) {
          cleanupDir(workspaceDir);
        }
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
