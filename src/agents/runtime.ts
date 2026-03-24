import type { AgentAdapter } from '../adapters/interface';
import { createBuiltinAdapter } from '../adapters/registry';
import { resolveAgentManifest } from './manifest';
import { StdioAgentRuntime } from './stdio-runtime';
import type { ResolvedAgentManifest } from './types';

export interface CreatedAgentRuntime {
  adapter: AgentAdapter;
  manifest: ResolvedAgentManifest;
}

export function createAgentRuntime(agentRef: string): CreatedAgentRuntime {
  const manifest = resolveAgentManifest(agentRef);
  const transport = manifest.manifest.transport;

  switch (transport.kind) {
    case 'builtin':
      return {
        manifest,
        adapter: createBuiltinAdapter(transport.adapter),
      };
    case 'stdio':
      return {
        manifest,
        adapter: new StdioAgentRuntime(manifest, transport),
      };
    default:
      throw new Error(`Unsupported transport kind: ${String((transport as { kind?: unknown }).kind)}`);
  }
}
