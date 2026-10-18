import type {
  AgentConfig,
  Experiment,
  ExperimentSummary,
  RunRecord,
  TaskDef,
} from '@evals/shared'

export type ExperimentDetail = Experiment & { runs: RunRecord[] }

export interface NewExperiment {
  name: string
  configAId: string
  configBId: string
  taskIds: string[]
  repeats: number
}

/** fetch wrapper: JSON in and out; a non-2xx reply throws with the server's message. */
async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = (data as { message?: string | string[] }).message
    throw new Error(Array.isArray(message) ? message.join('; ') : (message ?? `HTTP ${res.status}`))
  }
  return data as T
}

export const api = {
  tasks: () => request<TaskDef[]>('GET', '/tasks'),
  task: (id: string) => request<TaskDef>('GET', `/tasks/${encodeURIComponent(id)}`),
  configs: () => request<AgentConfig[]>('GET', '/configs'),
  experiments: () => request<Experiment[]>('GET', '/experiments'),
  experiment: (id: string) => request<ExperimentDetail>('GET', `/experiments/${id}`),
  summary: (id: string) => request<ExperimentSummary>('GET', `/experiments/${id}/summary`),
  run: (id: string) => request<RunRecord>('GET', `/runs/${id}`),
  createExperiment: (body: NewExperiment) => request<ExperimentDetail>('POST', '/experiments', body),
  retryErrors: (id: string) => request<{ requeued: number }>('POST', `/experiments/${id}/retry-errors`),
}
