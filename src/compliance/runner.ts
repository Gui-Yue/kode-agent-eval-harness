import fs from 'node:fs';
import path from 'node:path';
import Ajv, { type AnySchema } from 'ajv';
import addFormats from 'ajv-formats';
import { createAgentRuntime } from '../agents/runtime';
import type { ComplianceAssertion, ComplianceCase, StepOutput } from '../types';
import { getByJsonPath } from '../utils/json-path';
import { loadJsonSchema, readJson } from '../utils/io';

export interface ComplianceOptions {
  adapter: string;
  casePath?: string;
  casesDir: string;
  suite: 'l1' | 'l2' | 'all';
}

export function parseComplianceOptions(options: Record<string, string>): ComplianceOptions {
  const suiteRaw = (options.suite || 'l1').toLowerCase();
  const suite = suiteRaw === 'all' || suiteRaw === 'l2' ? (suiteRaw as 'all' | 'l2') : 'l1';

  return {
    adapter: options.adapter || 'mock',
    casePath: options.case,
    casesDir: options['cases-dir'] || options.cases_dir || 'compliance/cases',
    suite,
  };
}

function optionalMissing(assertion: ComplianceAssertion, value: unknown): boolean {
  return Boolean(assertion.optional) && (value === undefined || value === null);
}

function assertOne(assertion: ComplianceAssertion, context: Record<string, unknown>): { pass: boolean; message: string } {
  const value = getByJsonPath(context, assertion.path);
  if (optionalMissing(assertion, value)) {
    return { pass: true, message: 'optional and not present' };
  }

  if (assertion.type === 'json_schema') {
    if (!assertion.schema_ref) return { pass: false, message: 'missing schema_ref' };
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = loadJsonSchema(assertion.schema_ref) as AnySchema;
    const validate = ajv.compile(schema);
    const ok = validate(value);
    return {
      pass: Boolean(ok),
      message: ok ? 'ok' : ajv.errorsText(validate.errors),
    };
  }

  if (assertion.type === 'in_set') {
    const expected = assertion.expected || [];
    const ok = typeof value === 'string' && expected.includes(value);
    return { pass: ok, message: ok ? 'ok' : `value=${String(value)} not in [${expected.join(', ')}]` };
  }

  if (assertion.type === 'non_negative') {
    const ok = typeof value === 'number' && value >= 0;
    return { pass: ok, message: ok ? 'ok' : `value=${String(value)} is not non-negative number` };
  }

  if (assertion.type === 'equals') {
    const ok = value === assertion.value;
    return { pass: ok, message: ok ? 'ok' : `value=${String(value)} expected=${String(assertion.value)}` };
  }

  if (assertion.type === 'max_value') {
    if (typeof assertion.max !== 'number') {
      return { pass: false, message: 'missing max for max_value assertion' };
    }
    const ok = typeof value === 'number' && value <= assertion.max;
    return { pass: ok, message: ok ? 'ok' : `value=${String(value)} exceeds max=${assertion.max}` };
  }

  return { pass: false, message: `unsupported assertion type ${String((assertion as any).type)}` };
}

function listCaseFiles(casesDir: string): string[] {
  const fullDir = path.resolve(process.cwd(), casesDir);
  if (!fs.existsSync(fullDir)) {
    throw new Error(`cases dir not found: ${fullDir}`);
  }
  return fs.readdirSync(fullDir)
    .filter(n => n.endsWith('.json'))
    .sort()
    .map(n => path.join(fullDir, n));
}

async function runSingleCase(adapterName: string, casePath: string): Promise<boolean> {
  const testCase = readJson<ComplianceCase>(casePath);
  const { adapter } = createAgentRuntime(adapterName);
  const metadata = await adapter.metadata();

  await adapter.init({
    run_id: `compliance-${Date.now()}`,
    benchmark: 'mock',
    dataset: 'compliance',
    seed: 42,
    timeout_ms: testCase.preconditions.timeout_ms,
    model: testCase.preconditions.model,
    agent_config: {},
  });

  let output: StepOutput | null = null;
  let closeError: string | null = null;
  let stepDuration = 0;

  const t0 = Date.now();
  try {
    output = await adapter.step(testCase.input);
    stepDuration = Date.now() - t0;
  } catch (err: any) {
    stepDuration = Date.now() - t0;
    output = {
      action: { type: 'no_op' },
      terminal: true,
      error: {
        code: 'INTERNAL_ERROR',
        message: err?.message || String(err),
        retryable: false,
      },
    };
  } finally {
    try {
      await adapter.close();
    } catch (err: any) {
      closeError = err?.message || String(err);
    }
  }

  const ctx = {
    metadata,
    output,
    metrics: {
      step_duration_ms: stepDuration,
    },
  };

  let allPass = true;
  console.log(`Compliance case: ${testCase.id} (${testCase.level})`);
  for (const a of testCase.assertions) {
    const r = assertOne(a, ctx);
    console.log(`- ${a.type} @ ${a.path}: ${r.pass ? 'PASS' : 'FAIL'} (${r.message})`);
    if (!r.pass) allPass = false;
  }

  if (closeError) {
    console.error(`- close(): FAIL (${closeError})`);
    allPass = false;
  } else {
    console.log('- close(): PASS');
  }

  const expectPass = testCase.expected.pass;
  const finalPass = allPass === expectPass;
  console.log(`Result: ${finalPass ? 'PASS' : 'FAIL'} (actual=${allPass}, expected=${expectPass})`);
  console.log('');

  return finalPass;
}

export async function complianceCommand(opts: ComplianceOptions): Promise<number> {
  const cases = opts.casePath
    ? [path.resolve(process.cwd(), opts.casePath)]
    : listCaseFiles(opts.casesDir);

  const filteredCases = cases.filter(casePath => {
    if (opts.casePath) return true;
    const c = readJson<ComplianceCase>(casePath);
    if (opts.suite === 'all') return true;
    return c.level.toLowerCase() === opts.suite;
  });

  if (filteredCases.length === 0) {
    throw new Error('No compliance case selected.');
  }

  let passCount = 0;
  for (const casePath of filteredCases) {
    const ok = await runSingleCase(opts.adapter, casePath);
    if (ok) passCount += 1;
  }

  const total = filteredCases.length;
  console.log(`Compliance summary: ${passCount}/${total} passed`);
  return passCount === total ? 0 : 1;
}
