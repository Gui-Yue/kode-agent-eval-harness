import type { AgentMetadata, RunContext, StepInput, StepOutput } from '../types';

export interface AgentAdapter {
  metadata(): Promise<AgentMetadata> | AgentMetadata;
  init(ctx: RunContext): Promise<void>;
  step(input: StepInput): Promise<StepOutput>;
  close(): Promise<void>;
}
