<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { AgentConfig, RunRecord, TaskDef } from '@evals/shared'
import { api } from '../api'
import { usePolling } from '../composables/usePolling'
import StepCard from '../components/StepCard.vue'
import { dateTime, seconds, usd } from '../format'

const route = useRoute()
const id = String(route.params.id)

const run = ref<RunRecord>()
const task = ref<TaskDef>()
const config = ref<AgentConfig>()
const loadError = ref('')

// Poll while the run is still queued or running; task and config are fetched once.
usePolling(async () => {
  try {
    run.value = await api.run(id)
    if (!task.value || !config.value) {
      const [t, configs] = await Promise.all([api.task(run.value.taskId), api.configs()])
      task.value = t
      config.value = configs.find((c) => c.id === run.value!.configId)
    }
    loadError.value = ''
  } catch (err) {
    loadError.value = (err as Error).message
  }
  return run.value?.status === 'queued' || run.value?.status === 'running'
})

const result = computed(() => {
  const r = run.value
  if (!r) return { label: '', cls: '' }
  if (r.status === 'error') return { label: 'ERROR', cls: 'error' }
  if (r.status !== 'done') return { label: r.status, cls: r.status }
  if (r.passed === null) return { label: 'UNSCORED', cls: '' }
  return r.passed ? { label: 'PASSED', cls: 'pass' } : { label: 'FAILED', cls: 'fail' }
})

// Steps are timed from when the run started; if that is missing, from the first step.
const startedAt = computed(() => run.value?.startedAt ?? run.value?.steps?.[0]?.timestampMs ?? null)
const totalCost = computed(() =>
  run.value ? (run.value.costUsd ?? 0) + (run.value.judgeCostUsd ?? 0) : null,
)
</script>

<template>
  <p class="small">
    <RouterLink v-if="run" :to="`/experiments/${run.experimentId}`">← Back to experiment</RouterLink>
    <RouterLink v-else to="/">← All experiments</RouterLink>
  </p>
  <div v-if="loadError" class="error">Could not load: {{ loadError }}</div>

  <template v-if="run">
    <!-- A runner error goes first: nothing below it was scored. -->
    <div v-if="run.status === 'error'" class="error run-error">
      <strong>This run failed and was not scored.</strong>
      <pre>{{ run.error }}</pre>
    </div>

    <h1>{{ task?.name ?? run.taskId }}</h1>
    <p class="row">
      <span class="badge" :class="result.cls">{{ result.label }}</span>
      <span class="muted">
        {{ config?.name ?? run.configId }}
        <template v-if="config"> · <code>{{ config.model }}</code></template>
        · repeat {{ run.repeatIndex + 1 }}
      </span>
    </p>
    <div v-if="run.status === 'queued' || run.status === 'running'" class="notice">
      This run is {{ run.status }}. The page updates every 3 seconds.
    </div>

    <div class="facts">
      <div class="card"><div class="label">Duration</div><div class="value">{{ seconds(run.durationMs) }}</div></div>
      <div class="card">
        <div class="label">Tokens (in / out)</div>
        <div class="value">{{ run.inputTokens?.toLocaleString() ?? '—' }} / {{ run.outputTokens?.toLocaleString() ?? '—' }}</div>
      </div>
      <div class="card">
        <div class="label">Cost</div>
        <div class="value">{{ usd(totalCost) }}</div>
        <div class="muted small">agent {{ usd(run.costUsd) }} + judge {{ usd(run.judgeCostUsd) }}</div>
      </div>
      <div class="card">
        <div class="label">Started</div>
        <div class="value small">{{ run.startedAt ? dateTime(run.startedAt) : '—' }}</div>
      </div>
    </div>

    <h2>Scorer's reason</h2>
    <div class="card">
      <p class="pre">{{ run.scoreReason ?? (run.status === 'error' ? 'Not scored: the run errored.' : 'Not scored yet.') }}</p>
      <p v-if="task" class="muted small">Scored by {{ task.scorerType === 'regex' ? 'regex' : 'LLM judge' }}.</p>
    </div>

    <h2>Final answer</h2>
    <div class="card"><pre>{{ run.finalAnswer || '(empty)' }}</pre></div>

    <h2>Task prompt</h2>
    <div class="card">
      <pre>{{ task?.prompt ?? '…' }}</pre>
      <details v-if="task?.referenceAnswer" class="small">
        <summary>Reference answer</summary>
        <pre>{{ task.referenceAnswer }}</pre>
      </details>
    </div>

    <h2>Steps ({{ run.steps?.length ?? 0 }})</h2>
    <p v-if="!run.steps?.length" class="muted">No steps were recorded for this run.</p>
    <div class="timeline">
      <StepCard v-for="s in run.steps" :key="s.index" :step="s" :run-started-at="startedAt" />
    </div>
  </template>
  <p v-else-if="!loadError" class="muted">Loading…</p>
</template>

<style scoped>
.run-error pre { margin: 0.5rem 0 0; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
.facts .card { padding: 0.75rem 1rem; }
.label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
.value { font-size: 1.15rem; font-weight: 600; }
pre, .pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 0.9rem; font-family: ui-monospace, Menlo, monospace; }
details { margin-top: 0.75rem; }
.timeline { display: flex; flex-direction: column; gap: 0.6rem; }
</style>
