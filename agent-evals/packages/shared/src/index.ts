export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  provider: string;
  toolsets: string[];
  skills: string[];
  maxTurns: number;
  runBudgetSec: number;
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
