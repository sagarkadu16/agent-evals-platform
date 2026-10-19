import { resolve } from 'node:path';

/**
 * Root folder that holds config assets: `skills/<name>/SKILL.md` and `memory/*.md`.
 * Defaults to the repo root, two levels above apps/api where the API runs, like SEED_DIR and RUNS_DIR.
 */
export function assetsRoot(): string {
  return resolve(process.env.ASSETS_DIR ?? '../..');
}

/** Skill names are folder names under skills/: lowercase letters, digits, "-" and "_". */
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Config memory files must live in this folder (e.g. "memory/sales-policy.md"). */
export const MEMORY_DIR = 'memory';

/** Hermes' character limit for MEMORY.md. Over it, Hermes still loads but the agent sees a full memory. */
export const MEMORY_CHAR_LIMIT = 2200;

/** Hermes separates MEMORY.md entries with this line. Each memory file becomes one entry. */
export const MEMORY_ENTRY_DELIMITER = '\n§\n';
