import type { AgentMetadata, RunContext, StepInput, StepOutput } from '../types';
import type {
  CockpitCapability,
  SolveTaskInWorkspaceInput,
  SolveTaskInWorkspaceResult,
  WorkspaceTaskInput,
  WorkspaceTaskResult,
} from '../cockpit/contracts';

export interface AgentAdapter {
  metadata(): Promise<AgentMetadata> | AgentMetadata;
  init(ctx: RunContext): Promise<void>;
  step(input: StepInput): Promise<StepOutput>;
  close(): Promise<void>;
}

export interface CockpitAdapter extends AgentAdapter {
  describeCockpitCapabilities?(): CockpitCapability[];
  solveTaskInWorkspace?(input: SolveTaskInWorkspaceInput): Promise<SolveTaskInWorkspaceResult>;
  runWorkspaceTask?(input: WorkspaceTaskInput): Promise<WorkspaceTaskResult>;
}
