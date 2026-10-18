import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentConfig, RunResult, TaskDef } from '@evals/shared';
import { DatabaseService } from '../db/database.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { AGENT_RUNNER, type AgentRunner } from '../runner/agent-runner.js';
import { ScoringService } from '../scoring/scoring.service.js';
import type { ScoreResult } from '../scoring/scorer.js';
import { resolveInside } from '../common/safe-path.js';
import { withTimeout } from './run-plan.js';

/** Extra time on top of config.runBudgetSec before the executor gives up on a run. */
const TIMEOUT_MARGIN_SEC = 30;

interface QueuedRow {
  id: string;
  experiment_id: string;
  task_id: string;
  config_id: string;
}

/** reason is null only for runs that were never scored (runner error). */
type Score = Omit<ScoreResult, 'reason'> & { reason: string | null };

/**
 * In-process queue. The DB is the queue: runs with status 'queued' are picked in `seq` order.
 * Nothing is held only in memory, so a restart loses no work (see onApplicationBootstrap).
 */
@Injectable()
export class ExecutorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(ExecutorService.name);
  private readonly concurrency = Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? 1) || 1);
  private readonly runsDir = resolve(process.env.RUNS_DIR ?? 'runs');
  private active = 0;
  private stopping = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly catalog: CatalogService,
    private readonly scoring: ScoringService,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
  ) {}

  onApplicationBootstrap() {
    // A run left in 'running' means the process died mid-run. Its result is lost, so run it again.
    const { changes } = this.database.db
      .prepare(`UPDATE runs SET status = 'queued', started_at = NULL WHERE status = 'running'`)
      .run();
    if (changes) this.log.warn(`Re-queued ${changes} run(s) left in "running" by a previous process`);
    this.log.log(`Queue ready: runner=${this.runner.name}, concurrency=${this.concurrency}`);
    this.kick();
  }

  onModuleDestroy() {
    // In-flight runs stay 'running' in the DB and are re-queued on next startup.
    this.stopping = true;
  }

  /** Start queued runs until the concurrency limit is reached. Safe to call any time. */
  kick() {
    while (!this.stopping && this.active < this.concurrency) {
      const run = this.claimNext();
      if (!run) return;
      this.active++;
      void this.execute(run).finally(() => {
        this.active--;
        this.kick();
      });
    }
  }

  /** Atomically move the next queued run to 'running'. node:sqlite is synchronous, so no other claim can interleave. */
  private claimNext(): QueuedRow | undefined {
    const db = this.database.db;
    const row = db
      .prepare(
        `UPDATE runs SET status = 'running', started_at = ?
         WHERE id = (SELECT id FROM runs WHERE status = 'queued' ORDER BY seq LIMIT 1)
         RETURNING id, experiment_id, task_id, config_id`,
      )
      .get(Date.now()) as unknown as QueuedRow | undefined;
    if (row) {
      db.prepare(`UPDATE experiments SET status = 'running' WHERE id = ? AND status = 'queued'`).run(
        row.experiment_id,
      );
    }
    return row;
  }

  private async execute(row: QueuedRow) {
    const started = Date.now();
    const task = this.catalog.getTask(row.task_id);
    const config = this.catalog.getConfig(row.config_id);

    let result: RunResult;
    if (!task || !config) {
      result = errorResult(`task or config no longer exists (${row.task_id}, ${row.config_id})`);
    } else {
      result = await this.runWithTimeout(row.id, task, config);
    }

    if (this.stopping) return;

    // SCORING HOOK. Runner errors are not scored: passed stays NULL so they count as errors, not failures.
    const score: Score =
      result.error || !task ? { passed: null, reason: null } : await this.scoring.score(task, result);

    if (this.stopping) return;
    this.save(row, result, score, Date.now() - started);
    this.finishExperimentIfDone(row.experiment_id);
    this.log.log(`Run ${row.id} ${result.error ? `error: ${result.error}` : 'done'}`);
  }

  private async runWithTimeout(runId: string, task: TaskDef, config: AgentConfig): Promise<RunResult> {
    const workDir = join(this.runsDir, runId);
    try {
      // Fresh folder every attempt, so a retried run never sees files from its failed attempt.
      rmSync(workDir, { recursive: true, force: true });
      mkdirSync(workDir, { recursive: true });
      for (const [path, content] of Object.entries(task.files ?? {})) {
        const file = resolveInside(workDir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, 'utf8');
      }
      return await withTimeout(
        (signal) => this.runner.run({ runId, task, config, workDir, signal }),
        (config.runBudgetSec + TIMEOUT_MARGIN_SEC) * 1000,
      );
    } catch (err) {
      // TimeoutError lands here too. run() should never throw, but don't trust it with the queue.
      return errorResult((err as Error).message);
    }
  }

  private save(row: QueuedRow, result: RunResult, score: Score, durationMs: number) {
    const db = this.database.db;
    const insertStep = db.prepare(
      `INSERT INTO steps (run_id, idx, kind, tool_name, content, timestamp_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE runs SET
           status = :status, passed = :passed, score_reason = :score_reason,
           judge_input_tokens = :judge_input_tokens, judge_output_tokens = :judge_output_tokens,
           judge_cost_usd = :judge_cost_usd,
           final_answer = :final_answer, input_tokens = :input_tokens, output_tokens = :output_tokens,
           cost_usd = :cost_usd, duration_ms = :duration_ms, error = :error, session_id = :session_id,
           finished_at = :finished_at
         WHERE id = :id`,
      ).run({
        id: row.id,
        status: result.error ? 'error' : 'done',
        passed: score.passed === null ? null : Number(score.passed),
        score_reason: score.reason,
        judge_input_tokens: score.judgeTokens?.input ?? null,
        judge_output_tokens: score.judgeTokens?.output ?? null,
        judge_cost_usd: score.judgeCostUsd ?? null,
        final_answer: result.finalAnswer,
        input_tokens: result.tokens.input,
        output_tokens: result.tokens.output,
        cost_usd: result.costUsd,
        duration_ms: durationMs,
        error: result.error ?? null,
        session_id: result.sessionId ?? null,
        finished_at: Date.now(),
      });
      // A retried run replaces the steps of its earlier attempt.
      db.prepare('DELETE FROM steps WHERE run_id = ?').run(row.id);
      for (const s of result.steps) {
        insertStep.run(row.id, s.index, s.kind, s.toolName ?? null, s.content, s.timestampMs ?? null);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      this.log.error(`Could not save run ${row.id}: ${(err as Error).message}`);
    }
  }

  private finishExperimentIfDone(experimentId: string) {
    this.database.db
      .prepare(
        `UPDATE experiments SET status = 'done', finished_at = ?
         WHERE id = ? AND status != 'done'
           AND NOT EXISTS (SELECT 1 FROM runs WHERE experiment_id = ? AND status IN ('queued', 'running'))`,
      )
      .run(Date.now(), experimentId, experimentId);
  }
}

function errorResult(error: string): RunResult {
  return { finalAnswer: '', steps: [], tokens: { input: 0, output: 0 }, costUsd: null, error };
}
