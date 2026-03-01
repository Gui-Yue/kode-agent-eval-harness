import type { AgentAdapter } from './interface';
import type { AgentMetadata, RunContext, StepInput, StepOutput } from '../types';

export class MockAdapter implements AgentAdapter {
  private initialized = false;

  metadata(): AgentMetadata {
    return {
      name: 'mock-adapter',
      version: '0.1.0',
      spec_version: '1.0',
      capabilities: {
        tool_calling: true,
        multi_turn: true,
        streaming: false,
        structured_output: true,
      },
      supported_benchmarks: ['mock', 'swe', 'tb2', 'tau'],
    };
  }

  async init(_ctx: RunContext): Promise<void> {
    this.initialized = true;
  }

  async step(input: StepInput): Promise<StepOutput> {
    if (!this.initialized) {
      return {
        action: { type: 'no_op' },
        terminal: true,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'adapter not initialized',
          retryable: false,
        },
      };
    }

    const prefersToolCall = input.allowed_actions.includes('tool_call') && input.observation.tools.length > 0;
    const actionType = prefersToolCall ? 'tool_call' : (input.allowed_actions[0] ?? 'no_op');
    const tokenBase = Math.max(1, Math.ceil(input.observation.messages.map(m => m.content.length).reduce((a, b) => a + b, 0) / 8));

    let action: StepOutput['action'];
    if (actionType === 'tool_call') {
      action = { type: 'tool_call', name: input.observation.tools[0]?.name ?? 'mock_tool', arguments: {} };
    } else if (actionType === 'final_answer') {
      const looksLikeSWE = /swe-bench|instance id|unified diff|problem statement/i.test(
        input.observation.messages.map(m => m.content).join('\n'),
      );
      action = {
        type: 'final_answer',
        content: looksLikeSWE
          ? [
              'diff --git a/README.md b/README.md',
              'index e69de29..e69de29 100644',
              '--- a/README.md',
              '+++ b/README.md',
            ].join('\n')
          : 'mock response',
      };
    } else {
      action = { type: actionType, content: 'mock response' };
    }

    return {
      action,
      terminal: actionType === 'final_answer',
      state_delta: {},
      usage: {
        input_tokens: tokenBase,
        output_tokens: 16,
        cache_tokens: 0,
        total_tokens: tokenBase + 16,
        latency_ms: 100,
      },
      error: null,
    };
  }

  async close(): Promise<void> {
    this.initialized = false;
  }
}
