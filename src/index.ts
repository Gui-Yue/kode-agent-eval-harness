import { parseArgs } from './utils/args';
import { compareCommand, parseCompareOptions } from './runner/compare';
import { parseRenderOptions, reportCommand } from './runner/report';
import { bridgeAgentCommand, parseBridgeAgentOptions } from './runner/bridge-agent';
import { parseRunOptions, runCommand } from './runner/run';
import { complianceCommand, parseComplianceOptions } from './compliance/runner';
import { loadDotEnv } from './utils/env';

function printHelp(): void {
  console.log('Usage: tsx src/index.ts <command> [--key=value]');
  console.log('Commands:');
  console.log('  run         Execute one benchmark run');
  console.log('  compare     Compare two run reports');
  console.log('  report      Render a report summary');
  console.log('  compliance  Run adapter compliance checks');
  console.log('  bridge-agent  Internal cockpit bridge entrypoint');
  console.log('');
  console.log('Run examples:');
  console.log('  run --benchmark=mock --agent=mock --out=reports/mock.json');
  console.log('  run --benchmark=mock --agent=kode-agent-sdk --model=openai/glm-5 --out=reports/mock-kode-agent-sdk.json');
  console.log('  run --benchmark=swe --agent=kode-agent-sdk --model=openai/glm-5 --swe-generate-only=true --swe-max-instances=2');
  console.log('  run --benchmark=swe --agent=mock --swe-auto-generate=true --swe-max-instances=2 --out=reports/swe-run.json');
  console.log('  run --benchmark=tb2 --model=openai/glm-5 --tb2-agent=oracle --tb2-runner=uvx');
  console.log('  run --benchmark=tau --provider=openai --model=glm-5 --tau-domain=airline --num-trials=1');
  console.log('');
  console.log('Compliance examples:');
  console.log('  compliance --adapter=mock --suite=l1');
  console.log('  compliance --adapter=kode-agent-sdk --suite=l1');
  console.log('  compliance --adapter=mock --case=compliance/cases/l1_03_step_schema_valid.json');
}

async function main(): Promise<void> {
  loadDotEnv();

  const { command, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'run': {
      const opts = parseRunOptions(options);
      const report = await runCommand(opts);
      console.log(`Run complete: ${report.run_id}`);
      console.log(`Pass rate: ${(report.summary.pass_rate * 100).toFixed(2)}%`);
      return;
    }
    case 'compare': {
      const code = compareCommand(parseCompareOptions(options));
      process.exitCode = code;
      return;
    }
    case 'report': {
      reportCommand(parseRenderOptions(options));
      return;
    }
    case 'compliance': {
      const code = await complianceCommand(parseComplianceOptions(options));
      process.exitCode = code;
      return;
    }
    case 'bridge-agent': {
      await bridgeAgentCommand(parseBridgeAgentOptions(options));
      return;
    }
    default:
      printHelp();
  }
}

main().catch(err => {
  console.error('Fatal:', err?.message || String(err));
  process.exitCode = 1;
});
