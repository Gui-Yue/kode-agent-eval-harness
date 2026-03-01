import fs from 'node:fs';
import path from 'node:path';

function parseEnvFile(envFile: string): Record<string, string> {
  if (!fs.existsSync(envFile)) return {};

  const parsed: Record<string, string> = {};
  const lines = fs.readFileSync(envFile, 'utf-8').split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const idx = normalized.indexOf('=');
    if (idx <= 0) continue;

    const key = normalized.slice(0, idx).trim();
    if (!key) continue;

    let value = normalized.slice(idx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.indexOf(' #');
      if (commentIdx >= 0) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    parsed[key] = value;
  }

  return parsed;
}

export function loadDotEnv(explicitPath?: string): string | undefined {
  const candidates = explicitPath
    ? [path.resolve(process.cwd(), explicitPath)]
    : [path.resolve(process.cwd(), '.env')];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnvFile(file);
    for (const [k, v] of Object.entries(parsed)) {
      if (!process.env[k] || process.env[k]?.trim() === '') {
        process.env[k] = v;
      }
    }
    return file;
  }

  return undefined;
}

export function resolveEnvFile(explicitPath?: string): string | undefined {
  if (explicitPath) return path.resolve(process.cwd(), explicitPath);

  const defaultTestEnv = path.resolve(process.cwd(), '.env.test');
  if (fs.existsSync(defaultTestEnv)) return defaultTestEnv;

  const defaultEnv = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(defaultEnv)) return defaultEnv;

  return undefined;
}

export function readEnvFileValue(envFile: string, key: string): string | undefined {
  const parsed = parseEnvFile(envFile);
  const value = parsed[key];
  return value && value.trim() ? value.trim() : undefined;
}

export function getEnvValue(key: string, envFile?: string): string | undefined {
  const p = process.env[key];
  if (p && p.trim()) return p.trim();
  if (!envFile) return undefined;
  const f = readEnvFileValue(envFile, key);
  return f && f.trim() ? f.trim() : undefined;
}
