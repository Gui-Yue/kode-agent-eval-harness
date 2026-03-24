import type { CockpitAdapter } from '../adapters/interface';
import type { AgentAdapter } from '../adapters/interface';
import type { StepInput, StepOutput } from '../types';
import type {
  CockpitCapability,
  SolveTaskInWorkspaceInput,
  SolveTaskInWorkspaceResult,
} from './contracts';

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

export function supportsWorkspaceTaskSolving(
  adapter: AgentAdapter,
): adapter is CockpitAdapter & (Required<Pick<CockpitAdapter, 'solveTaskInWorkspace'>> | Required<Pick<CockpitAdapter, 'runWorkspaceTask'>>) {
  const cockpit = adapter as CockpitAdapter;
  return typeof cockpit.solveTaskInWorkspace === 'function' || typeof cockpit.runWorkspaceTask === 'function';
}

export async function solveTaskInWorkspace(
  adapter: AgentAdapter,
  input: SolveTaskInWorkspaceInput,
): Promise<SolveTaskInWorkspaceResult | null> {
  if (!supportsWorkspaceTaskSolving(adapter)) return null;
  const cockpit = adapter as CockpitAdapter;
  if (typeof cockpit.solveTaskInWorkspace === 'function') {
    return cockpit.solveTaskInWorkspace(input);
  }
  if (typeof cockpit.runWorkspaceTask === 'function') {
    return cockpit.runWorkspaceTask(input);
  }
  return null;
}
