export interface PlannedRun {
  taskId: string;
  configId: string;
  repeatIndex: number;
}

/**
 * Queue order for an experiment: repeat -> task -> (A, B).
 * A and B alternate, and every task finishes repeat 0 before any task starts repeat 1,
 * so slow drift over time (API latency, rate limits, model updates) hits both configs equally.
 */
export function buildRunPlan(
  taskIds: string[],
  configAId: string,
  configBId: string,
  repeats: number,
): PlannedRun[] {
  const plan: PlannedRun[] = [];
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
    for (const taskId of taskIds) {
      plan.push({ taskId, configId: configAId, repeatIndex });
      plan.push({ taskId, configId: configBId, repeatIndex });
    }
  }
  return plan;
}

export class TimeoutError extends Error {}

/** Resolves with the work's result, or rejects with TimeoutError after `ms` and aborts `controller`. */
export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
