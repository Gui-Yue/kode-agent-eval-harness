import fs from 'node:fs';
import path from 'node:path';

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(process.cwd(), filePath)), { recursive: true });
}

export function writeJson(filePath: string, data: unknown): void {
  const outPath = path.resolve(process.cwd(), filePath);
  ensureParentDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
}

export function readJson<T>(filePath: string): T {
  const p = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

export function loadJsonSchema(filePath: string): unknown {
  const p = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
