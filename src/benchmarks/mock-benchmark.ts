import type { BenchmarkDriver } from './types';

export class MockBenchmarkDriver implements BenchmarkDriver {
  id = 'mock' as const;
  dataset = 'mock@v1';

  async loadTasks() {
    return [
      {
        id: 'mock-1',
        input: {
          task_id: 'mock-1',
          turn_id: 1,
          observation: {
            messages: [{ role: 'user', content: 'Search flights from SFO to LAX.' }],
            state: {},
            tools: [{ name: 'search_flights' }],
          },
          allowed_actions: ['tool_call', 'final_answer', 'no_op'],
          deadline_ms: 30000,
          state: {},
        },
        expected_action_types: ['tool_call'],
      },
      {
        id: 'mock-2',
        input: {
          task_id: 'mock-2',
          turn_id: 1,
          observation: {
            messages: [{ role: 'user', content: 'Update reservation 12345.' }],
            state: {},
            tools: [{ name: 'update_reservation' }],
          },
          allowed_actions: ['tool_call', 'final_answer', 'no_op'],
          deadline_ms: 30000,
          state: {},
        },
        expected_action_types: ['tool_call'],
      },
      {
        id: 'mock-3',
        input: {
          task_id: 'mock-3',
          turn_id: 1,
          observation: {
            messages: [{ role: 'user', content: 'Say done.' }],
            state: {},
            tools: [],
          },
          allowed_actions: ['final_answer', 'no_op'],
          deadline_ms: 30000,
          state: {},
        },
        expected_action_types: ['final_answer', 'no_op'],
      },
    ];
  }
}
