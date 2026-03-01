export type BenchmarkId = 'mock' | 'swe' | 'tb2' | 'tau';

export interface RunContext {
  run_id: string;
  benchmark: BenchmarkId;
  dataset: string;
  seed: number;
  timeout_ms: number;
  model: string;
  agent_config: Record<string, unknown>;
}

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_tokens?: number | null;
  total_tokens?: number | null;
  latency_ms?: number | null;
}

export interface AgentError {
  code:
    | 'TIMEOUT'
    | 'INVALID_ACTION'
    | 'RATE_LIMIT'
    | 'AUTH_ERROR'
    | 'ENV_ERROR'
    | 'UPSTREAM_ERROR'
    | 'INTERNAL_ERROR';
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface AgentMetadata {
  name: string;
  version: string;
  spec_version: '1.0';
  capabilities: {
    tool_calling: boolean;
    multi_turn: boolean;
    streaming: boolean;
    structured_output: boolean;
  };
  supported_benchmarks: BenchmarkId[];
}

export interface StepInput {
  task_id: string;
  turn_id: number;
  observation: {
    messages: Array<{ role: string; content: string }>;
    state: Record<string, unknown>;
    tools: Array<{ name: string; schema?: Record<string, unknown> }>;
  };
  allowed_actions: string[];
  deadline_ms: number;
  state: Record<string, unknown>;
}

export interface StepOutput {
  action: {
    type: string;
    name?: string;
    arguments?: Record<string, unknown>;
    content?: string;
  };
  terminal: boolean;
  state_delta?: Record<string, unknown>;
  usage?: TokenUsage;
  error?: AgentError | null;
}

export interface TaskResult {
  task_id: string;
  passed: boolean;
  score: number;
  duration_ms: number;
  error_code?: string;
  token_usage?: TokenUsage | null;
}

export interface RunSummary {
  pass_rate: number;
  avg_latency_ms: number;
  error_distribution: Record<string, number>;
  avg_tokens?: number | null;
}

export interface UnifiedRunReport {
  run_id: string;
  benchmark: BenchmarkId;
  dataset: string;
  agent: string;
  model: string;
  commit_sha: string;
  seed: number;
  timeout_ms: number;
  started_at: string;
  finished_at: string;
  tasks: TaskResult[];
  summary: RunSummary;
}

export interface ComplianceAssertion {
  type: 'json_schema' | 'in_set' | 'non_negative' | 'equals' | 'max_value';
  path: string;
  schema_ref?: string;
  expected?: string[];
  value?: string | number | boolean | null;
  max?: number;
  optional?: boolean;
}

export interface ComplianceCase {
  id: string;
  level: 'L1' | 'L2';
  description: string;
  preconditions: {
    adapter: string;
    benchmark: BenchmarkId | string;
    model: string;
    timeout_ms: number;
  };
  input: StepInput;
  assertions: ComplianceAssertion[];
  expected: {
    pass: boolean;
    error_code: string | null;
  };
}
