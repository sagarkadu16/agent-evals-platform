import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import type { Step } from '@evals/shared';

/**
 * Hermes' file tools can read anywhere on disk: `--in` only sets the starting folder, and Hermes has
 * a write sandbox but no read sandbox. An agent that is missing information goes looking for it, so a
 * run without memory could find the memory file (or tasks.json with the reference answers) elsewhere.
 *
 * We cannot stop the read without OS-level isolation, but we can detect it: every file-tool argument
 * that names a path must resolve inside the run's work folder. A run that broke out is recorded as an
 * error and never scored, so it cannot count as a pass.
 */

/** Rule added to every run's system prompt (same for A and B), so honest agents stay inside. */
export const HARNESS_RULE = [
  '# Evaluation harness rule',
  'You are being evaluated. Work only with the files in your current working folder.',
  'Do not read, search, list or write files anywhere else on this computer.',
  'If something you need is not in your instructions or in that folder, say so instead of looking elsewhere.',
].join('\n');

/** Tool-call arguments that name a file or folder. */
const PATH_KEYS = new Set(['path', 'file_path', 'filepath', 'file', 'dir', 'directory', 'cwd', 'target_path', 'paths']);

/** Paths that are outside the folder but harmless. */
const ALLOWED = new Set(['/dev/null']);

export interface SandboxViolation {
  tool: string;
  path: string;
}

/** File-tool calls in `steps` whose path arguments point outside `workDir`. */
export function findSandboxViolations(steps: Step[], workDir: string): SandboxViolation[] {
  const roots = folderAliases(workDir);
  const violations: SandboxViolation[] = [];
  for (const step of steps) {
    if (step.kind !== 'tool') continue;
    for (const path of pathArguments(step.content)) {
      if (!ALLOWED.has(path) && !isInside(path, workDir, roots)) {
        violations.push({ tool: step.toolName ?? 'tool', path });
      }
    }
  }
  return violations;
}

/** One-line error for a run, naming the first few paths. */
export function describeViolations(violations: SandboxViolation[]): string {
  const shown = violations.slice(0, 3).map((v) => `${v.tool} ${v.path}`);
  const more = violations.length > 3 ? ` (+${violations.length - 3} more)` : '';
  return `sandbox violation: the agent accessed files outside its run folder: ${shown.join('; ')}${more}`;
}

function pathArguments(content: string): string[] {
  let args: unknown;
  try {
    args = JSON.parse(content);
  } catch {
    return [];
  }
  if (!args || typeof args !== 'object') return [];
  return Object.entries(args as Record<string, unknown>)
    .filter(([key]) => PATH_KEYS.has(key.toLowerCase()))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function isInside(path: string, workDir: string, roots: string[]): boolean {
  const expanded = path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
  const full = resolve(workDir, expanded);
  const candidates = [full, realOrSelf(full)];
  return candidates.some((p) => roots.some((root) => p === root || p.startsWith(root + sep)));
}

/** The folder as given and as resolved: on macOS /var/folders/... is really /private/var/folders/... */
function folderAliases(dir: string): string[] {
  const abs = resolve(dir);
  return [...new Set([abs, realOrSelf(abs)])];
}

function realOrSelf(path: string): string {
  try {
    return isAbsolute(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}
