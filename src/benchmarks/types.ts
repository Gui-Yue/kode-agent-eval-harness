import type { BenchmarkId, StepInput } from '../types';

export interface BenchmarkTask {
  id: string;
  input: StepInput;
  expected_action_types: string[];
}

export interface BenchmarkDriver {
  id: BenchmarkId;
  dataset: string;
  loadTasks(): Promise<BenchmarkTask[]>;
}
