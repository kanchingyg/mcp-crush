import { resolve, relative, sep, isAbsolute } from "node:path";

export function assertPathContained(target: string, root: string): string {
  const absRoot = resolve(root);
  const absTarget = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
  const rel = relative(absRoot, absTarget);
  if (rel.startsWith("..") || rel.includes(`${sep}..`)) {
    throw new Error(`Path outside sandbox root: ${target}`);
  }
  return absTarget;
}

export function resolveMcpConfigPath(configPath?: string, root = process.cwd()): string {
  return assertPathContained(configPath ?? ".cursor/mcp.json", root);
}
