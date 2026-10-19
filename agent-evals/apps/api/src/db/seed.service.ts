import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentConfig } from '@evals/shared';
import { DatabaseService } from './database.service.js';
import { isSafeRelativePath } from '../common/safe-path.js';
import { MEMORY_DIR } from '../common/assets.js';

interface SeedTask {
  id: string;
  name: string;
  prompt: string;
  referenceAnswer?: string;
  files?: Record<string, string>;
  tags?: string[];
  scorer: { type: 'regex' | 'judge'; [key: string]: unknown };
}

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly log = new Logger(SeedService.name);

  constructor(private readonly database: DatabaseService) {}

  onModuleInit() {
    const dir = resolve(process.env.SEED_DIR ?? 'seed');
    const tasks = readJson<SeedTask[]>(join(dir, 'tasks.json'));
    const configs = readJson<AgentConfig[]>(join(dir, 'configs.json'));

    tasks.forEach(validateTask);
    configs.forEach(validateConfig);

    const db = this.database.db;

    const upsertTask = db.prepare(`
      INSERT INTO tasks (id, name, prompt, scorer_type, scorer_spec, reference_answer, files, tags)
      VALUES (:id, :name, :prompt, :scorer_type, :scorer_spec, :reference_answer, :files, :tags)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        prompt = excluded.prompt,
        scorer_type = excluded.scorer_type,
        scorer_spec = excluded.scorer_spec,
        reference_answer = excluded.reference_answer,
        files = excluded.files,
        tags = excluded.tags,
        active = 1
    `);

    const upsertConfig = db.prepare(`
      INSERT INTO configs (id, name, model, provider, toolsets, skills, memory_files, max_turns, run_budget_sec, mock_pass_rate)
      VALUES (:id, :name, :model, :provider, :toolsets, :skills, :memory_files, :max_turns, :run_budget_sec, :mock_pass_rate)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        model = excluded.model,
        provider = excluded.provider,
        toolsets = excluded.toolsets,
        skills = excluded.skills,
        memory_files = excluded.memory_files,
        max_turns = excluded.max_turns,
        run_budget_sec = excluded.run_budget_sec,
        mock_pass_rate = excluded.mock_pass_rate
    `);

    db.exec('BEGIN');
    try {
      for (const t of tasks) {
        const { type, ...spec } = t.scorer;
        upsertTask.run({
          id: t.id,
          name: t.name,
          prompt: t.prompt,
          scorer_type: type,
          scorer_spec: JSON.stringify(spec),
          reference_answer: t.referenceAnswer ?? null,
          files: t.files ? JSON.stringify(t.files) : null,
          tags: JSON.stringify(t.tags ?? []),
        });
      }
      // Tasks no longer in tasks.json are retired, not deleted: their past runs still point at them.
      db.prepare(
        `UPDATE tasks SET active = 0 WHERE id NOT IN (SELECT value FROM json_each(?))`,
      ).run(JSON.stringify(tasks.map((t) => t.id)));
      for (const c of configs) {
        upsertConfig.run({
          id: c.id,
          name: c.name,
          model: c.model,
          provider: c.provider,
          toolsets: JSON.stringify(c.toolsets),
          skills: JSON.stringify(c.skills),
          memory_files: JSON.stringify(c.memoryFiles ?? []),
          max_turns: c.maxTurns,
          run_budget_sec: c.runBudgetSec,
          mock_pass_rate: c.mockPassRate ?? null,
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    this.log.log(`Seeded ${tasks.length} tasks and ${configs.length} configs from ${dir}`);
  }
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    throw new Error(`Could not read seed file ${file}: ${(err as Error).message}`);
  }
}

function validateTask(t: SeedTask) {
  for (const key of ['id', 'name', 'prompt', 'scorer'] as const) {
    if (!t[key]) throw new Error(`Seed task "${t.id ?? '?'}" is missing "${key}"`);
  }
  if (t.scorer.type === 'regex' && typeof t.scorer.pattern !== 'string') {
    throw new Error(`Seed task "${t.id}" uses regex scorer but has no "pattern"`);
  }
  if (t.scorer.type === 'judge' && typeof t.scorer.rubric !== 'string') {
    throw new Error(`Seed task "${t.id}" uses judge scorer but has no "rubric"`);
  }
  if (t.scorer.type !== 'regex' && t.scorer.type !== 'judge') {
    throw new Error(`Seed task "${t.id}" has unknown scorer type "${t.scorer.type}"`);
  }
  if (t.referenceAnswer !== undefined && typeof t.referenceAnswer !== 'string') {
    throw new Error(`Seed task "${t.id}" has a non-string "referenceAnswer"`);
  }
  if (t.files !== undefined) {
    if (typeof t.files !== 'object' || t.files === null || Array.isArray(t.files)) {
      throw new Error(`Seed task "${t.id}" has "files" that is not an object of path -> content`);
    }
    for (const [path, content] of Object.entries(t.files)) {
      if (!isSafeRelativePath(path)) throw new Error(`Seed task "${t.id}" has unsafe file path "${path}"`);
      if (typeof content !== 'string') throw new Error(`Seed task "${t.id}" file "${path}" content is not a string`);
    }
  }
  if (t.tags !== undefined && (!Array.isArray(t.tags) || !t.tags.every((tag) => TAG.test(tag)))) {
    throw new Error(`Seed task "${t.id}" has "tags" that are not short lowercase labels`);
  }
}

/** Task tags are short lowercase labels like "sales" or "multi-step". */
const TAG = /^[a-z][a-z0-9 -]{0,23}$/;

function validateConfig(c: AgentConfig) {
  for (const key of ['id', 'name', 'model', 'provider', 'toolsets', 'skills', 'maxTurns', 'runBudgetSec'] as const) {
    if (c[key] === undefined) throw new Error(`Seed config "${c.id ?? '?'}" is missing "${key}"`);
  }
  if (
    c.mockPassRate !== undefined &&
    (typeof c.mockPassRate !== 'number' || c.mockPassRate < 0 || c.mockPassRate > 1)
  ) {
    throw new Error(`Seed config "${c.id}" has "mockPassRate" outside 0..1`);
  }
  if (c.memoryFiles !== undefined) {
    if (!Array.isArray(c.memoryFiles)) throw new Error(`Seed config "${c.id}" has "memoryFiles" that is not an array`);
    for (const p of c.memoryFiles) {
      if (typeof p !== 'string' || !isSafeRelativePath(p) || !p.startsWith(`${MEMORY_DIR}/`)) {
        throw new Error(`Seed config "${c.id}" has memory file "${String(p)}" that is not a path under ${MEMORY_DIR}/`);
      }
    }
  }
}
