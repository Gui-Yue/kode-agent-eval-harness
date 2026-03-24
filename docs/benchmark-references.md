# Benchmark References

Last verified: 2026-02-28

This harness design references operational patterns from:

1. OpenHands Benchmarks (independent benchmark orchestration and reporting)
   - https://github.com/OpenHands/benchmarks
2. SWE-bench official repository
   - https://github.com/SWE-bench/SWE-bench
3. Terminal Bench (Harbor) official run flow
   - https://harborframework.com/docs/tutorials/running-terminal-bench
4. TAU2 official benchmark source
   - https://github.com/sierra-research/tau2-bench
5. Meta Agent Research Environments (dynamic environment benchmarking)
   - https://github.com/facebookresearch/meta-agents-research-environments

These references informed:

- solve-by-vehicle / score-by-official-runner integration strategy
- result/artifact centric design
- adapter decoupling and compliance gating
- smoke/full CI profile split
