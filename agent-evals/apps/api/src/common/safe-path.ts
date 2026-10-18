import { isAbsolute, normalize, resolve, sep } from 'node:path';

/** True for a plain relative path like "data/orders.csv": no absolute paths, no "..", no backslashes. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || isAbsolute(p) || p.includes('\\') || p.includes('\0')) return false;
  return !normalize(p).split(sep).includes('..') && !p.split('/').includes('..');
}

/** Resolves `p` inside `root`, or throws if it would land outside it. */
export function resolveInside(root: string, p: string): string {
  const base = resolve(root);
  const full = resolve(base, p);
  if (!isSafeRelativePath(p) || !full.startsWith(base + sep)) {
    throw new Error(`unsafe file path "${p}"`);
  }
  return full;
}
