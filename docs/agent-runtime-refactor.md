# Runtime Under Test Refactor Design

## Goal

Refactor the harness from a repository-internal adapter switch into a protocol-oriented integration layer so external agents can be evaluated through the same interface across:

- SWE-bench generation + official scoring
- TAU2 official runner
- Terminal Bench 2.0 official runner
- compliance and mock smoke tests

## Current Problems

The current codebase has three incompatible integration styles:

1. Local TypeScript adapter classes for `mock` and `kode-*`
2. A Kode-specific TAU2 Python plugin plus Node bridge
3. TB2 integration that only forwards official Harbor agent names

This causes three structural issues:

- external agents cannot plug in without editing this repository
- benchmark integrations are inconsistent and partially hardcoded to Kode
- TAU/TB2 do not share the same agent contract used by mock/SWE/compliance

## Target Architecture

The harness will expose one stable runtime contract, `agent-runtime/v1`, and every benchmark bridge will evaluate the runtime under test through that contract.

### Layers

1. Agent manifest resolution
2. Agent runtime transport
3. Benchmark-specific bridge

### Runtime Manifest

Each runtime-under-test is resolved from either:

- a built-in manifest name like `mock`
- a tracked manifest file like `agents/kode-sdk.json`
- a user-supplied manifest path like `./agents/my-agent.json`

Manifest example:

```json
{
  "api_version": "agent-runtime/v1",
  "name": "my-agent",
  "transport": {
    "kind": "stdio",
    "command": "python3",
    "args": ["./agent_server.py"],
    "cwd": "."
  },
  "supported_benchmarks": ["mock", "swe", "tb2", "tau"]
}
```

### Runtime Contract

The harness-side runtime-under-test contract remains:

- `metadata()`
- `init(ctx)`
- `step(input)`
- `close()`

For external agents, the default transport is `stdio` with newline-delimited JSON-RPC messages.

Required RPC methods:

- `agent.handshake`
- `run.init`
- `run.step`
- `run.close`

The protocol payloads reuse the repository types already defined in `src/types.ts`.

### Benchmark Bridges

#### SWE

- generate predictions by calling the runtime contract directly
- score with the official docker evaluation path

#### TAU2

- use a generic TAU2 plugin module instead of a Kode-specific plugin
- the plugin converts TAU messages/tools into `StepInput`
- each TAU turn calls the harness `bridge-agent` CLI, which resolves the configured agent manifest and executes one runtime step
- bridge output is converted back into either a TAU message or a TAU tool call

#### TB2

- keep the official Harbor runner
- when the requested agent is a harness agent manifest, run Harbor with `--agent-import-path`
- the imported Python agent performs an action loop:
  - present shell execution as a tool to the harness agent runtime
  - call the harness `bridge-agent` CLI per turn
  - execute `exec` tool calls against Harbor `BaseEnvironment`
  - stop on final answer or step budget exhaustion

This keeps official TB2 orchestration and scoring while routing decisions through the shared interface.

## Compatibility Strategy

### Built-ins

Existing built-in runtime implementations remain available through manifests:

- `mock`
- `kode-agent`
- `kode-sdk`

### Existing CLI Behavior

- `mock` and `swe` still use `--agent`
- `tb2` still supports official Harbor agent names through `--tb2-agent`
- `tau` still supports official TAU agent cores through `--tau-agent-core`
- when a harness runtime ref is supplied for `tb2` or `tau`, the harness interface path is used

## Phase 1 Implementation

This first implementation adds:

1. manifest-based resolution for built-in and external runtimes
2. a `stdio` JSON-RPC runtime client
3. a `bridge-agent` CLI entrypoint for benchmark adapters
4. generic TAU2 and TB2 Python bridges
5. SWE/compliance/mock migration to the new runtime resolver

## Known Constraints

1. The benchmark-side TAU/TB2 bridges are stateless per bridge invocation and rely on full message history plus tool observations, not long-lived in-process agent state.
2. TB2 custom-agent behavior depends on Harbor's external agent API and is implemented defensively because Harbor types are not vendored in this repository.
3. External `stdio` runtimes must implement the JSON-RPC contract explicitly; this refactor does not yet scaffold runtime servers automatically.

## Next Steps After Phase 1

1. add protocol JSON schemas under `schema/protocol/`
2. add `agent inspect` and `agent validate` CLI commands
3. add an example external `stdio` agent server
4. expand compliance to validate protocol transports directly
