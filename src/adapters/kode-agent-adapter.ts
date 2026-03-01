import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentAdapter } from './interface';
import type { AgentError, AgentMetadata, RunContext, StepInput, StepOutput } from '../types';

type AnyFn = (...args: any[]) => any;

type KodeSdkModule = {
  Agent: { create: AnyFn };
  JSONStore: new (dir: string) => unknown;
  AgentTemplateRegistry: new () => { register: AnyFn };
  ToolRegistry: new () => unknown;
  SandboxFactory: new () => unknown;
};

export interface KodeAgentAdapterOptions {
  autoInstall?: boolean;
  adapterId?: 'kode-agent' | 'kode-sdk';
}

const NORMALIZED_ERROR_CODES: ReadonlySet<AgentError['code']> = new Set([
  'TIMEOUT',
  'INVALID_ACTION',
  'RATE_LIMIT',
  'AUTH_ERROR',
  'ENV_ERROR',
  'UPSTREAM_ERROR',
  'INTERNAL_ERROR',
]);

class AdapterTimeoutError extends Error {
  constructor(ms: number) {
    super(`adapter step exceeded deadline (${ms}ms)`);
    this.name = 'AdapterTimeoutError';
  }
}

function sanitizeLabel(v: string): string {
  return v.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'run';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveModel(modelRaw: string): { provider: string; model: string } {
  const v = (modelRaw || '').trim();
  if (!v) return { provider: 'openai', model: 'gpt-4o-mini' };

  const slash = v.indexOf('/');
  if (slash > 0) {
    return { provider: v.slice(0, slash), model: v.slice(slash + 1) };
  }

  return { provider: 'openai', model: v };
}

function resolveProviderEnv(provider: string): { apiKey?: string; baseUrl?: string } {
  const p = provider.toLowerCase();

  if (p === 'anthropic') {
    return {
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.KODE_AGENT_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL || process.env.KODE_AGENT_BASE_URL,
    };
  }

  if (p === 'gemini') {
    return {
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.KODE_AGENT_API_KEY,
      baseUrl: process.env.GEMINI_BASE_URL || process.env.KODE_AGENT_BASE_URL,
    };
  }

  return {
    apiKey: process.env.OPENAI_API_KEY || process.env.KODE_AGENT_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.KODE_AGENT_BASE_URL,
  };
}

function normalizeError(err: unknown): AgentError {
  const anyErr = err as any;
  const msg = String(anyErr?.message || err || 'unknown adapter error');

  const explicitCode = anyErr?.code;
  if (typeof explicitCode === 'string' && NORMALIZED_ERROR_CODES.has(explicitCode as AgentError['code'])) {
    return {
      code: explicitCode as AgentError['code'],
      message: msg,
      retryable: explicitCode === 'RATE_LIMIT' || explicitCode === 'UPSTREAM_ERROR' || explicitCode === 'TIMEOUT',
    };
  }

  const m = msg.toLowerCase();

  if (err instanceof AdapterTimeoutError || m.includes('timeout') || m.includes('timed out')) {
    return { code: 'TIMEOUT', message: msg, retryable: true };
  }
  if (m.includes('rate limit') || m.includes('429')) {
    return { code: 'RATE_LIMIT', message: msg, retryable: true };
  }
  if (
    m.includes('api key') ||
    m.includes('unauthorized') ||
    m.includes('authentication') ||
    m.includes('forbidden') ||
    m.includes('401') ||
    m.includes('403')
  ) {
    return { code: 'AUTH_ERROR', message: msg, retryable: false };
  }
  if (m.includes('missing') || m.includes('not set') || m.includes('environment')) {
    return { code: 'ENV_ERROR', message: msg, retryable: false };
  }
  if (m.includes('invalid action') || m.includes('action not allowed')) {
    return { code: 'INVALID_ACTION', message: msg, retryable: false };
  }
  if (m.includes('provider') || m.includes('upstream') || m.includes('bad request') || m.includes('llm')) {
    return { code: 'UPSTREAM_ERROR', message: msg, retryable: true };
  }

  return { code: 'INTERNAL_ERROR', message: msg, retryable: false };
}

function pickAction(
  allowedActions: string[],
  outputText: string,
  tools: Array<{ name: string; schema?: Record<string, unknown> }>,
): StepOutput['action'] {
  const preferred = ['final_answer', 'no_op', 'tool_call'];
  const picked = preferred.find(a => allowedActions.includes(a)) || allowedActions[0] || 'no_op';

  if (picked === 'tool_call') {
    return {
      type: 'tool_call',
      name: tools[0]?.name || 'unknown_tool',
      arguments: {},
    };
  }

  if (picked === 'final_answer') {
    return {
      type: 'final_answer',
      content: outputText,
    };
  }

  return {
    type: picked,
    content: outputText,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AdapterTimeoutError(ms)), ms);
    promise
      .then(v => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function resolveSdkVersionFromSource(source: string): string {
  const candidates: string[] = [];
  if (source === '@shareai-lab/kode-sdk') {
    candidates.push('@shareai-lab/kode-sdk/package.json');
  } else if (source.endsWith('index.js')) {
    candidates.push(path.resolve(source, '../../package.json'));
  } else if (source.includes('node_modules')) {
    candidates.push(path.resolve(source, 'package.json'));
  } else {
    candidates.push(path.resolve(source, 'package.json'));
  }

  for (const pkgPath of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(pkgPath) as { version?: string };
      if (pkg?.version && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // ignore
    }
  }

  return 'unknown';
}

function getProviderUtilsModuleCandidates(source: string): string[] {
  if (source === '@shareai-lab/kode-sdk') {
    return ['@shareai-lab/kode-sdk/dist/infra/providers/utils'];
  }
  if (source.endsWith('index.js')) {
    return [path.resolve(source, '../infra/providers/utils.js')];
  }
  return [path.join(source, 'dist/infra/providers/utils.js')];
}

function normalizeOpenAIBaseUrlCompat(url: string): string {
  let normalized = url.replace(/\/+$/, '');
  // Keep non-v1 version suffixes (/v2, /v4, ...) and append /v1 only if no version suffix exists.
  if (!/\/v\d+$/.test(normalized)) {
    normalized += '/v1';
  }
  return normalized;
}

function loadKodeSdkFromEntries(entries: string[]): { sdk: KodeSdkModule; source: string } {
  const errs: string[] = [];

  for (const entry of entries) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(entry) as Partial<KodeSdkModule>;
      if (
        loaded &&
        loaded.Agent &&
        typeof loaded.Agent.create === 'function' &&
        loaded.JSONStore &&
        loaded.AgentTemplateRegistry &&
        loaded.ToolRegistry &&
        loaded.SandboxFactory
      ) {
        return { sdk: loaded as KodeSdkModule, source: entry };
      }
      errs.push(`${entry}: missing required exports`);
    } catch (err: any) {
      errs.push(`${entry}: ${err?.message || String(err)}`);
    }
  }

  throw new Error(
    `Failed to load KODE SDK. Set KODE_SDK_PATH or install @shareai-lab/kode-sdk. Tried:\n${errs.join('\n')}`,
  );
}

export class KodeAgentAdapter implements AgentAdapter {
  private readonly autoInstall: boolean;
  private readonly adapterId: 'kode-agent' | 'kode-sdk';

  private initialized = false;
  private ctx: RunContext | null = null;
  private sdk: KodeSdkModule | null = null;
  private sdkSource = 'unknown';
  private sdkVersion = 'unknown';
  private deps: Record<string, unknown> | null = null;
  private readonly agentsByTask = new Map<string, any>();
  private templateId = 'eval-kode-agent';

  private runtimeInstallDir: string | null = null;
  private runtimePackageSpec: string | null = null;
  private patchedSdkOpenAIBaseUrl = false;

  constructor(options?: KodeAgentAdapterOptions) {
    this.autoInstall = Boolean(options?.autoInstall);
    this.adapterId = options?.adapterId || (this.autoInstall ? 'kode-sdk' : 'kode-agent');
  }

  metadata(): AgentMetadata {
    return {
      name: `${this.adapterId}-adapter`,
      version: this.sdkVersion,
      spec_version: '1.0',
      capabilities: {
        tool_calling: true,
        multi_turn: true,
        streaming: false,
        structured_output: true,
      },
      supported_benchmarks: ['mock', 'swe', 'tb2', 'tau'],
    };
  }

  private resolveDefaultEntries(): string[] {
    const out: string[] = [];
    const envPath = process.env.KODE_SDK_PATH;
    if (envPath) {
      out.push(path.resolve(envPath));
    }
    out.push('@shareai-lab/kode-sdk');
    out.push(path.resolve(process.cwd(), '../Kode-agent-sdk/dist/index.js'));
    return out;
  }

  private installRuntimeSdk(runId: string): string {
    const npmCmd = (process.env.KODE_SDK_NPM_CMD || 'npm').trim() || 'npm';
    const pkgName = (process.env.KODE_SDK_NPM_PACKAGE || '@shareai-lab/kode-sdk').trim();
    const pkgVersion = (process.env.KODE_SDK_NPM_VERSION || '').trim();
    const pkgSpec = pkgVersion ? `${pkgName}@${pkgVersion}` : pkgName;
    const timeoutMs = parsePositiveInt(process.env.KODE_SDK_INSTALL_TIMEOUT_MS, 300000);

    const installDir = path.resolve(
      process.cwd(),
      'tests/tmp/kode-sdk-runtime',
      `${sanitizeLabel(runId)}-${Date.now()}`,
    );

    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, 'package.json'),
      JSON.stringify({
        name: 'kode-agent-eval-runtime',
        private: true,
        version: '0.0.0',
      }, null, 2),
      'utf-8',
    );

    const installArgs = ['install', '--no-audit', '--no-fund', '--omit=dev', '--no-package-lock', pkgSpec];
    console.log(
      `[adapter:${this.adapterId}] installing ${pkgSpec} with ${npmCmd} (timeout=${timeoutMs}ms)`,
    );

    const install = spawnSync(
      npmCmd,
      installArgs,
      {
        cwd: installDir,
        env: process.env,
        encoding: 'utf-8',
        timeout: timeoutMs,
      },
    );

    if (install.error) {
      throw new Error(
        `Failed to auto-install KODE SDK with \`${npmCmd} ${installArgs.join(' ')}\`: ${install.error.message}`,
      );
    }

    if (install.status !== 0) {
      const std = `${install.stdout || ''}\n${install.stderr || ''}`.trim();
      throw new Error(
        `Failed to auto-install KODE SDK with \`${npmCmd} ${installArgs.join(' ')}\`. Exit=${install.status ?? 'unknown'}. ${std}`,
      );
    }

    const moduleDir = path.join(
      installDir,
      'node_modules',
      ...pkgName.split('/').filter(Boolean),
    );

    if (!fs.existsSync(moduleDir)) {
      throw new Error(`Auto-installed package missing expected module directory: ${moduleDir}`);
    }

    this.runtimeInstallDir = installDir;
    this.runtimePackageSpec = pkgSpec;
    return moduleDir;
  }

  private loadSdkWithMode(ctx: RunContext): { sdk: KodeSdkModule; source: string } {
    const envPath = process.env.KODE_SDK_PATH;
    if (envPath) {
      return loadKodeSdkFromEntries([path.resolve(envPath), ...this.resolveDefaultEntries()]);
    }

    if (this.autoInstall) {
      const runtimeEntry = this.installRuntimeSdk(ctx.run_id);
      return loadKodeSdkFromEntries([runtimeEntry, ...this.resolveDefaultEntries()]);
    }

    return loadKodeSdkFromEntries(this.resolveDefaultEntries());
  }

  private patchOpenAIBaseUrlNormalizerIfNeeded(source: string): void {
    const candidates = getProviderUtilsModuleCandidates(source);
    for (const modPath of candidates) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const utils = require(modPath) as { normalizeOpenAIBaseUrl?: (url: string) => string };
        if (!utils || typeof utils.normalizeOpenAIBaseUrl !== 'function') continue;

        const probe = utils.normalizeOpenAIBaseUrl('https://open.bigmodel.cn/api/paas/v4');
        if (probe.endsWith('/v4/v1')) {
          utils.normalizeOpenAIBaseUrl = normalizeOpenAIBaseUrlCompat;
          this.patchedSdkOpenAIBaseUrl = true;
          console.log(`[adapter:${this.adapterId}] patched SDK OpenAI base URL normalizer for non-v1 endpoints`);
        }
        return;
      } catch {
        // try next candidate
      }
    }
  }

  async init(ctx: RunContext): Promise<void> {
    try {
      const { sdk, source } = this.loadSdkWithMode(ctx);
      this.patchOpenAIBaseUrlNormalizerIfNeeded(source);
      this.sdk = sdk;
      this.sdkSource = source;
      this.ctx = ctx;

      this.sdkVersion = resolveSdkVersionFromSource(source);
      this.templateId = `eval-kode-agent-${sanitizeLabel(ctx.run_id)}`;

      const storeDir = process.env.KODE_AGENT_STORE_DIR
        ? path.resolve(process.env.KODE_AGENT_STORE_DIR)
        : path.resolve(process.cwd(), 'tests/tmp/kode-store', sanitizeLabel(ctx.run_id));

      const templateRegistry = new this.sdk.AgentTemplateRegistry();
      const toolRegistry = new this.sdk.ToolRegistry();
      const sandboxFactory = new this.sdk.SandboxFactory();

      templateRegistry.register({
        id: this.templateId,
        systemPrompt:
          'You are an evaluation agent. Follow user instructions exactly. Keep output concise and deterministic.',
        tools: [],
        runtime: {
          metadata: {
            exposeThinking: false,
          },
        },
      });

      this.deps = {
        store: new this.sdk.JSONStore(storeDir),
        templateRegistry,
        sandboxFactory,
        toolRegistry,
      };

      if (this.autoInstall && this.runtimePackageSpec) {
        console.log(`[adapter:${this.adapterId}] auto-installed ${this.runtimePackageSpec}`);
      }

      this.initialized = true;
    } catch (err) {
      this.cleanupRuntimeInstallDir();
      throw err;
    }
  }

  private ensureReady(): {
    ctx: RunContext;
    sdk: KodeSdkModule;
    deps: Record<string, unknown>;
  } {
    if (!this.initialized || !this.ctx || !this.sdk || !this.deps) {
      throw new Error('adapter not initialized');
    }
    return { ctx: this.ctx, sdk: this.sdk, deps: this.deps };
  }

  private async getOrCreateTaskAgent(taskId: string): Promise<any> {
    const cached = this.agentsByTask.get(taskId);
    if (cached) return cached;

    const { ctx, sdk, deps } = this.ensureReady();
    const resolved = resolveModel(ctx.model);
    const providerEnv = resolveProviderEnv(resolved.provider);

    if (!providerEnv.apiKey) {
      throw new Error(
        `Missing API key for provider=${resolved.provider}. Set ${resolved.provider.toUpperCase()}_API_KEY or KODE_AGENT_API_KEY.`,
      );
    }

    const modelConfig: Record<string, unknown> = {
      provider: resolved.provider,
      model: resolved.model,
      apiKey: providerEnv.apiKey,
      temperature: 0,
    };

    if (providerEnv.baseUrl) {
      modelConfig.baseUrl = providerEnv.baseUrl;
    }

    const workDir = process.env.KODE_AGENT_WORKDIR
      ? path.resolve(process.env.KODE_AGENT_WORKDIR)
      : process.cwd();

    const agent = await sdk.Agent.create(
      {
        templateId: this.templateId,
        modelConfig,
        sandbox: {
          kind: 'local',
          workDir,
          enforceBoundary: true,
          watchFiles: false,
        },
      },
      deps,
    );

    this.agentsByTask.set(taskId, agent);
    return agent;
  }

  async step(input: StepInput): Promise<StepOutput> {
    const startedAt = Date.now();

    try {
      const agent = await this.getOrCreateTaskAgent(input.task_id);
      const latestUserMessage = [...input.observation.messages]
        .reverse()
        .find(m => (m.role || '').toLowerCase() === 'user');
      const prompt = latestUserMessage?.content
        || input.observation.messages[input.observation.messages.length - 1]?.content
        || '';

      let inputTokens = 0;
      let outputTokens = 0;

      const off = typeof agent.on === 'function'
        ? agent.on('token_usage', (evt: any) => {
            const inTok = Number(evt?.inputTokens);
            const outTok = Number(evt?.outputTokens);
            if (Number.isFinite(inTok) && inTok > 0) inputTokens += inTok;
            if (Number.isFinite(outTok) && outTok > 0) outputTokens += outTok;
          })
        : () => undefined;

      let result: any;
      try {
        result = await withTimeout(agent.complete(prompt), Math.max(1, input.deadline_ms || 1));
      } finally {
        off();
      }

      const text = typeof result?.text === 'string' ? result.text : '';
      const action = pickAction(input.allowed_actions, text, input.observation.tools);

      return {
        action,
        terminal: action.type === 'final_answer',
        state_delta: {
          sdk_source: this.sdkSource,
        },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_tokens: 0,
          total_tokens: inputTokens + outputTokens,
          latency_ms: Date.now() - startedAt,
        },
        error: null,
      };
    } catch (err) {
      const normalized = normalizeError(err);
      const fallbackAction = pickAction(input.allowed_actions, '', input.observation.tools);
      return {
        action: fallbackAction,
        terminal: true,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_tokens: 0,
          total_tokens: 0,
          latency_ms: Date.now() - startedAt,
        },
        error: normalized,
      };
    }
  }

  private cleanupRuntimeInstallDir(): void {
    if (!this.runtimeInstallDir) return;
    try {
      fs.rmSync(this.runtimeInstallDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
    this.runtimeInstallDir = null;
    this.runtimePackageSpec = null;
    this.patchedSdkOpenAIBaseUrl = false;
  }

  async close(): Promise<void> {
    const agents = [...this.agentsByTask.values()];
    this.agentsByTask.clear();

    for (const agent of agents) {
      try {
        if (agent && typeof agent.interrupt === 'function') {
          await agent.interrupt({ note: 'adapter close' });
        }
      } catch {
        // ignore close errors per agent
      }
    }

    if (this.autoInstall && this.runtimeInstallDir) {
      console.log(`[adapter:${this.adapterId}] cleaning runtime SDK directory: ${this.runtimeInstallDir}`);
    }
    this.cleanupRuntimeInstallDir();

    this.initialized = false;
    this.ctx = null;
    this.sdk = null;
    this.deps = null;
  }
}
