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

export interface WorkspaceTaskInput {
  task_id: string;
  prompt: string;
  deadline_ms: number;
  state: Record<string, unknown>;
  workdir: string;
}

export interface WorkspaceTaskTrace {
  tool_calls: number;
  tool_errors: number;
  permission_requests: number;
  final_status: string;
}

export interface WorkspaceTaskResult {
  status: 'completed' | 'paused' | 'message_only';
  text: string;
  usage?: TokenUsage;
  error?: AgentError | null;
  trace?: WorkspaceTaskTrace;
}
