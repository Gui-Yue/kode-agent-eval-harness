# Kode Agent Eval Harness

Standalone benchmark harness for KODE agents.

It contains:

- Harbor adapters for `swebench-verified` and `terminal-bench@2.0`
- Tau adapter and runner scripts
- Dedicated GitHub Actions workflows for `SWE`, `TB2`, and `Tau`

The harness consumes the SDK through the published npm package `@shareai-lab/kode-sdk` instead of importing SDK source files from a sibling repository.
