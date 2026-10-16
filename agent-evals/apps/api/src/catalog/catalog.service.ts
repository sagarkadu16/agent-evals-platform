import { Injectable } from '@nestjs/common';
import type { AgentConfig, ScorerType, TaskDef } from '@evals/shared';
import { DatabaseService } from '../db/database.service.js';

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  scorer_type: ScorerType;
  scorer_spec: string;
}

interface ConfigRow {
  id: string;
  name: string;
  model: string;
  provider: string;
  toolsets: string;
  skills: string;
  max_turns: number;
  run_budget_sec: number;
}

@Injectable()
export class CatalogService {
  constructor(private readonly database: DatabaseService) {}

  listTasks(): TaskDef[] {
    const rows = this.database.db
      .prepare('SELECT * FROM tasks ORDER BY id')
      .all() as unknown as TaskRow[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      scorerType: r.scorer_type,
      scorerSpec: JSON.parse(r.scorer_spec) as Record<string, unknown>,
    }));
  }

  listConfigs(): AgentConfig[] {
    const rows = this.database.db
      .prepare('SELECT * FROM configs ORDER BY id')
      .all() as unknown as ConfigRow[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      model: r.model,
      provider: r.provider,
      toolsets: JSON.parse(r.toolsets) as string[],
      skills: JSON.parse(r.skills) as string[],
      maxTurns: r.max_turns,
      runBudgetSec: r.run_budget_sec,
    }));
  }
}
