import fs from 'fs';
import path from 'path';

import {
  type Message,
  type ContentBlock,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  type ModelProvider,
  type ModelResponse,
} from '@shareai-lab/kode-sdk';

type CompletionOptions = Parameters<ModelProvider['complete']>[1];

type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'glm' | 'minimax';

interface CliArgs {
  modelName: string;
  messagesFile: string;
  toolsFile: string;
  outputPath: string;
  temperature?: number;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterRatio: number;
}

interface StepResult {
  ok: boolean;
  action?: {
    type: 'tool_call' | 'respond';
    tool_call?: {
      id: string;
      name: string;
      arguments: Record<string, any>;
    };
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: string;
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

  const modelName = values.get('model-name');
  const messagesFile = values.get('messages-file');
  const toolsFile = values.get('tools-file');
  const outputPath = values.get('output');
  const temperatureValue = values.get('temperature');

  if (!modelName) throw new Error('Missing --model-name');
  if (!messagesFile) throw new Error('Missing --messages-file');
  if (!toolsFile) throw new Error('Missing --tools-file');
  if (!outputPath) throw new Error('Missing --output');

  return {
    modelName,
    messagesFile: path.resolve(messagesFile),
    toolsFile: path.resolve(toolsFile),
    outputPath: path.resolve(outputPath),
    temperature: temperatureValue ? Number(temperatureValue) : undefined,
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

function classifyRetryableError(error: unknown): { retryable: boolean } {
  const message = describeError(error).toLowerCase();
  if (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('速率限制') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('temporarily unavailable') ||
    message.includes('network error') ||
    message.includes('fetch failed') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    message.includes('service unavailable')
  ) {
    return { retryable: true };
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

  async complete(messages: Message[], opts?: CompletionOptions): Promise<ModelResponse> {
    try {
      return await this.inner.complete(messages, opts);
    } catch (error) {
      if (!isGlmMessageShapeError(error)) {
        throw error;
      }
      return this.inner.complete(flattenMessagesForGlmFallback(messages), opts);
    }
  }

  async *stream() {
    throw new Error('stream() is not used in tau step runner');
  }

  async uploadFile(input: Parameters<NonNullable<ModelProvider['uploadFile']>>[0]) {
    return this.inner.uploadFile ? this.inner.uploadFile(input) : null;
  }

  toConfig() {
    return this.inner.toConfig();
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
    const jitterWindow = baseDelay * this.retry.jitterRatio;
    const randomized = baseDelay - jitterWindow + Math.random() * jitterWindow * 2;
    return Math.max(0, Math.floor(randomized));
  }

  async complete(messages: Message[], opts?: CompletionOptions): Promise<ModelResponse> {
    let attempt = 1;
    while (true) {
      try {
        return await this.inner.complete(messages, opts);
      } catch (error) {
        if (!classifyRetryableError(error).retryable || attempt >= this.retry.maxAttempts) {
          throw error;
        }
        await sleep(this.computeDelayMs(attempt));
        attempt += 1;
      }
    }
  }

  async *stream() {
    throw new Error('stream() is not used in tau step runner');
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
  return { provider, model };
}

function resolveEnvPrefix(provider: ProviderId): string {
  if (provider === 'glm') {
    return 'OPENAI';
  }
  return provider.toUpperCase();
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

  return new OpenAIProvider(apiKey, model, baseUrl, proxyUrl, {
    api: openaiApi === 'responses' ? 'responses' : 'chat',
    extraHeaders,
    extraBody,
  });
}

function loadJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function convertMessages(rawMessages: any[]): Message[] {
  return rawMessages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id || message.name || 'tool',
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
          },
        ],
      };
    }

    const content: ContentBlock[] = [];
    if (typeof message.content === 'string' && message.content) {
      content.push({ type: 'text', text: message.content });
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        let input: any = {};
        const rawArguments = call?.function?.arguments;
        if (typeof rawArguments === 'string') {
          try {
            input = JSON.parse(rawArguments);
          } catch {
            input = { raw: rawArguments };
          }
        } else if (rawArguments && typeof rawArguments === 'object') {
          input = rawArguments;
        }
        content.push({
          type: 'tool_use',
          id: call?.id || `${call?.function?.name || 'tool'}-call`,
          name: call?.function?.name || 'tool',
          input,
        });
      }
    }

    return {
      role: message.role,
      content,
    };
  });
}

function convertTools(rawTools: any[]): any[] {
  return rawTools.map((tool) => ({
    name: tool?.function?.name || tool?.name,
    description: tool?.function?.description || tool?.description || '',
    input_schema: tool?.function?.parameters || tool?.input_schema || { type: 'object', properties: {} },
  }));
}

function writeResult(outputPath: string, result: StepResult): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawMessages = loadJson(args.messagesFile);
  const rawTools = loadJson(args.toolsFile);
  const messages = convertMessages(rawMessages);
  const tools = convertTools(rawTools);

  const baseProvider = createProvider(args.modelName);
  const reliableProvider = new RetryingProvider(baseProvider, readRetryConfig());
  const provider = parseModelName(args.modelName).provider === 'glm'
    ? new GlmBenchFallbackProvider(reliableProvider)
    : reliableProvider;

  try {
    const response = await provider.complete(messages, {
      tools,
      temperature: args.temperature,
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (toolUse && toolUse.type === 'tool_use') {
      writeResult(args.outputPath, {
        ok: true,
        action: {
          type: 'tool_call',
          tool_call: {
            id: toolUse.id,
            name: toolUse.name,
            arguments: toolUse.input ?? {},
          },
        },
        usage: response.usage,
      });
      return;
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    if (!text) {
      throw new Error('Model response did not include a tool call or response text.');
    }

    writeResult(args.outputPath, {
      ok: true,
      action: {
        type: 'respond',
        text,
      },
      usage: response.usage,
    });
  } catch (error) {
    writeResult(args.outputPath, {
      ok: false,
      error: describeError(error),
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
