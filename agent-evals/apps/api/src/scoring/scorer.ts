import type { RunResult, TaskDef } from '@evals/shared';

/** passed = null means "could not score" (bad spec, judge down); it is never counted as a failure. */
export interface ScoreResult {
  passed: boolean | null;
  reason: string;
  /** Only set by scorers that call a model (the judge). */
  judgeTokens?: { input: number; output: number };
  judgeCostUsd?: number | null;
}

/** Same rule as AgentRunner: score() never throws, it returns passed = null with a reason. */
export interface Scorer {
  score(task: TaskDef, result: RunResult): Promise<ScoreResult>;
}
