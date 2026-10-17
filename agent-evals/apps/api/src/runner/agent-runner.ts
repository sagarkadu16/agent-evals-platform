import type { AgentConfig, RunResult, TaskDef } from '@evals/shared';

/** Everything a runner needs to perform one run. */
export interface RunInput {
  runId: string;
  task: TaskDef;
  config: AgentConfig;
  /** A fresh, empty folder for this run only (Hermes --in DIR). */
  workDir: string;
}

/**
 * The contract every runner follows.
 * Rule: run() never throws. On failure it returns a RunResult with `error` set,
 * so one bad run is recorded instead of crashing the whole experiment.
 */
export interface AgentRunner {
  readonly name: string;
  run(input: RunInput): Promise<RunResult>;
}

/** Injection token: TypeScript interfaces vanish at runtime, so Nest needs a real value to look up. */
export const AGENT_RUNNER = Symbol('AGENT_RUNNER');
