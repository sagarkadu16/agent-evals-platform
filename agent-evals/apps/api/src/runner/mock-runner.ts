import type { RunResult, Step, TaskDef } from '@evals/shared';
import { hashString, mulberry32 } from '../common/random.js';
import type { AgentRunner, RunInput } from './agent-runner.js';

export const DEFAULT_MOCK_PASS_RATE = 0.7;

/**
 * Fake runner for building and demoing the platform without calling Hermes.
 * Deterministic: everything random is drawn from an RNG seeded by runId,
 * so re-running the same run gives the same answer, steps, tokens and delay.
 */
export class MockRunner implements AgentRunner {
  readonly name = 'mock';

  async run({ runId, task, config }: RunInput): Promise<RunResult> {
    try {
      const rand = mulberry32(hashString(runId));
      const passRate = config.mockPassRate ?? DEFAULT_MOCK_PASS_RATE;

      // Draw in a fixed order so each value depends only on runId.
      const pass = rand() < passRate;
      const delayMs = 100 + Math.floor(rand() * 301);
      const stepCount = 2 + Math.floor(rand() * 3);
      const finalAnswer = pass ? (task.referenceAnswer ?? '') : wrongAnswer(task, rand);

      await sleep(delayMs);

      return {
        finalAnswer,
        steps: fakeSteps(stepCount, finalAnswer, Date.now() - delayMs, delayMs),
        tokens: {
          input: 200 + Math.floor(rand() * 800),
          output: 20 + Math.floor(rand() * 200),
        },
        costUsd: 0,
      };
    } catch (err) {
      return {
        finalAnswer: '',
        steps: [],
        tokens: { input: 0, output: 0 },
        costUsd: 0,
        error: `MockRunner failed: ${(err as Error).message}`,
      };
    }
  }
}

/** A wrong answer that still looks like a real attempt. */
function wrongAnswer(task: TaskDef, rand: () => number): string {
  const ref = task.referenceAnswer?.trim() ?? '';
  if (/^-?\d+$/.test(ref)) {
    // Off-by-a-bit numbers, like a real arithmetic slip.
    const offset = 1 + Math.floor(rand() * 20);
    return String(Number(ref) + (rand() < 0.5 ? -offset : offset));
  }
  const options = [
    'I could not find enough information to answer this confidently.',
    'It depends on the situation; there is no single correct approach here.',
    'You should retry the request immediately until it succeeds.',
  ];
  return options[Math.floor(rand() * options.length)];
}

/** 2-4 steps: (tool, result) pairs then a final model step. */
function fakeSteps(count: number, finalAnswer: string, startMs: number, totalMs: number): Step[] {
  const steps: Step[] = [];
  const at = (i: number) => startMs + Math.round((totalMs * (i + 1)) / count);
  for (let i = 0; i < count - 1; i++) {
    steps.push(
      i % 2 === 0
        ? { index: i, kind: 'tool', toolName: 'read_file', content: '{"path":"notes.txt"}', timestampMs: at(i) }
        : { index: i, kind: 'result', toolName: 'read_file', content: '(mock file contents)', timestampMs: at(i) },
    );
  }
  steps.push({ index: count - 1, kind: 'model', content: finalAnswer, timestampMs: at(count - 1) });
  return steps;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
