import type { RunResult, TaskDef } from '@evals/shared';
import type { Scorer, ScoreResult } from './scorer.js';

/**
 * Free stand-in for the LLM judge, used with the MockRunner so mock experiments never spend money.
 * Passes when the answer equals the task's referenceAnswer (which is what MockRunner returns on a pass).
 */
export class MockJudgeScorer implements Scorer {
  async score(task: TaskDef, result: RunResult): Promise<ScoreResult> {
    if (!task.referenceAnswer) return { passed: null, reason: 'mock judge: task has no referenceAnswer' };
    const passed = result.finalAnswer.trim() === task.referenceAnswer.trim();
    return {
      passed,
      reason: passed ? 'mock judge: matches reference answer' : 'mock judge: differs from reference answer',
      judgeTokens: { input: 0, output: 0 },
      judgeCostUsd: 0,
    };
  }
}
