# Cockpit / Vehicle Refactor Design

## Problem Statement

This repository should not primarily measure naked model quality.

The evaluation target is the runtime "vehicle" that the LLM drives:

- the LLM is the driver
- the runtime is the vehicle
- the benchmark is the destination plus scoring rules
- this repository is the cockpit that mounts a destination onto a vehicle

Under this framing, the harness must expose a stable cockpit interface that different vehicles can plug into, while keeping official benchmark scoring unchanged.

## Design Goal

Refactor the project from a model-step adapter layer into a cockpit-oriented runtime interface that can evaluate different vehicles across:

- SWE-bench-Verified
- TAU2 official runner
- Terminal Bench 2 official runner
- mock / compliance smoke suites

The harness should be hot-pluggable:

- a new vehicle should be addable by implementing the cockpit contract
- benchmarks should target the same cockpit contract, not a vehicle-specific shim
- official scorers remain the source of truth for pass/fail

## Core Mental Model

### Cockpit

The cockpit is the harness-side abstraction layer. It presents the task and any benchmark-hosted capabilities to the vehicle.

Today the cockpit needs to model four first-class capability families:

1. dialogue
2. hosted tools
3. workspace access
4. runtime-local tools

### Vehicle

A vehicle is an agent runtime implementation such as `kode-agent-sdk`.

The vehicle decides how the driver uses:

- conversation memory
- local filesystem tools
- shell tools
- hosted benchmark tools
- execution policy
- retries / internal planning / tool sequencing

### Destination

Each benchmark defines the destination differently:

- SWE: modify the repository so official verifier passes
- TAU2: solve the official interactive task
- TB2: solve the official terminal task in Harbor

The harness should not own the destination semantics. It only mounts them.

## Target Architecture

### Layering

1. Manifest resolution
2. Vehicle transport
3. Cockpit contract
4. Benchmark bridge
5. Official scorer / runner

### Manifest

Each vehicle is resolved from:

- a built-in manifest like `mock` or `kode-agent-sdk`
- a checked-in manifest file
- a user-supplied manifest path

The manifest identifies transport and benchmark support, but the behavioral contract is the cockpit contract.

For `stdio` transport, the JSON-RPC surface is:

- `agent.handshake`
- `run.init`
- `run.step`
- `run.solve_task_in_workspace`
- `run.close`

## Cockpit Contract

The existing `init / step / close` path remains as the lowest common denominator for turn-based runners.

The refactor adds an explicit cockpit layer above that with two usage modes:

### 1. Conversation Turn

Used by TAU2 / TB2 / compliance / mock.

The cockpit provides:

- dialogue history
- benchmark-hosted tools
- benchmark state
- deadline

The vehicle returns:

- assistant message
- tool request
- usage
- terminal / error state

For stdio vehicles, this maps to `run.step`.

### 2. Solve Task In Workspace

Used by SWE and any future repo-edit benchmark.

The cockpit provides:

- task prompt
- workspace root
- benchmark state
- deadline

The vehicle is expected to operate directly in the workspace through `solveTaskInWorkspace(...)` and return:

- final text summary
- usage
- trace metadata
- completion status

For stdio vehicles, this maps to `run.solve_task_in_workspace`.

The score then comes from a separate interface, `scoreCandidateWithOfficialVerifier(...)`.

## Why This Is More Fundamental Than Patch Generation

Patch generation measures whether the model can emit a valid patch in the benchmark-owned output format.

Workspace-task execution measures whether the vehicle gives the driver a usable environment:

- can it inspect files
- can it edit safely
- can it run focused commands
- can it maintain state over the attempt
- can it recover from bad intermediate steps

That is much closer to the "vehicle quality" we actually want.

## Benchmark Mapping

### SWE

SWE should use:

- `solveTaskInWorkspace(...)` for solving
- `scoreCandidateWithOfficialVerifier(...)` for scoring

Flow:

1. materialize `/testbed` from official SWE image into a local temp workspace
2. call the vehicle through `solveTaskInWorkspace`
3. collect git diff from the workspace
4. fall back to patch text extraction only as compatibility fallback
5. score with `scoreCandidateWithOfficialVerifier`

### TAU2

TAU2 should use the conversation-turn cockpit mode.

Flow:

1. official TAU2 runner owns task execution and scoring
2. plugin converts TAU history + tool schema into cockpit turn input
3. cockpit resolves vehicle and executes one turn
4. plugin maps output back to TAU message or TAU tool call

### TB2

TB2 should also use the conversation-turn cockpit mode.

Flow:

1. Harbor remains the official runner
2. Harbor exposes shell execution as a hosted cockpit tool
3. cockpit resolves vehicle and executes the turn
4. Harbor bridge executes tool calls in the official environment
5. Harbor still owns result files and final scoring

## Current Phase Implementation

This phase introduces the cockpit vocabulary into the codebase and starts routing benchmarks through it:

1. cockpit contracts are defined explicitly in TypeScript
2. adapters can advertise cockpit capabilities
3. adapters can optionally implement `solveTaskInWorkspace`
4. SWE prefers `solveTaskInWorkspace`
5. TAU / TB2 bridge code runs through the cockpit turn helper instead of calling adapters directly

`kode-agent-sdk` is the first default vehicle implementation for this contract.

## Compatibility Notes

- existing turn-based adapters still work through `step`
- external stdio transports are still supported
- official TAU2 / TB2 / SWE scoring paths remain unchanged
- patch extraction is retained only as a fallback, not the architectural center

## Known Gaps

1. TAU2 / TB2 still mount hosted benchmark tools through per-turn bridge processes rather than a long-lived cockpit daemon.
2. External stdio vehicles still need a reference server implementation to make adoption easy.
3. Capability descriptors are informational today; benchmark-side negotiation is still minimal.
4. More trace and observability data should be persisted for debugging vehicle quality regressions.

## Immediate Next Steps

1. add a reusable stdio server example that implements `run.solve_task_in_workspace`
2. add capability negotiation / validation commands
3. persist cockpit traces into artifacts for GH Actions debugging
4. add more default vehicles beyond `kode-agent-sdk`
