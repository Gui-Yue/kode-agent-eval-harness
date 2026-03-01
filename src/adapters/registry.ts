import type { AgentAdapter } from './interface';
import { MockAdapter } from './mock-adapter';
import { KodeAgentAdapter } from './kode-agent-adapter';

export function createAdapter(name: string): AgentAdapter {
  switch (name) {
    case 'mock':
      return new MockAdapter();
    case 'kode-agent':
      return new KodeAgentAdapter({ autoInstall: false, adapterId: 'kode-agent' });
    case 'kode-sdk':
      return new KodeAgentAdapter({ autoInstall: true, adapterId: 'kode-sdk' });
    case 'oracle':
    case 'codex':
    case 'claude-code':
    case 'gemini':
      throw new Error(`Adapter "${name}" is reserved but not implemented yet.`);
    default:
      throw new Error(`Unknown adapter: ${name}`);
  }
}
