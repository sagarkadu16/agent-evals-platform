import type { RunResult, TaskDef } from '@evals/shared';
import type { Scorer, ScoreResult } from './scorer.js';

const PREVIEW_CHARS = 100;

/** Passes when task.scorerSpec.pattern (with optional scorerSpec.flags) matches the trimmed final answer. */
export class RegexScorer implements Scorer {
  async score(task: TaskDef, result: RunResult): Promise<ScoreResult> {
    const { pattern, flags } = task.scorerSpec;
    if (typeof pattern !== 'string') {
      return { passed: null, reason: 'scorer spec error: "pattern" is missing' };
    }

    let re: RegExp;
    try {
      re = new RegExp(pattern, typeof flags === 'string' ? flags : undefined);
    } catch (err) {
      // A broken spec is our bug, not the agent's failure.
      return { passed: null, reason: `scorer spec error: ${(err as Error).message}` };
    }

    const answer = result.finalAnswer.trim();
    if (re.test(answer)) return { passed: true, reason: `matched ${re}` };
    const got = answer ? answer.slice(0, PREVIEW_CHARS) : '(empty answer)';
    return { passed: false, reason: `no match for ${re}; got: ${got}` };
  }
}
