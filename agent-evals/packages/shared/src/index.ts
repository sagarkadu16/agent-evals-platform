export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  provider: string;
  toolsets: string[];
  skills: string[];
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
    explanation: string;
  };
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
}