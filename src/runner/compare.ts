import type { UnifiedRunReport } from '../types';
import { readJson } from '../utils/io';

export interface CompareOptions {
  baseline: string;
  candidate: string;
}

export function parseCompareOptions(options: Record<string, string>): CompareOptions {
  const baseline = options.baseline;
  const candidate = options.candidate;
  if (!baseline || !candidate) {
    throw new Error('compare requires --baseline=<path> and --candidate=<path>');
  }
  return { baseline, candidate };
}

export function compareCommand(opts: CompareOptions): number {
  const base = readJson<UnifiedRunReport>(opts.baseline);
  const cand = readJson<UnifiedRunReport>(opts.candidate);

  const passDelta = cand.summary.pass_rate - base.summary.pass_rate;
  const latencyDelta = cand.summary.avg_latency_ms - base.summary.avg_latency_ms;

  const tokenComparable = typeof base.summary.avg_tokens === 'number' && typeof cand.summary.avg_tokens === 'number';
  const tokenDelta = tokenComparable ? (cand.summary.avg_tokens as number) - (base.summary.avg_tokens as number) : null;

  console.log('=== Compare Report ===');
  console.log(`Baseline:  ${opts.baseline}`);
  console.log(`Candidate: ${opts.candidate}`);
  console.log(`Pass rate: ${(base.summary.pass_rate * 100).toFixed(2)}% -> ${(cand.summary.pass_rate * 100).toFixed(2)}% (${(passDelta * 100).toFixed(2)}pp)`);
  console.log(`Avg latency: ${base.summary.avg_latency_ms}ms -> ${cand.summary.avg_latency_ms}ms (${latencyDelta >= 0 ? '+' : ''}${latencyDelta}ms)`);
  console.log(`Avg tokens: ${tokenComparable ? `${base.summary.avg_tokens} -> ${cand.summary.avg_tokens} (${tokenDelta! >= 0 ? '+' : ''}${tokenDelta})` : 'N/A'}`);

  return passDelta < 0 ? 1 : 0;
}
