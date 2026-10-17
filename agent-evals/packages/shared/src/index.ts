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
  error?: string;
}

export type Verdict = 'better' | 'worse' | 'inconclusive';

export type ScorerType = 'regex' | 'judge';

export interface TaskDef {
  id: string;
  name: string;
  prompt: string;
  scorerType: ScorerType;
  scorerSpec: Record<string, unknown>;
  /** A known-good answer. MockRunner returns it on a pass. */
  referenceAnswer?: string;
}