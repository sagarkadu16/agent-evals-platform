import { Injectable, Logger } from '@nestjs/common';
import type { RunResult, TaskDef } from '@evals/shared';
import { JudgeScorer } from './judge-scorer.js';
import { MockJudgeScorer } from './mock-judge-scorer.js';
import { RegexScorer } from './regex-scorer.js';
import type { Scorer, ScoreResult } from './scorer.js';

/**
 * Which judge to use. The real (paid) judge is the default only with the real runner,
 * so mock experiments never spend money even when OPENROUTER_API_KEY is set.
 */
function judgeKind(): 'openrouter' | 'mock' {
  const kind = process.env.JUDGE ?? (process.env.RUNNER === 'hermes' ? 'openrouter' : 'mock');
  if (kind !== 'openrouter' && kind !== 'mock') {
    throw new Error(`Unknown JUDGE "${kind}" (expected "openrouter" or "mock")`);
  }
  return kind;
}

/** Picks the scorer for a task's scorerType. */
@Injectable()
export class ScoringService {
  private readonly log = new Logger(ScoringService.name);
  private readonly scorers: Record<TaskDef['scorerType'], Scorer>;

  constructor() {
    const judge = judgeKind();
    this.scorers = {
      regex: new RegexScorer(),
      judge: judge === 'openrouter' ? new JudgeScorer() : new MockJudgeScorer(),
    };
    this.log.log(`Judge: ${judge}${judge === 'openrouter' ? ` (${process.env.JUDGE_MODEL ?? 'default model'})` : ''}`);
  }

  async score(task: TaskDef, result: RunResult): Promise<ScoreResult> {
    const scorer = this.scorers[task.scorerType];
    if (!scorer) return { passed: null, reason: `no scorer for type "${task.scorerType}"` };
    try {
      return await scorer.score(task, result);
    } catch (err) {
      // Scorers shouldn't throw; if one does, the run is unscored rather than failed.
      return { passed: null, reason: `scorer error: ${(err as Error).message}` };
    }
  }
}
