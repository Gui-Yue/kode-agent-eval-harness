import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { AgentAdapter } from '../adapters/interface';
import type { AgentMetadata, RunContext, StepInput, StepOutput } from '../types';
import type { ResolvedAgentManifest, StdioAgentTransport } from './types';

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: number;
  result: T;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcMessage<T> = JsonRpcSuccess<T> | JsonRpcError;

function resolveCommand(command: string, baseDir: string): string {
  if (path.isAbsolute(command)) return command;
  if (command.startsWith('./') || command.startsWith('../') || command.includes(path.sep)) {
    return path.resolve(baseDir, command);
  }
  return command;
}

function resolveWorkingDir(manifest: ResolvedAgentManifest, transport: StdioAgentTransport): string {
  if (!transport.cwd) return manifest.baseDir;
  if (path.isAbsolute(transport.cwd)) return transport.cwd;
  return path.resolve(manifest.baseDir, transport.cwd);
}

export class StdioAgentRuntime implements AgentAdapter {
  private readonly manifest: ResolvedAgentManifest;
  private readonly transport: StdioAgentTransport;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private stdoutBuffer = '';
  private handshakeMetadata: AgentMetadata | null = null;
  private closed = false;

  constructor(manifest: ResolvedAgentManifest, transport: StdioAgentTransport) {
    this.manifest = manifest;
    this.transport = transport;
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) {
      throw new Error(`stdio agent already closed: ${this.manifest.manifest.name}`);
    }

    const env = {
      ...process.env,
      ...(this.transport.env || {}),
    };
    const child = spawn(
      resolveCommand(this.transport.command, this.manifest.baseDir),
      this.transport.args || [],
      {
        cwd: resolveWorkingDir(this.manifest, this.transport),
        env,
        stdio: 'pipe',
      },
    );

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', chunk => this.handleStdout(String(chunk)));
    child.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) console.error(`[agent:${this.manifest.manifest.name}] ${text}`);
    });
    child.on('error', err => this.rejectAll(err instanceof Error ? err : new Error(String(err))));
    child.on('close', code => {
      const reason = new Error(
        `stdio agent exited unexpectedly: ${this.manifest.manifest.name} (exit=${String(code ?? 'unknown')})`,
      );
      this.rejectAll(reason);
      this.child = null;
    });

    this.child = child;
    return child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk.replace(/\r/g, '\n');
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: JsonRpcMessage<unknown>;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcMessage<unknown>;
      } catch (err) {
        this.rejectAll(new Error(`Invalid JSON from stdio agent ${this.manifest.manifest.name}: ${String(err)}`));
        return;
      }

      const pending = this.pending.get(parsed.id);
      if (!pending) continue;
      this.pending.delete(parsed.id);

      if ('error' in parsed) {
        pending.reject(new Error(parsed.error.message || `Agent RPC error ${parsed.error.code}`));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  private rejectAll(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const pending of entries) pending.reject(err);
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
    });

    child.stdin.write(`${payload}\n`);
    return await promise;
  }

  private async ensureHandshake(): Promise<AgentMetadata> {
    if (this.handshakeMetadata) return this.handshakeMetadata;
    const result = await this.request<{ protocol_version?: string; metadata?: AgentMetadata }>(
      'agent.handshake',
      {
        manifest_name: this.manifest.manifest.name,
      },
    );
    if (!result?.metadata) {
      throw new Error(`stdio agent handshake missing metadata: ${this.manifest.manifest.name}`);
    }
    this.handshakeMetadata = result.metadata;
    return result.metadata;
  }

  async metadata(): Promise<AgentMetadata> {
    return await this.ensureHandshake();
  }

  async init(ctx: RunContext): Promise<void> {
    await this.ensureHandshake();
    await this.request('run.init', { context: ctx });
  }

  async step(input: StepInput): Promise<StepOutput> {
    await this.ensureHandshake();
    return await this.request<StepOutput>('run.step', { input });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      if (this.child) {
        await this.request('run.close', {});
      }
    } catch {
      // best effort close
    }

    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
