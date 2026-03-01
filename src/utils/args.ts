export interface ParsedArgs {
  command: string;
  options: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const options: Record<string, string> = {};

  for (const token of rest) {
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {
      options[body] = 'true';
      continue;
    }
    const key = body.slice(0, eq).trim();
    const value = body.slice(eq + 1).trim();
    if (key) options[key] = value;
  }

  return { command, options };
}
