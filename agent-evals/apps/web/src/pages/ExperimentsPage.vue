<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { AgentConfig, Experiment, TaskDef } from '@evals/shared'
import { api } from '../api'
import { usePolling } from '../composables/usePolling'
import { dateTime } from '../format'

const router = useRouter()

const experiments = ref<Experiment[]>([])
const configs = ref<AgentConfig[]>([])
const tasks = ref<TaskDef[]>([])
const loadError = ref('')

// Poll the list while any experiment is still queued or running.
usePolling(async () => {
  try {
    experiments.value = await api.experiments()
    loadError.value = ''
  } catch (err) {
    loadError.value = (err as Error).message
  }
  return experiments.value.some((e) => e.status !== 'done')
})

const configName = (id: string) => configs.value.find((c) => c.id === id)?.name ?? id
const total = (e: Experiment) => e.counts.queued + e.counts.running + e.counts.done + e.counts.error
const finished = (e: Experiment) => e.counts.done + e.counts.error

// --- New experiment form ---
const name = ref('')
const configAId = ref('')
const configBId = ref('')
const repeats = ref(5)
const selectedTaskIds = ref<string[]>([])
const submitting = ref(false)
const submitError = ref('')

onMounted(async () => {
  try {
    ;[configs.value, tasks.value] = await Promise.all([api.configs(), api.tasks()])
    configAId.value = configs.value[0]?.id ?? ''
    configBId.value = configs.value[1]?.id ?? ''
    selectedTaskIds.value = tasks.value.map((t) => t.id)
  } catch (err) {
    loadError.value = (err as Error).message
  }
})

const runCount = computed(() => selectedTaskIds.value.length * 2 * (repeats.value || 0))
const formProblem = computed(() => {
  if (!name.value.trim()) return 'Give the experiment a name.'
  if (!configAId.value || !configBId.value) return 'Pick both configs.'
  if (configAId.value === configBId.value) return 'Config A and B must be different.'
  if (selectedTaskIds.value.length === 0) return 'Pick at least one task.'
  if (!Number.isInteger(repeats.value) || repeats.value < 1 || repeats.value > 50) return 'Repeats must be 1 to 50.'
  return ''
})

const selectAll = (on: boolean) => {
  selectedTaskIds.value = on ? tasks.value.map((t) => t.id) : []
}

async function submit() {
  if (formProblem.value) return
  submitting.value = true
  submitError.value = ''
  try {
    const created = await api.createExperiment({
      name: name.value.trim(),
      configAId: configAId.value,
      configBId: configBId.value,
      taskIds: selectedTaskIds.value,
      repeats: repeats.value,
    })
    await router.push(`/experiments/${created.id}`)
  } catch (err) {
    submitError.value = (err as Error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <h1>Experiments</h1>
  <p class="muted">Run the same tasks under two agent configs and see which one is better.</p>

  <div v-if="loadError" class="error">Could not load data: {{ loadError }}</div>

  <h2>Start a new experiment</h2>
  <div class="card">
    <form class="grid" @submit.prevent="submit">
      <label>
        Name
        <input v-model="name" placeholder="e.g. deepseek-vs-sonnet" />
      </label>
      <label>
        Config A (baseline)
        <select v-model="configAId">
          <option v-for="c in configs" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label>
        Config B (challenger)
        <select v-model="configBId">
          <option v-for="c in configs" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label>
        Repeats per task
        <input v-model.number="repeats" type="number" min="1" max="50" />
      </label>
    </form>

    <fieldset>
      <legend>
        Tasks ({{ selectedTaskIds.length }}/{{ tasks.length }})
        <button type="button" class="link small" @click="selectAll(true)">all</button> ·
        <button type="button" class="link small" @click="selectAll(false)">none</button>
      </legend>
      <div class="checks">
        <label v-for="t in tasks" :key="t.id" :title="t.prompt">
          <input v-model="selectedTaskIds" type="checkbox" :value="t.id" />
          {{ t.name }} <span class="muted small">({{ t.scorerType }})</span>
        </label>
      </div>
    </fieldset>

    <div class="row" style="margin-top: 1rem">
      <button :disabled="!!formProblem || submitting" @click="submit">
        {{ submitting ? 'Starting…' : `Start ${runCount} runs` }}
      </button>
      <span v-if="formProblem" class="muted small">{{ formProblem }}</span>
      <span v-else class="muted small">With the Hermes runner, every run calls a paid model.</span>
    </div>
    <div v-if="submitError" class="error">{{ submitError }}</div>
  </div>

  <h2>All experiments</h2>
  <p v-if="experiments.length === 0" class="muted">No experiments yet.</p>
  <div v-else class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Config A</th>
          <th>Config B</th>
          <th>Status</th>
          <th class="num">Runs done / total</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in experiments" :key="e.id">
          <td><RouterLink :to="`/experiments/${e.id}`">{{ e.name }}</RouterLink></td>
          <td>{{ configName(e.configAId) }}</td>
          <td>{{ configName(e.configBId) }}</td>
          <td><span class="badge" :class="e.status">{{ e.status }}</span></td>
          <td class="num">
            {{ finished(e) }} / {{ total(e) }}
            <span v-if="e.counts.error" class="badge error">{{ e.counts.error }} errors</span>
          </td>
          <td class="muted small">{{ dateTime(e.createdAt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
