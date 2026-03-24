import type { BenchmarkId } from '../types';

export const AGENT_RUNTIME_API_VERSION = 'agent-runtime/v1';

export type BuiltinAdapterName = 'mock' | 'kode-agent' | 'kode-sdk' | 'kode-agent-sdk';

export interface BuiltinAgentTransport {
  kind: 'builtin';
  adapter: BuiltinAdapterName;
}

export interface StdioAgentTransport {
  kind: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type AgentTransport = BuiltinAgentTransport | StdioAgentTransport;

export interface AgentManifest {
  api_version: typeof AGENT_RUNTIME_API_VERSION;
  name: string;
  description?: string;
  transport: AgentTransport;
  supported_benchmarks?: BenchmarkId[];
}

export interface ResolvedAgentManifest {
  ref: string;
  source: string;
  baseDir: string;
  manifest: AgentManifest;
}
