export function getByJsonPath(obj: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith('$.')) {
    throw new Error(`Unsupported JSONPath: ${jsonPath}`);
  }
  const parts = jsonPath.slice(2).split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
