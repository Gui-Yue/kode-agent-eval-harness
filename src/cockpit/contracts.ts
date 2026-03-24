import type { AgentError, TokenUsage } from '../types';

export type CockpitCapabilityKind =
  | 'dialogue'
  | 'hosted_tools'
  | 'workspace'
  | 'local_tools'
  | 'shell';

export interface CockpitCapability {
  kind: CockpitCapabilityKind;
  description?: string;
}

export interface SolveTaskInWorkspaceInput {
  task_id: string;
  prompt: string;
  deadline_ms: number;
  state: Record<string, unknown>;
  workdir: string;
}

export interface SolveTaskInWorkspaceTrace {
  tool_calls: number;
  tool_errors: number;
  permission_requests: number;
  final_status: string;
}

export interface SolveTaskInWorkspaceResult {
  status: 'completed' | 'paused' | 'message_only';
  text: string;
  usage?: TokenUsage;
  error?: AgentError | null;
  trace?: SolveTaskInWorkspaceTrace;
}

export interface CandidateSolution {
  kind: 'patch';
  patch: string;
  summary?: string;
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

export interface OfficialVerificationResult {
  passed: boolean;
  score: number;
  errorCode?: string;
  error?: string;
}

export type WorkspaceTaskInput = SolveTaskInWorkspaceInput;
export type WorkspaceTaskTrace = SolveTaskInWorkspaceTrace;
export type WorkspaceTaskResult = SolveTaskInWorkspaceResult;
