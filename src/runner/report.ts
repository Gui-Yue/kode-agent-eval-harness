import type { UnifiedRunReport } from '../types';
import { readJson } from '../utils/io';

export interface RenderOptions {
  input: string;
  format: 'table' | 'markdown';
}

export function parseRenderOptions(options: Record<string, string>): RenderOptions {
  const input = options.input;
  if (!input) throw new Error('report requires --input=<path>');
  const format = options.format === 'table' ? 'table' : 'markdown';
  return { input, format };
}

function renderMarkdown(report: UnifiedRunReport): string {
  const lines: string[] = [];
  lines.push(`# Run Report: ${report.run_id}`);
  lines.push('');
  lines.push(`- Benchmark: ${report.benchmark}`);
  lines.push(`- Dataset: ${report.dataset}`);
  lines.push(`- Agent: ${report.agent}`);
  lines.push(`- Model: ${report.model}`);
  lines.push(`- Pass Rate: ${(report.summary.pass_rate * 100).toFixed(2)}%`);
  lines.push(`- Avg Latency: ${report.summary.avg_latency_ms} ms`);
  lines.push(`- Avg Tokens: ${report.summary.avg_tokens ?? 'N/A'}`);
  lines.push('');
  lines.push('| Task | Passed | Score | Duration (ms) | Error | Tokens |');
  lines.push('|---|---:|---:|---:|---|---:|');
  for (const t of report.tasks) {
    lines.push(`| ${t.task_id} | ${t.passed ? 'Y' : 'N'} | ${t.score.toFixed(2)} | ${t.duration_ms} | ${t.error_code ?? '-'} | ${t.token_usage?.total_tokens ?? 'N/A'} |`);
  }
  return lines.join('\n');
}

export function reportCommand(opts: RenderOptions): void {
  const report = readJson<UnifiedRunReport>(opts.input);
  if (opts.format === 'markdown') {
    console.log(renderMarkdown(report));
    return;
  }
  console.log('Task\tPassed\tScore\tDuration(ms)\tError\tTokens');
  for (const t of report.tasks) {
    console.log(`${t.task_id}\t${t.passed ? 'Y' : 'N'}\t${t.score.toFixed(2)}\t${t.duration_ms}\t${t.error_code ?? '-'}\t${t.token_usage?.total_tokens ?? 'N/A'}`);
  }
}
