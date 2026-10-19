import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_CHAR_LIMIT, MEMORY_DIR, MEMORY_ENTRY_DELIMITER, SKILL_NAME } from '../common/assets.js';
import { resolveInside } from '../common/safe-path.js';
import { HARNESS_RULE } from './sandbox.js';

export interface RunHomeOptions {
  /** Prepared once by HermesRunner; its installs/ folder is shared by every run home. */
  baseHome: string;
  /** Folder holding skills/ and memory/ (the repo root by default). */
  assetsDir: string;
  skills: string[];
  memoryFiles?: string[];
}

/**
 * Hermes keeps everything under HERMES_HOME: config, .env, skills, memory, sessions. Each run gets a
 * fresh home in the OS temp folder, so runs can't see each other's state and never touch ~/.hermes.
 *
 * A brand-new home makes Hermes install its Python dependencies first (~25 s, ~350 MB). To avoid that
 * per run, one shared base home is prepared once and its `installs/` folder is symlinked into each run home.
 *
 * Memory starts fresh every run, built only from the config's memory files, so no run can learn from
 * another. (With our toolsets the agent has no memory tool, so it can read memory but not write it.)
 *
 * SOUL.md (Hermes' persona, always in the system prompt) is the base home's default plus the harness
 * rule "only use your working folder", identical for every config.
 *
 * The home lives outside the run's work folder so the agent's file tools can't list or read it.
 */
export function createRunHome({ baseHome, assetsDir, skills, memoryFiles = [] }: RunHomeOptions): string {
  // Check every skill and memory file before creating anything, so a bad config leaves nothing behind.
  const skillSources = skills.map((name) => {
    if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name "${name}"`);
    const dir = join(assetsDir, 'skills', name);
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`skill "${name}" not found at ${dir}/SKILL.md`);
    return { name, dir };
  });
  const memory = buildMemory(assetsDir, memoryFiles);

  const home = mkdtempSync(join(tmpdir(), 'evals-hermes-home-'));
  try {
    symlinkSync(join(baseHome, 'installs'), join(home, 'installs'), 'dir');
    mkdirSync(join(home, 'skills'));
    for (const { name, dir } of skillSources) cpSync(dir, join(home, 'skills', name), { recursive: true });
    mkdirSync(join(home, 'memories'));
    if (memory) writeFileSync(join(home, 'memories', 'MEMORY.md'), memory, 'utf8');
    writeFileSync(join(home, 'SOUL.md'), buildSoul(baseHome), 'utf8');
    return home;
  } catch (err) {
    removeRunHome(home);
    throw err;
  }
}

/** Hermes' default persona from the base home (when it has one), then the harness rule. */
export function buildSoul(baseHome: string): string {
  const soulPath = join(baseHome, 'SOUL.md');
  const persona = existsSync(soulPath) ? readFileSync(soulPath, 'utf8').trim() : '';
  return persona ? `${persona}\n\n${HARNESS_RULE}\n` : `${HARNESS_RULE}\n`;
}

/** MEMORY.md content in Hermes' format: one entry per file, joined by "§" lines. Empty when no files. */
export function buildMemory(assetsDir: string, memoryFiles: string[]): string {
  const entries = memoryFiles.map((path) => {
    if (!path.startsWith(`${MEMORY_DIR}/`)) throw new Error(`memory file "${path}" is not under ${MEMORY_DIR}/`);
    const file = resolveInside(assetsDir, path);
    if (!existsSync(file)) throw new Error(`memory file "${path}" not found at ${file}`);
    return readFileSync(file, 'utf8').trim();
  });
  const memory = entries.join(MEMORY_ENTRY_DELIMITER);
  if (memory.length > MEMORY_CHAR_LIMIT) {
    throw new Error(`memory is ${memory.length} chars; Hermes allows ${MEMORY_CHAR_LIMIT}`);
  }
  return memory;
}

/** Deletes a run home. Only removes the symlink to the shared installs, never the installs themselves. */
export function removeRunHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}
