export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  provider: string;
  toolsets: string[];
  skills: string[];
  /**
   * Memory files (paths under memory/) written into a fresh Hermes memory for every run of this config.
   * Hermes injects them into the system prompt. Omitted or empty means no memory.
   */
  memoryFiles?: string[];
  maxTurns: number;
  runBudgetSec: number;
  /** MockRunner only: probability (0..1) that a run passes. Default 0.7. */
  mockPassRate?: number;
}

export type StepKind = 'tool' | 'result' | 'model';

export interface Step {
  index: number;
  kind: StepKind;
  toolName?: string;
  content: string;
  timestampMs?: number;
}

export interface RunResult {
  finalAnswer: string;
  steps: Step[];
  tokens: { input: number; output: number };
  costUsd: number | null;
  /** Hermes session id, for looking the session up later. */
  sessionId?: string;
  error?: string;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'error';

export type ExperimentStatus = 'queued' | 'running' | 'done';

export type RunCounts = Record<RunStatus, number>;

export interface Experiment {
  id: string;
  name: string;
  configAId: string;
  configBId: string;
  taskIds: string[];
  repeats: number;
  status: ExperimentStatus;
  createdAt: number;
  finishedAt: number | null;
  counts: RunCounts;
}

export interface RunRecord {
  id: string;
  experimentId: string;
  taskId: string;
  configId: string;
  repeatIndex: number;
  status: RunStatus;
  /** NULL until scored; stays NULL for runs that errored. */
  passed: boolean | null;
  scoreReason: string | null;
  judgeInputTokens: number | null;
  judgeOutputTokens: number | null;
  judgeCostUsd: number | null;
  finalAnswer: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  steps?: Step[];
}

/** Always from B's point of view: 'better' means B beats A. */
export type Verdict = 'better' | 'worse' | 'inconclusive';

/** Why the pass-rate verdict is what it is, so the UI can say more than "inconclusive". */
export type QualityReason =
  | 'no-data' // no task has scored runs on both sides yet
  | 'too-few-tasks' // fewer tasks than a confidence interval needs
  | 'no-difference' // both configs passed exactly the same share on every task
  | 'ci-includes-zero' // a difference, but not a reliable one
  | 'ci-above-zero' // B reliably passes more often
  | 'ci-below-zero'; // B reliably passes less often

/**
 * B compared with A on a per-run number (time or cost), as the ratio B / A.
 * The CI comes from resampling runs within each task, so it exists even for a single task.
 */
export interface MetricComparison {
  /** Duration uses the median (robust to one slow run); cost uses the mean (it adds up to the bill). */
  statistic: 'median' | 'mean';
  a: number | null;
  b: number | null;
  /** b / a: below 1 means B is faster or cheaper. Null when A's value is 0 or there is no data. */
  ratio: number | null;
  ci95: { low: number; high: number } | null;
  /** lower / higher when the whole CI is below / above 1; similar when it includes 1. */
  verdict: 'lower' | 'higher' | 'similar' | null;
  runsA: number;
  runsB: number;
}

export interface ConfigStats {
  configId: string;
  configName: string;
  runs: number;
  /** Runs with passed = true/false. Errors and judge errors are not scored. */
  scored: number;
  passed: number;
  /** Runs whose runner failed (status 'error'). */
  errors: number;
  /** Queued or running. */
  pending: number;
  /** passed / scored, or null when nothing is scored. */
  passRate: number | null;
  avgDurationMs: number | null;
  agentCostUsd: number;
  judgeCostUsd: number;
  totalCostUsd: number;
}

export interface TaskStats {
  taskId: string;
  taskName: string;
  a: { scored: number; passed: number; passRate: number | null };
  b: { scored: number; passed: number; passRate: number | null };
}

export interface ExperimentSummary {
  experimentId: string;
  status: ExperimentStatus;
  configA: ConfigStats;
  configB: ConfigStats;
  tasks: TaskStats[];
  comparison: {
    /** Tasks with scored runs for both configs; only these enter the difference and the CI. */
    tasksUsed: number;
    /** passRate(B) - passRate(A) on scored runs, as a fraction (0.1 = 10 points). */
    difference: number | null;
    ci95: { low: number; high: number } | null;
    iterations: number;
    seed: number;
    verdict: Verdict;
    reason: QualityReason;
    explanation: string;
  };
  /** Wall-clock time per finished run, in ms. */
  speed: MetricComparison;
  /** Agent (model) cost per finished run, in USD. Judge cost is the platform's, not the config's. */
  cost: MetricComparison & { perPassA: number | null; perPassB: number | null };
  /** One sentence over quality, speed and cost, e.g. "Same pass rate; B is 1.6× faster and 17× more expensive." */
  headline: string;
}

export type ScorerType = 'regex' | 'judge';

export interface TaskDef {
  id: string;
  name: string;
  prompt: string;
  scorerType: ScorerType;
  scorerSpec: Record<string, unknown>;
  /** A known-good answer. MockRunner returns it on a pass. */
  referenceAnswer?: string;
  /** Files written into each run's fresh folder before the agent starts: relative path -> content. */
  files?: Record<string, string>;
  /** False once the task is removed from tasks.json: kept for old results, not offered for new experiments. */
  active?: boolean;
  /** Short labels for finding tasks in the picker, e.g. "sales", "memory". */
  tags?: string[];
}

export * from './config-diff.js';
