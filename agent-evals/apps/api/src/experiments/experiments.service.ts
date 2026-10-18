import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Experiment,
  ExperimentStatus,
  ExperimentSummary,
  RunCounts,
  RunRecord,
  RunStatus,
  StepKind,
} from '@evals/shared';
import { DatabaseService } from '../db/database.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ExecutorService } from './executor.service.js';
import { buildRunPlan } from './run-plan.js';
import { summarize } from '../stats/stats.js';

const MAX_REPEATS = 50;

export interface CreateExperimentBody {
  name?: unknown;
  configAId?: unknown;
  configBId?: unknown;
  taskIds?: unknown;
  repeats?: unknown;
}

interface ExperimentRow {
  id: string;
  name: string;
  config_a_id: string;
  config_b_id: string;
  task_ids: string;
  repeats: number;
  status: ExperimentStatus;
  created_at: number;
  finished_at: number | null;
}

interface RunRow {
  id: string;
  experiment_id: string;
  task_id: string;
  config_id: string;
  repeat_index: number;
  status: RunStatus;
  passed: number | null;
  score_reason: string | null;
  judge_input_tokens: number | null;
  judge_output_tokens: number | null;
  judge_cost_usd: number | null;
  final_answer: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

interface StepRow {
  idx: number;
  kind: StepKind;
  tool_name: string | null;
  content: string;
  timestamp_ms: number | null;
}

@Injectable()
export class ExperimentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly catalog: CatalogService,
    private readonly executor: ExecutorService,
  ) {}

  create(body: CreateExperimentBody): Experiment & { runs: RunRecord[] } {
    const { name, configAId, configBId, taskIds, repeats } = this.validate(body);
    const db = this.database.db;
    const id = randomUUID();
    const plan = buildRunPlan(taskIds, configAId, configBId, repeats);

    const insertRun = db.prepare(
      `INSERT INTO runs (id, experiment_id, task_id, config_id, repeat_index, seq, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
    );

    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO experiments (id, name, config_a_id, config_b_id, task_ids, repeats, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(id, name, configAId, configBId, JSON.stringify(taskIds), repeats, Date.now());
      // seq is global, so experiments are processed first-come first-served.
      const { maxSeq } = db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM runs').get() as {
        maxSeq: number;
      };
      plan.forEach((p, i) => insertRun.run(randomUUID(), id, p.taskId, p.configId, p.repeatIndex, maxSeq + i + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    this.executor.kick();
    return this.get(id);
  }

  list(): Experiment[] {
    const rows = this.database.db
      .prepare('SELECT * FROM experiments ORDER BY created_at DESC')
      .all() as unknown as ExperimentRow[];
    return rows.map((r) => toExperiment(r, this.counts(r.id)));
  }

  get(id: string): Experiment & { runs: RunRecord[] } {
    const row = this.database.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
    if (!row) throw new NotFoundException(`Experiment ${id} not found`);
    const runs = this.database.db
      .prepare('SELECT * FROM runs WHERE experiment_id = ? ORDER BY seq')
      .all(id) as unknown as RunRow[];
    return { ...toExperiment(row as unknown as ExperimentRow, this.counts(id)), runs: runs.map(toRun) };
  }

  summary(id: string): ExperimentSummary {
    const exp = this.get(id);
    const name = (configId: string) => this.catalog.getConfig(configId)?.name ?? configId;
    return summarize({
      experimentId: exp.id,
      status: exp.status,
      configA: { id: exp.configAId, name: name(exp.configAId) },
      configB: { id: exp.configBId, name: name(exp.configBId) },
      tasks: exp.taskIds.map((t) => ({ id: t, name: this.catalog.getTask(t)?.name ?? t })),
      runs: exp.runs,
    });
  }

  getRun(id: string): RunRecord {
    const db = this.database.db;
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (!row) throw new NotFoundException(`Run ${id} not found`);
    const steps = db
      .prepare('SELECT idx, kind, tool_name, content, timestamp_ms FROM steps WHERE run_id = ? ORDER BY idx')
      .all(id) as unknown as StepRow[];
    return {
      ...toRun(row as unknown as RunRow),
      steps: steps.map((s) => ({
        index: s.idx,
        kind: s.kind,
        toolName: s.tool_name ?? undefined,
        content: s.content,
        timestampMs: s.timestamp_ms ?? undefined,
      })),
    };
  }

  retryErrors(id: string): { requeued: number } {
    const db = this.database.db;
    if (!db.prepare('SELECT 1 FROM experiments WHERE id = ?').get(id)) {
      throw new NotFoundException(`Experiment ${id} not found`);
    }
    const { changes } = db
      .prepare(
        `UPDATE runs SET status = 'queued', error = NULL, passed = NULL, score_reason = NULL,
           judge_input_tokens = NULL, judge_output_tokens = NULL, judge_cost_usd = NULL,
           started_at = NULL, finished_at = NULL
         WHERE experiment_id = ? AND status = 'error'`,
      )
      .run(id);
    if (changes) {
      db.prepare(`UPDATE experiments SET status = 'queued', finished_at = NULL WHERE id = ?`).run(id);
      this.executor.kick();
    }
    return { requeued: Number(changes) };
  }

  private counts(experimentId: string): RunCounts {
    const counts: RunCounts = { queued: 0, running: 0, done: 0, error: 0 };
    const rows = this.database.db
      .prepare('SELECT status, COUNT(*) AS n FROM runs WHERE experiment_id = ? GROUP BY status')
      .all(experimentId) as unknown as { status: RunStatus; n: number }[];
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  private validate(body: CreateExperimentBody) {
    const { name, configAId, configBId, repeats } = body ?? {};
    if (typeof name !== 'string' || !name.trim()) throw new BadRequestException('"name" is required');
    if (typeof configAId !== 'string' || !this.catalog.getConfig(configAId)) {
      throw new BadRequestException(`Unknown configAId "${String(configAId)}"`);
    }
    if (typeof configBId !== 'string' || !this.catalog.getConfig(configBId)) {
      throw new BadRequestException(`Unknown configBId "${String(configBId)}"`);
    }
    if (configAId === configBId) throw new BadRequestException('configAId and configBId must differ');
    if (!Number.isInteger(repeats) || (repeats as number) < 1 || (repeats as number) > MAX_REPEATS) {
      throw new BadRequestException(`"repeats" must be an integer from 1 to ${MAX_REPEATS}`);
    }

    let taskIds: string[];
    if (body.taskIds === undefined) {
      taskIds = this.catalog.listTasks().map((t) => t.id);
    } else {
      if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) {
        throw new BadRequestException('"taskIds" must be a non-empty array when given');
      }
      taskIds = [...new Set(body.taskIds as unknown[])].map(String);
      const unknown = taskIds.filter((t) => !this.catalog.getTask(t));
      if (unknown.length) throw new BadRequestException(`Unknown taskIds: ${unknown.join(', ')}`);
      const inactive = taskIds.filter((t) => !this.catalog.getTask(t)!.active);
      if (inactive.length) throw new BadRequestException(`Inactive taskIds: ${inactive.join(', ')}`);
    }
    if (taskIds.length === 0) throw new BadRequestException('No tasks to run');

    return { name: name.trim(), configAId, configBId, taskIds, repeats: repeats as number };
  }
}

function toExperiment(r: ExperimentRow, counts: RunCounts): Experiment {
  return {
    id: r.id,
    name: r.name,
    configAId: r.config_a_id,
    configBId: r.config_b_id,
    taskIds: JSON.parse(r.task_ids) as string[],
    repeats: r.repeats,
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    counts,
  };
}

function toRun(r: RunRow): RunRecord {
  return {
    id: r.id,
    experimentId: r.experiment_id,
    taskId: r.task_id,
    configId: r.config_id,
    repeatIndex: r.repeat_index,
    status: r.status,
    passed: r.passed === null ? null : r.passed === 1,
    scoreReason: r.score_reason,
    judgeInputTokens: r.judge_input_tokens,
    judgeOutputTokens: r.judge_output_tokens,
    judgeCostUsd: r.judge_cost_usd,
    finalAnswer: r.final_answer,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}
