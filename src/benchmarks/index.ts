import type { BenchmarkId } from '../types';
import type { BenchmarkDriver } from './types';
import { MockBenchmarkDriver } from './mock-benchmark';

export function createBenchmarkDriver(id: BenchmarkId): BenchmarkDriver {
  switch (id) {
    case 'mock':
      return new MockBenchmarkDriver();
    case 'swe':
    case 'tb2':
    case 'tau':
      throw new Error(`Benchmark "${id}" runner is planned but not implemented in MVP.`);
    default:
      throw new Error(`Unsupported benchmark: ${id}`);
  }
}
