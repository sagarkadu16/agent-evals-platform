import { Injectable } from '@nestjs/common';
import type { AgentConfig, ScorerType, TaskDef } from '@evals/shared';
import { DatabaseService } from '../db/database.service.js';

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  scorer_type: ScorerType;
  scorer_spec: string;
  reference_answer: string | null;
  files: string | null;
  tags: string;
  active: number;
}

interface ConfigRow {
  id: string;
  name: string;
  model: string;
  provider: string;
  toolsets: string;
  skills: string;
  memory_files: string;
  max_turns: number;
  run_budget_sec: number;
  mock_pass_rate: number | null;
}

@Injectable()
export class CatalogService {
  constructor(private readonly database: DatabaseService) {}

  /** Active tasks only: the ones offered for new experiments. */
  listTasks(): TaskDef[] {
    const rows = this.database.db
      .prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY id')
      .all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  listConfigs(): AgentConfig[] {
    const rows = this.database.db
      .prepare('SELECT * FROM configs ORDER BY id')
      .all() as unknown as ConfigRow[];
    return rows.map(toConfig);
  }

  /** Any task, active or not, so old experiments can still show their tasks. */
  getTask(id: string): TaskDef | undefined {
    const row = this.database.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? toTask(row as unknown as TaskRow) : undefined;
  }

  getConfig(id: string): AgentConfig | undefined {
    const row = this.database.db.prepare('SELECT * FROM configs WHERE id = ?').get(id);
    return row ? toConfig(row as unknown as ConfigRow) : undefined;
  }
}

function toTask(r: TaskRow): TaskDef {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    scorerType: r.scorer_type,
    scorerSpec: JSON.parse(r.scorer_spec) as Record<string, unknown>,
    referenceAnswer: r.reference_answer ?? undefined,
    files: r.files ? (JSON.parse(r.files) as Record<string, string>) : undefined,
    active: r.active === 1,
    tags: JSON.parse(r.tags) as string[],
  };
}

function toConfig(r: ConfigRow): AgentConfig {
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    provider: r.provider,
    toolsets: JSON.parse(r.toolsets) as string[],
    skills: JSON.parse(r.skills) as string[],
    memoryFiles: JSON.parse(r.memory_files) as string[],
    maxTurns: r.max_turns,
    runBudgetSec: r.run_budget_sec,
    mockPassRate: r.mock_pass_rate ?? undefined,
  };
}
