<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { ConfigStats, ExperimentSummary, RunRecord } from '@evals/shared'
import { api, type ExperimentDetail } from '../api'
import { usePolling } from '../composables/usePolling'
import CiBar from '../components/CiBar.vue'
import { percent, seconds, usd } from '../format'

const route = useRoute()
const id = String(route.params.id)

const experiment = ref<ExperimentDetail>()
const summary = ref<ExperimentSummary>()
const loadError = ref('')

// Poll every 3 s until the experiment is done.
const polling = usePolling(async () => {
  try {
    ;[experiment.value, summary.value] = await Promise.all([api.experiment(id), api.summary(id)])
    loadError.value = ''
  } catch (err) {
    loadError.value = (err as Error).message
  }
  return experiment.value?.status !== 'done'
})

const total = computed(() => experiment.value?.runs.length ?? 0)
const finished = computed(() => (experiment.value ? experiment.value.counts.done + experiment.value.counts.error : 0))

const verdictLabel = computed(() => {
  const v = summary.value?.comparison.verdict
  return v === 'better' ? 'B better' : v === 'worse' ? 'B worse' : 'Inconclusive'
})

const configRows = computed((): { side: 'A' | 'B'; stats: ConfigStats }[] =>
  summary.value
    ? [
        { side: 'A', stats: summary.value.configA },
        { side: 'B', stats: summary.value.configB },
      ]
    : [],
)

// --- Retry errored runs ---
const retrying = ref(false)
const retryMessage = ref('')
async function retry() {
  retrying.value = true
  retryMessage.value = ''
  try {
    const { requeued } = await api.retryErrors(id)
    retryMessage.value = requeued ? `Re-queued ${requeued} run(s).` : 'No errored runs to retry.'
    if (requeued) polling.start()
  } catch (err) {
    retryMessage.value = (err as Error).message
  } finally {
    retrying.value = false
  }
}

// --- Runs list, filtered by ?task=…&config=… (set by the per-task table links) ---
const taskFilter = computed(() => (route.query.task ? String(route.query.task) : ''))
const configFilter = computed(() => (route.query.config ? String(route.query.config) : ''))
const filteredRuns = computed(() =>
  (experiment.value?.runs ?? []).filter(
    (r) => (!taskFilter.value || r.taskId === taskFilter.value) && (!configFilter.value || r.configId === configFilter.value),
  ),
)
const side = (configId: string) => (configId === experiment.value?.configAId ? 'A' : 'B')
const taskName = (taskId: string) => summary.value?.tasks.find((t) => t.taskId === taskId)?.taskName ?? taskId

function result(r: RunRecord): { label: string; cls: string } {
  if (r.status === 'error') return { label: 'ERROR', cls: 'error' }
  if (r.status !== 'done') return { label: r.status, cls: r.status }
  if (r.passed === null) return { label: 'UNSCORED', cls: '' }
  return r.passed ? { label: 'PASS', cls: 'pass' } : { label: 'FAIL', cls: 'fail' }
}
</script>

<template>
  <p class="small"><RouterLink to="/">← All experiments</RouterLink></p>
  <div v-if="loadError" class="error">Could not load: {{ loadError }}</div>

  <template v-if="experiment && summary">
    <h1>{{ experiment.name }}</h1>
    <p class="muted">
      A: <strong>{{ summary.configA.configName }}</strong> vs B: <strong>{{ summary.configB.configName }}</strong>
      · {{ experiment.taskIds.length }} tasks × {{ experiment.repeats }} repeats
      · <span class="badge" :class="experiment.status">{{ experiment.status }}</span>
    </p>
    <div class="progress" :title="`${finished} / ${total} runs finished`">
      <div :style="{ width: `${total ? (finished / total) * 100 : 0}%` }" />
    </div>
    <p class="small muted">
      {{ finished }} / {{ total }} runs finished
      <template v-if="experiment.counts.running"> · {{ experiment.counts.running }} running</template>
      <template v-if="experiment.counts.error"> · {{ experiment.counts.error }} errored</template>
    </p>
    <div v-if="experiment.status !== 'done'" class="notice">Still running. This page updates every 3 seconds.</div>

    <!-- Verdict -->
    <div class="card verdict-card">
      <div class="verdict" :class="summary.comparison.verdict">{{ verdictLabel }}</div>
      <p>{{ summary.comparison.explanation }}</p>
      <CiBar
        v-if="summary.comparison.ci95 && summary.comparison.difference !== null"
        :difference="summary.comparison.difference"
        :low="summary.comparison.ci95.low"
        :high="summary.comparison.ci95.high"
        :verdict="summary.comparison.verdict"
      />
      <p class="small muted">
        Paired bootstrap over {{ summary.comparison.tasksUsed }} tasks, {{ summary.comparison.iterations }} resamples
        (seed {{ summary.comparison.seed }}). Only scored runs count: errors and judge errors are left out.
      </p>
    </div>

    <!-- Per-config table -->
    <h2>Per config</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Config</th>
            <th class="num">Pass rate</th>
            <th class="num">Passed / scored</th>
            <th class="num">Errors</th>
            <th class="num">Avg duration</th>
            <th class="num">Total cost</th>
            <th class="num">(agent + judge)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in configRows" :key="row.side">
            <td><strong>{{ row.side }}</strong> · {{ row.stats.configName }}</td>
            <td class="num"><strong>{{ percent(row.stats.passRate) }}</strong></td>
            <td class="num">{{ row.stats.passed }} / {{ row.stats.scored }}</td>
            <td class="num">{{ row.stats.errors }}</td>
            <td class="num">{{ seconds(row.stats.avgDurationMs) }}</td>
            <td class="num">{{ usd(row.stats.totalCostUsd) }}</td>
            <td class="num muted small">{{ usd(row.stats.agentCostUsd) }} + {{ usd(row.stats.judgeCostUsd) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="row" style="margin-top: 0.75rem">
      <button class="secondary" :disabled="retrying || experiment.counts.error === 0" @click="retry">
        Retry errored runs ({{ experiment.counts.error }})
      </button>
      <span v-if="retryMessage" class="small muted">{{ retryMessage }}</span>
    </div>

    <!-- Per-task table -->
    <h2>Per task</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th class="num">A pass rate</th>
            <th class="num">B pass rate</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in summary.tasks" :key="t.taskId" :class="{ differs: t.a.passRate !== t.b.passRate }">
            <td>{{ t.taskName }}</td>
            <td class="num">
              <RouterLink :to="{ query: { task: t.taskId, config: experiment.configAId }, hash: '#runs' }">
                {{ percent(t.a.passRate) }} <span class="muted small">({{ t.a.passed }}/{{ t.a.scored }})</span>
              </RouterLink>
            </td>
            <td class="num">
              <RouterLink :to="{ query: { task: t.taskId, config: experiment.configBId }, hash: '#runs' }">
                {{ percent(t.b.passRate) }} <span class="muted small">({{ t.b.passed }}/{{ t.b.scored }})</span>
              </RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="small muted">Highlighted rows are where A and B differ. Click a rate to see those runs.</p>

    <!-- Runs -->
    <h2 id="runs">Runs</h2>
    <p v-if="taskFilter || configFilter" class="small">
      Showing
      <strong v-if="taskFilter">{{ taskName(taskFilter) }}</strong>
      <template v-if="configFilter"> on <strong>{{ side(configFilter) }}</strong></template>
      · <RouterLink :to="{ query: {}, hash: '#runs' }">show all runs</RouterLink>
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Config</th>
            <th class="num">Repeat</th>
            <th>Result</th>
            <th class="num">Duration</th>
            <th class="num">Cost</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filteredRuns" :key="r.id">
            <td>{{ taskName(r.taskId) }}</td>
            <td>{{ side(r.configId) }}</td>
            <td class="num">{{ r.repeatIndex + 1 }}</td>
            <td><span class="badge" :class="result(r).cls">{{ result(r).label }}</span></td>
            <td class="num">{{ seconds(r.durationMs) }}</td>
            <td class="num">{{ usd((r.costUsd ?? 0) + (r.judgeCostUsd ?? 0)) }}</td>
            <td><RouterLink :to="`/runs/${r.id}`">details →</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
  <p v-else-if="!loadError" class="muted">Loading…</p>
</template>

<style scoped>
.verdict-card { margin-top: 1.5rem; }
.verdict { font-size: 2.2rem; font-weight: 800; letter-spacing: -0.01em; color: var(--neutral); }
.verdict.better { color: var(--good); }
.verdict.worse { color: var(--bad); }
tr.differs td { background: var(--warn-bg); }
</style>
