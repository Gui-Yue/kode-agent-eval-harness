import type { StepInput, StepOutput } from '../types';
import { createAgentRuntime } from '../agents/runtime';
import { getCockpitCapabilities, solveConversationTurn } from '../cockpit/runtime';

export interface BridgeAgentOptions {
  mode: 'tau' | 'tb2' | 'generic';
  agent: string;
  model: string;
  runId: string;
  taskId: string;
  turnId: number;
  deadlineMs: number;
}

function getOption(options: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function asNumber(raw: string | undefined, fallback: number): number {
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
    });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.on('error', reject);
  });
}

function normalizeMessages(raw: unknown): StepInput['observation']['messages'] {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    const message = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      role: typeof message.role === 'string' ? message.role : 'user',
      content: typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? ''),
    };
  });
}

function normalizeTools(raw: unknown): StepInput['observation']['tools'] {
  if (!Array.isArray(raw)) return [];

  const out: StepInput['observation']['tools'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const tool = item as Record<string, unknown>;
    const fn = tool.function && typeof tool.function === 'object'
      ? tool.function as Record<string, unknown>
      : tool;
    const name = typeof fn.name === 'string' ? fn.name : undefined;
    if (!name) continue;
    const schema = fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters as Record<string, unknown>
      : undefined;
    out.push({ name, schema });
  }

  return out;
}

function formatAction(output: StepOutput): Record<string, unknown> {
  if (output.action.type === 'tool_call') {
    return {
      mode: 'tool_call',
      id: output.action.name ? `${output.action.name}-${Date.now()}` : undefined,
      name: output.action.name || '',
      arguments: output.action.arguments || {},
      usage: output.usage || null,
      raw_action_type: output.action.type,
    };
  }

  return {
    mode: 'message',
    content: output.action.content || '',
    usage: output.usage || null,
    raw_action_type: output.action.type,
  };
}

export function parseBridgeAgentOptions(options: Record<string, string>): BridgeAgentOptions {
  return {
    mode: (getOption(options, 'mode') as BridgeAgentOptions['mode']) || 'generic',
    agent: getOption(options, 'agent') || process.env.EVAL_HARNESS_AGENT_REF || 'mock',
    model: getOption(options, 'model') || process.env.EVAL_HARNESS_MODEL || 'openai/glm-5',
    runId: getOption(options, 'run-id', 'run_id') || `bridge-${Date.now()}`,
    taskId: getOption(options, 'task-id', 'task_id') || 'bridge-task',
    turnId: asNumber(getOption(options, 'turn-id', 'turn_id'), 0),
    deadlineMs: asNumber(getOption(options, 'deadline-ms', 'deadline_ms'), 120000),
  };
}

export async function bridgeAgentCommand(opts: BridgeAgentOptions): Promise<void> {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
  const { adapter, manifest } = createAgentRuntime(opts.agent);
  const cockpitCaps = getCockpitCapabilities(adapter);

  const tools = normalizeTools(payload.tools);
  const allowedActions = tools.length > 0
    ? ['tool_call', 'final_answer', 'no_op']
    : ['final_answer', 'no_op'];

  const input: StepInput = {
    task_id: typeof payload.task_id === 'string' ? payload.task_id : opts.taskId,
    turn_id: opts.turnId,
    observation: {
      messages: normalizeMessages(payload.messages),
      state: payload.state && typeof payload.state === 'object'
        ? payload.state as Record<string, unknown>
        : {},
      tools,
    },
    allowed_actions: allowedActions,
    deadline_ms: opts.deadlineMs,
    state: payload.state && typeof payload.state === 'object'
      ? payload.state as Record<string, unknown>
      : {},
  };

  await adapter.init({
    run_id: opts.runId,
    benchmark: opts.mode === 'tau' ? 'tau' : (opts.mode === 'tb2' ? 'tb2' : 'mock'),
    dataset: `${opts.mode}-bridge`,
    seed: 42,
    timeout_ms: opts.deadlineMs,
    model: opts.model,
    agent_config: {
      bridge_mode: opts.mode,
      manifest_source: manifest.source,
      cockpit_capabilities: cockpitCaps.map(cap => cap.kind),
    },
  });

  try {
    const output = await solveConversationTurn(adapter, input);
    process.stdout.write(JSON.stringify(formatAction(output)));
  } finally {
    await adapter.close();
  }
}
