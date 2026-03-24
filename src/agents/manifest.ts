import fs from 'node:fs';
import path from 'node:path';
import { AGENT_RUNTIME_API_VERSION, type AgentManifest, type BuiltinAdapterName, type ResolvedAgentManifest } from './types';

const BUILTIN_AGENT_NAMES: ReadonlySet<BuiltinAdapterName> = new Set(['mock', 'kode-agent', 'kode-sdk', 'kode-agent-sdk']);

function buildBuiltinManifest(name: BuiltinAdapterName): AgentManifest {
  return {
    api_version: AGENT_RUNTIME_API_VERSION,
    name,
    transport: {
      kind: 'builtin',
      adapter: name,
    },
    supported_benchmarks: ['mock', 'swe', 'tb2', 'tau'],
  };
}

function validateManifest(raw: unknown, source: string): AgentManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid agent manifest at ${source}: expected object`);
  }

  const manifest = raw as Record<string, unknown>;
  if (manifest.api_version !== AGENT_RUNTIME_API_VERSION) {
    throw new Error(
      `Invalid agent manifest at ${source}: api_version must be "${AGENT_RUNTIME_API_VERSION}"`,
    );
  }

  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    throw new Error(`Invalid agent manifest at ${source}: missing name`);
  }

  const transport = manifest.transport;
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) {
    throw new Error(`Invalid agent manifest at ${source}: missing transport`);
  }

  const kind = (transport as Record<string, unknown>).kind;
  if (kind === 'builtin') {
    const adapter = (transport as Record<string, unknown>).adapter;
    if (!BUILTIN_AGENT_NAMES.has(adapter as BuiltinAdapterName)) {
      throw new Error(`Invalid agent manifest at ${source}: unsupported builtin adapter "${String(adapter)}"`);
    }
  } else if (kind === 'stdio') {
    const command = (transport as Record<string, unknown>).command;
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error(`Invalid agent manifest at ${source}: stdio transport requires command`);
    }
  } else {
    throw new Error(`Invalid agent manifest at ${source}: unsupported transport kind "${String(kind)}"`);
  }

  return manifest as unknown as AgentManifest;
}

function resolveManifestPath(agentRef: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), agentRef),
    path.resolve(process.cwd(), 'agents', agentRef),
    path.resolve(process.cwd(), 'agents', `${agentRef}.json`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  return null;
}

export function canResolveAgentManifest(agentRef: string): boolean {
  try {
    resolveAgentManifest(agentRef);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgentManifest(agentRef: string): ResolvedAgentManifest {
  const normalizedRef = agentRef.trim();
  if (!normalizedRef) {
    throw new Error('Empty agent reference');
  }

  if (BUILTIN_AGENT_NAMES.has(normalizedRef as BuiltinAdapterName)) {
    return {
      ref: normalizedRef,
      source: `builtin:${normalizedRef}`,
      baseDir: process.cwd(),
      manifest: buildBuiltinManifest(normalizedRef as BuiltinAdapterName),
    };
  }

  const manifestPath = resolveManifestPath(normalizedRef);
  if (!manifestPath) {
    throw new Error(`Unknown agent reference: ${normalizedRef}`);
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  const manifest = validateManifest(raw, manifestPath);
  return {
    ref: normalizedRef,
    source: manifestPath,
    baseDir: path.dirname(manifestPath),
    manifest,
  };
}
