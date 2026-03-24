import type { CockpitAdapter } from '../adapters/interface';
import type { AgentAdapter } from '../adapters/interface';
import type { StepInput, StepOutput } from '../types';
import type { CockpitCapability, WorkspaceTaskInput, WorkspaceTaskResult } from './contracts';

export function getCockpitCapabilities(adapter: AgentAdapter): CockpitCapability[] {
  const cockpit = adapter as CockpitAdapter;
  if (typeof cockpit.describeCockpitCapabilities !== 'function') {
    return [{ kind: 'dialogue', description: 'Step-oriented dialogue bridge.' }];
  }
  return cockpit.describeCockpitCapabilities();
}

export async function runCockpitTurn(adapter: AgentAdapter, input: StepInput): Promise<StepOutput> {
  return adapter.step(input);
}

export function supportsWorkspaceTasks(adapter: AgentAdapter): adapter is CockpitAdapter & Required<Pick<CockpitAdapter, 'runWorkspaceTask'>> {
  return typeof (adapter as CockpitAdapter).runWorkspaceTask === 'function';
}

export async function runWorkspaceTask(
  adapter: AgentAdapter,
  input: WorkspaceTaskInput,
): Promise<WorkspaceTaskResult | null> {
  if (!supportsWorkspaceTasks(adapter)) return null;
  return adapter.runWorkspaceTask(input);
}
