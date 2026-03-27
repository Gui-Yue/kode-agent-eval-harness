import fs from 'fs';
import path from 'path';

import {
  Agent,
  type ContentBlock,
  type Message,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
  builtin,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  type ModelProvider,
  type ModelResponse,
  type ModelStreamChunk,
} from '@shareai-lab/kode-sdk';

type CompletionOptions = Parameters<ModelProvider['complete']>[1];

type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'glm' | 'minimax';

interface CliArgs {
  instruction: string;
  modelName: string;
  workDir: string;
  storeDir: string;
  outputPath: string;
}

interface BenchResult {
  ok: boolean;
  status?: string;
  text?: string;
  rounds?: number;
  elapsedMs: number;
  workDir: string;
  storeDir: string;
  modelName: string;
  gitStatus?: string;
  gitDiffStat?: string;
  gitDiffNameOnly?: string[];
  monitorErrors?: Array<{
    severity: 'info' | 'warn' | 'error';
    phase: 'model' | 'tool' | 'system' | 'lifecycle';
    message: string;
    detail?: any;
  }>;
  error?: string;
  stack?: string;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterRatio: number;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, next);
    i += 1;
  }

  const workDir = path.resolve(values.get('workdir') || process.cwd());
  const storeDir = path.resolve(values.get('store-dir') || path.join(workDir, '.kode-bench'));
  const outputPath = path.resolve(values.get('output') || process.env.KODE_BENCH_OUTPUT_PATH || path.join(storeDir, 'result.json'));
  const instruction = values.get('instruction') || process.env.KODE_BENCH_INSTRUCTION;
  const modelName = values.get('model-name') || process.env.KODE_BENCH_MODEL_NAME;

  if (!instruction) {
    throw new Error('Missing benchmark instruction. Pass --instruction or set KODE_BENCH_INSTRUCTION.');
  }
  if (!modelName) {
    throw new Error('Missing model name. Pass --model-name in provider/model format.');
  }

  return {
    instruction,
    modelName,
    workDir,
    storeDir,
    outputPath,
  };
}

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : undefined;
}

function parseJsonEnv(key: string): Record<string, any> | undefined {
  const value = readEnv(key);
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readNumberEnv(key: string, fallback: number): number {
  const value = readEnv(key);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isMeaningfulText(text?: string): boolean {
  if (!text) return false;
  const normalized = text.trim();
  if (!normalized) return false;

  const lowSignalPrefixes = [
    "i'll investigate",
    'i will investigate',
    "i'll analyze",
    'i will analyze',
    "let me start",
    'let me first',
    'let me look',
    'let me search',
    'let me inspect',
    'now i understand',
  ];

  const lower = normalized.toLowerCase();
  if (lowSignalPrefixes.some((prefix) => lower.startsWith(prefix))) {
    return false;
  }

  return true;
}

function hasMeaningfulDiff(diagnostics: Pick<BenchResult, 'gitDiffNameOnly'>): boolean {
  return Boolean(diagnostics.gitDiffNameOnly && diagnostics.gitDiffNameOnly.length > 0);
}

function hasFatalMonitorErrors(errors?: BenchResult['monitorErrors']): boolean {
  return Boolean(errors?.some((event) => event.severity === 'error'));
}

function summarizeMonitorErrors(errors?: BenchResult['monitorErrors']): string | undefined {
  if (!errors || errors.length === 0) return undefined;
  return errors.map((event) => `[${event.phase}/${event.severity}] ${event.message}`).join('\n');
}

function readRetryConfig(): RetryConfig {
  return {
    maxAttempts: Math.max(1, Math.floor(readNumberEnv('KODE_BENCH_RETRY_MAX_ATTEMPTS', 8))),
    initialDelayMs: Math.max(0, Math.floor(readNumberEnv('KODE_BENCH_RETRY_INITIAL_DELAY_MS', 4000))),
    maxDelayMs: Math.max(0, Math.floor(readNumberEnv('KODE_BENCH_RETRY_MAX_DELAY_MS', 60000))),
    backoffMultiplier: Math.max(1, readNumberEnv('KODE_BENCH_RETRY_BACKOFF_MULTIPLIER', 2)),
    jitterRatio: Math.max(0, readNumberEnv('KODE_BENCH_RETRY_JITTER_RATIO', 0.2)),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function classifyRetryableError(error: unknown): { retryable: boolean; reason?: string } {
  const message = describeError(error);
  const statusMatch = message.match(/\b(?:OpenAI|Anthropic|Gemini) API error:\s*(\d{3})\b/i);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : undefined;

  if (statusCode !== undefined) {
    if ([408, 409, 425, 429].includes(statusCode) || statusCode >= 500) {
      return { retryable: true, reason: `http_${statusCode}` };
    }
    return { retryable: false, reason: `http_${statusCode}` };
  }

  const transientNeedles = [
    'rate limit',
    '速率限制',
    'timeout',
    'timed out',
    'temporarily unavailable',
    'temporary failure',
    'connection reset',
    'socket hang up',
    'econnreset',
    'etimedout',
    'eai_again',
    'fetch failed',
    'network error',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
  ];
  const lower = message.toLowerCase();
  if (transientNeedles.some((needle) => lower.includes(needle))) {
    return { retryable: true, reason: 'transient_network_or_provider_error' };
  }

  return { retryable: false };
}

function isGlmMessageShapeError(error: unknown): boolean {
  const message = describeError(error);
  return message.includes('"code":"1214"') || message.includes('messages 参数非法');
}

function stringifyBenchValue(value: any): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value ?? {});
    return serialized === undefined ? '{}' : serialized;
  } catch {
    return '{}';
  }
}

function flattenMessagesForGlmFallback(messages: Message[]): Message[] {
  const toolCallNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolCallNames.set(block.id, block.name);
      }
    }
  }

  return messages.map((message) => {
    const flattened: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        flattened.push(block);
        continue;
      }
      if (block.type === 'reasoning') {
        flattened.push({ type: 'text', text: `<think>${block.reasoning}</think>` });
        continue;
      }
      if (block.type === 'tool_use' && message.role === 'assistant') {
        flattened.push({
          type: 'text',
          text: `[tool_call ${block.name}] ${stringifyBenchValue(block.input ?? {})}`,
        });
        continue;
      }
      if (block.type === 'tool_result' && message.role === 'user') {
        const toolName = toolCallNames.get(block.tool_use_id);
        const label = toolName ? `[tool_result ${toolName}]` : `[tool_result ${block.tool_use_id}]`;
        flattened.push({
          type: 'text',
          text: `${label} ${stringifyBenchValue(block.content)}`,
        });
        continue;
      }
      if (block.type === 'image') {
        flattened.push({
          type: 'text',
          text: '[image unsupported in benchmark GLM fallback]',
        });
        continue;
      }
      if (block.type === 'audio') {
        flattened.push({
          type: 'text',
          text: '[audio unsupported in benchmark GLM fallback]',
        });
        continue;
      }
      if (block.type === 'video') {
        flattened.push({
          type: 'text',
          text: '[video unsupported in benchmark GLM fallback]',
        });
        continue;
      }
      if (block.type === 'file') {
        flattened.push({
          type: 'text',
          text: '[file unsupported in benchmark GLM fallback]',
        });
      }
    }

    return {
      ...message,
      content: flattened,
      metadata: undefined,
    };
  });
}

class GlmBenchFallbackProvider implements ModelProvider {
  readonly model: string;
  readonly maxWindowSize: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;

  constructor(private readonly inner: ModelProvider) {
    this.model = inner.model;
    this.maxWindowSize = inner.maxWindowSize;
    this.maxOutputTokens = inner.maxOutputTokens;
    this.temperature = inner.temperature;
  }

  async complete(messages: Parameters<ModelProvider['complete']>[0], opts?: CompletionOptions): Promise<ModelResponse> {
    try {
      return await this.inner.complete(messages, opts);
    } catch (error) {
      if (!isGlmMessageShapeError(error)) {
        throw error;
      }

      console.warn('[bench/glm-fallback] Retrying with flattened text-only history after 1214.');
      return this.inner.complete(flattenMessagesForGlmFallback(messages), opts);
    }
  }

  async *stream(messages: Parameters<ModelProvider['stream']>[0], opts?: CompletionOptions): AsyncIterable<ModelStreamChunk> {
    try {
      for await (const chunk of this.inner.stream(messages, opts)) {
        yield chunk;
      }
    } catch (error) {
      if (!isGlmMessageShapeError(error)) {
        throw error;
      }

      console.warn('[bench/glm-fallback] Retrying stream with flattened text-only history after 1214.');
      for await (const chunk of this.inner.stream(flattenMessagesForGlmFallback(messages), opts)) {
        yield chunk;
      }
    }
  }

  async uploadFile(input: Parameters<NonNullable<ModelProvider['uploadFile']>>[0]) {
    return this.inner.uploadFile ? this.inner.uploadFile(input) : null;
  }

  toConfig() {
    const config = this.inner.toConfig();
    return {
      ...config,
      providerOptions: {
        ...(config.providerOptions || {}),
        benchGlmFallback: 'flatten-history-on-1214',
      },
    };
  }
}

class RetryingProvider implements ModelProvider {
  readonly model: string;
  readonly maxWindowSize: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;

  constructor(
    private readonly inner: ModelProvider,
    private readonly retry: RetryConfig
  ) {
    this.model = inner.model;
    this.maxWindowSize = inner.maxWindowSize;
    this.maxOutputTokens = inner.maxOutputTokens;
    this.temperature = inner.temperature;
  }

  private computeDelayMs(attempt: number): number {
    if (attempt <= 1) {
      return this.retry.initialDelayMs;
    }

    const baseDelay = Math.min(
      this.retry.maxDelayMs,
      this.retry.initialDelayMs * this.retry.backoffMultiplier ** (attempt - 1)
    );
    if (this.retry.jitterRatio <= 0) {
      return Math.floor(baseDelay);
    }

    const jitterWindow = baseDelay * this.retry.jitterRatio;
    const randomized = baseDelay - jitterWindow + Math.random() * jitterWindow * 2;
    return Math.max(0, Math.floor(randomized));
  }

  private async runWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 1;
    while (true) {
      try {
        return await fn();
      } catch (error) {
        const classification = classifyRetryableError(error);
        if (!classification.retryable || attempt >= this.retry.maxAttempts) {
          throw error;
        }

        const delayMs = this.computeDelayMs(attempt);
        console.warn(
          [
            `[bench/retry] ${label} attempt ${attempt}/${this.retry.maxAttempts} failed.`,
            `reason=${classification.reason || 'retryable_error'}`,
            `waiting=${delayMs}ms`,
            `message=${describeError(error)}`,
          ].join(' ')
        );
        await sleep(delayMs);
        attempt += 1;
      }
    }
  }

  async complete(messages: Parameters<ModelProvider['complete']>[0], opts?: CompletionOptions): Promise<ModelResponse> {
    return this.runWithRetry('complete', () => this.inner.complete(messages, opts));
  }

  async *stream(messages: Parameters<ModelProvider['stream']>[0], opts?: CompletionOptions): AsyncIterable<ModelStreamChunk> {
    let attempt = 1;
    while (true) {
      let emittedChunk = false;
      try {
        for await (const chunk of this.inner.stream(messages, opts)) {
          emittedChunk = true;
          yield chunk;
        }
        return;
      } catch (error) {
        const classification = classifyRetryableError(error);
        if (emittedChunk || !classification.retryable || attempt >= this.retry.maxAttempts) {
          throw error;
        }

        const delayMs = this.computeDelayMs(attempt);
        console.warn(
          [
            `[bench/retry] stream attempt ${attempt}/${this.retry.maxAttempts} failed before first chunk.`,
            `reason=${classification.reason || 'retryable_error'}`,
            `waiting=${delayMs}ms`,
            `message=${describeError(error)}`,
          ].join(' ')
        );
        await sleep(delayMs);
        attempt += 1;
      }
    }
  }

  async uploadFile(input: Parameters<NonNullable<ModelProvider['uploadFile']>>[0]) {
    return this.inner.uploadFile ? this.inner.uploadFile(input) : null;
  }

  toConfig() {
    return this.inner.toConfig();
  }
}

function parseModelName(modelName: string): { provider: ProviderId; model: string } {
  const slash = modelName.indexOf('/');
  if (slash === -1) {
    throw new Error(`Model name must be in provider/model format. Received: ${modelName}`);
  }
  const provider = modelName.slice(0, slash).trim().toLowerCase() as ProviderId;
  const model = modelName.slice(slash + 1).trim();
  if (!provider || !model) {
    throw new Error(`Invalid model name: ${modelName}`);
  }
  if (!['anthropic', 'openai', 'gemini', 'glm', 'minimax'].includes(provider)) {
    throw new Error(`Unsupported provider prefix: ${provider}`);
  }
  return { provider, model };
}

function resolveEnvPrefix(provider: ProviderId): string {
  if (provider === 'glm') {
    return 'OPENAI';
  }
  return provider.toUpperCase();
}

function shouldUseNonStreamingProvider(modelName: string): boolean {
  const mode = (readEnv('KODE_BENCH_STREAMING_MODE') || 'auto').toLowerCase();
  if (mode === 'never' || mode === 'stream') {
    return false;
  }
  if (mode === 'always' || mode === 'non-stream') {
    return true;
  }

  const { provider } = parseModelName(modelName);
  return provider === 'glm';
}

class NonStreamingProvider implements ModelProvider {
  readonly model: string;
  readonly maxWindowSize: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;

  constructor(private readonly inner: ModelProvider) {
    this.model = inner.model;
    this.maxWindowSize = inner.maxWindowSize;
    this.maxOutputTokens = inner.maxOutputTokens;
    this.temperature = inner.temperature;
  }

  async complete(messages: Parameters<ModelProvider['complete']>[0], opts?: CompletionOptions): Promise<ModelResponse> {
    return this.inner.complete(messages, opts);
  }

  async *stream(messages: Parameters<ModelProvider['stream']>[0], opts?: CompletionOptions): AsyncIterable<ModelStreamChunk> {
    const response = await this.inner.complete(messages, opts);
    let index = 0;

    for (const block of response.content) {
      if (block.type === 'text') {
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
        if (block.text) {
          yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
        }
        yield { type: 'content_block_stop', index };
        index += 1;
        continue;
      }

      if (block.type === 'reasoning') {
        yield { type: 'content_block_start', index, content_block: { type: 'reasoning', reasoning: '' } };
        if (block.reasoning) {
          yield { type: 'content_block_delta', index, delta: { type: 'reasoning_delta', text: block.reasoning } };
        }
        yield { type: 'content_block_stop', index };
        index += 1;
        continue;
      }

      if (block.type === 'tool_use') {
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          },
        };
        const serializedInput = JSON.stringify(block.input ?? {});
        if (serializedInput) {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: serializedInput },
          };
        }
        yield { type: 'content_block_stop', index };
        index += 1;
      }
    }

    if (response.usage) {
      yield {
        type: 'message_delta',
        usage: {
          input_tokens: response.usage.input_tokens ?? 0,
          output_tokens: response.usage.output_tokens ?? 0,
        },
      };
    }

    yield { type: 'message_stop' };
  }

  async uploadFile(input: Parameters<NonNullable<ModelProvider['uploadFile']>>[0]) {
    return this.inner.uploadFile ? this.inner.uploadFile(input) : null;
  }

  toConfig() {
    const config = this.inner.toConfig();
    return {
      ...config,
      providerOptions: {
        ...(config.providerOptions || {}),
        benchStreamingMode: 'non-stream',
      },
    };
  }
}

function createProvider(modelName: string): ModelProvider {
  const { provider, model } = parseModelName(modelName);
  const prefix = resolveEnvPrefix(provider);
  const apiKey = readEnv(`${prefix}_API_KEY`);
  const baseUrl = readEnv(`${prefix}_BASE_URL`);
  const proxyUrl = readEnv(`${prefix}_PROXY_URL`);
  const extraHeaders = parseJsonEnv(`${prefix}_EXTRA_HEADERS`);
  const extraBody = parseJsonEnv(`${prefix}_EXTRA_BODY`);
  const openaiApi = readEnv(`${prefix}_API`);

  if (!apiKey) {
    throw new Error(`Missing ${prefix}_API_KEY`);
  }

  if (provider === 'anthropic') {
    return new AnthropicProvider(apiKey, model, baseUrl, proxyUrl, {
      extraHeaders,
      extraBody,
    });
  }

  if (provider === 'gemini') {
    return new GeminiProvider(apiKey, model, baseUrl, proxyUrl, {
      extraHeaders,
      extraBody,
    });
  }

  if (provider === 'openai') {
    return new OpenAIProvider(apiKey, model, baseUrl, proxyUrl, {
      api: openaiApi === 'responses' ? 'responses' : 'chat',
      extraHeaders,
      extraBody,
    });
  }

  if (!baseUrl) {
    throw new Error(`${prefix}_BASE_URL is required for ${provider}`);
  }

  if (provider === 'glm') {
    return new OpenAIProvider(apiKey, model, baseUrl, proxyUrl, {
      api: openaiApi === 'responses' ? 'responses' : 'chat',
      extraHeaders,
      extraBody,
    });
  }

  return new OpenAIProvider(apiKey, model, baseUrl, proxyUrl, {
    reasoningTransport: 'provider',
    reasoning: {
      fieldName: 'reasoning_details',
      requestParams: { reasoning_split: true },
    },
    extraHeaders,
    extraBody,
  });
}

function registerBenchTools(registry: ToolRegistry): string[] {
  const toolInstances = [...builtin.fs(), ...builtin.bash(), ...builtin.todo()].filter(Boolean);
  for (const tool of toolInstances) {
    registry.register(tool.name, () => tool);
  }
  return toolInstances.map((tool) => tool.name);
}

async function collectGitDiagnostics(agent: Agent): Promise<Pick<BenchResult, 'gitStatus' | 'gitDiffStat' | 'gitDiffNameOnly'>> {
  const sandbox = (agent as any).sandbox;
  if (!sandbox?.exec) {
    return {};
  }

  const [status, diffStat, diffNameOnly] = await Promise.all([
    sandbox.exec('git status --short', { timeoutMs: 20000 }).catch(() => ({ stdout: '', stderr: '', code: 1 })),
    sandbox.exec('git diff --stat', { timeoutMs: 20000 }).catch(() => ({ stdout: '', stderr: '', code: 1 })),
    sandbox.exec('git diff --name-only', { timeoutMs: 20000 }).catch(() => ({ stdout: '', stderr: '', code: 1 })),
  ]);

  return {
    gitStatus: status.stdout.trim() || status.stderr.trim() || undefined,
    gitDiffStat: diffStat.stdout.trim() || diffStat.stderr.trim() || undefined,
    gitDiffNameOnly: diffNameOnly.stdout
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean),
  };
}

function ensureDirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function writeResult(outputPath: string, result: BenchResult): Promise<void> {
  ensureDirFor(outputPath);
  await fs.promises.writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDirFor(args.outputPath);
  fs.mkdirSync(args.storeDir, { recursive: true });

  const provider = createProvider(args.modelName);
  const reliableProvider = new RetryingProvider(provider, readRetryConfig());
  const fallbackProvider = parseModelName(args.modelName).provider === 'glm'
    ? new GlmBenchFallbackProvider(reliableProvider)
    : reliableProvider;
  const model = shouldUseNonStreamingProvider(args.modelName)
    ? new NonStreamingProvider(fallbackProvider)
    : fallbackProvider;
  const store = new JSONStore(args.storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();
  const toolNames = registerBenchTools(tools);

  templates.register({
    id: 'kode-benchmark',
    systemPrompt: [
      'You are an autonomous software engineer working inside a benchmark task environment.',
      'Use the available filesystem and bash tools to inspect code, edit files, and run targeted verification.',
      'Do not stop at high-level analysis. If you have not used tools or changed files yet, continue working.',
      'Read relevant files before changing them.',
      'Prefer minimal patches that solve the task correctly.',
      'Before finishing, run the most relevant tests or checks you can afford.',
      'Keep the final answer brief and include what changed and what you verified.',
    ].join(' '),
    tools: toolNames,
    permission: { mode: 'auto' },
    runtime: {
      todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 8 },
    },
  });

  const agent = await Agent.create(
    {
      templateId: 'kode-benchmark',
      model,
      sandbox: {
        kind: 'local',
        workDir: args.workDir,
        enforceBoundary: true,
        watchFiles: false,
      },
    },
    {
      store,
      templateRegistry: templates,
      sandboxFactory,
      toolRegistry: tools,
    }
  );

  const start = Date.now();
  const maxRounds = Number.parseInt(process.env.KODE_BENCH_MAX_ROUNDS || '4', 10);
  const monitorErrors: NonNullable<BenchResult['monitorErrors']> = [];
  const stopMonitoring = agent.on('error', (event) => {
    monitorErrors.push({
      severity: event.severity,
      phase: event.phase,
      message: event.message,
      detail: event.detail,
    });
  });

  try {
    let reply = await agent.chat(args.instruction);
    let diagnostics = await collectGitDiagnostics(agent);
    let rounds = 1;

    while (
      reply.status === 'ok' &&
      rounds < maxRounds &&
      !hasFatalMonitorErrors(monitorErrors) &&
      !hasMeaningfulDiff(diagnostics) &&
      !isMeaningfulText(reply.text)
    ) {
      reply = await agent.chat(
        [
          'You have not made any file changes yet.',
          'Do not stop at analysis.',
          'Use the filesystem and bash tools now to inspect the repository, edit the necessary files, and run a targeted verification command before you finish.',
        ].join(' ')
      );
      diagnostics = await collectGitDiagnostics(agent);
      rounds += 1;
    }

    const result: BenchResult = {
      ok: reply.status === 'ok' && !hasFatalMonitorErrors(monitorErrors),
      status: hasFatalMonitorErrors(monitorErrors) ? 'error' : reply.status,
      text: reply.text,
      rounds,
      elapsedMs: Date.now() - start,
      workDir: args.workDir,
      storeDir: args.storeDir,
      modelName: args.modelName,
      monitorErrors: monitorErrors.length > 0 ? monitorErrors : undefined,
      error: summarizeMonitorErrors(monitorErrors),
      stack: monitorErrors.find((event) => typeof event.detail?.stack === 'string')?.detail?.stack,
      ...diagnostics,
    };
    await writeResult(args.outputPath, result);
    if (reply.text) {
      process.stdout.write(`${reply.text}\n`);
    }
    process.exitCode = result.ok ? 0 : 2;
  } catch (error: any) {
    const diagnostics = await collectGitDiagnostics(agent).catch(() => ({}));
    const result: BenchResult = {
      ok: false,
      elapsedMs: Date.now() - start,
      workDir: args.workDir,
      storeDir: args.storeDir,
      modelName: args.modelName,
      error: error?.message || String(error),
      stack: error?.stack,
      ...diagnostics,
    };
    await writeResult(args.outputPath, result);
    throw error;
  } finally {
    stopMonitoring();
    await (agent as any).sandbox?.dispose?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
