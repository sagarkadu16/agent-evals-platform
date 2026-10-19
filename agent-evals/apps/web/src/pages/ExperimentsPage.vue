<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { diffConfigs, type AgentConfig, type Experiment, type TaskDef } from '@evals/shared'
import { api } from '../api'
import { usePolling } from '../composables/usePolling'
import { useLocalDraft } from '../composables/useLocalDraft'
import ConfigPanel from '../components/ConfigPanel.vue'
import ExperimentProgress from '../components/ExperimentProgress.vue'
import TaskPicker from '../components/TaskPicker.vue'
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Runs are claimed in creation order across experiments, so an unfinished experiment waits
// for every unfinished one created before it.
const waitingFor = (e: Experiment) =>
  experiments.value.filter((other) => other.status !== 'done' && other.createdAt < e.createdAt).length

// --- New experiment form ---
const name = ref('')
const configAId = ref('')
const configBId = ref('')
const repeats = ref(5)
const selectedTaskIds = ref<string[]>([])
const submitting = ref(false)
const submitError = ref('')

// The form is kept as a draft in localStorage, so leaving the page (to look at an experiment
// or a run) and coming back, or reloading, keeps what was picked.
interface FormDraft {
  name: string
  configAId: string
  configBId: string
  repeats: number
  taskIds: string[]
}
const draft = useLocalDraft<FormDraft>('evals.new-experiment-draft')

onMounted(async () => {
  try {
    ;[configs.value, tasks.value] = await Promise.all([api.configs(), api.tasks()])
    restoreDraft()
    // Save only after restoring, so the empty defaults never overwrite a saved draft.
    watch([name, configAId, configBId, repeats, selectedTaskIds], saveDraft, { deep: true })
  } catch (err) {
    loadError.value = (err as Error).message
  }
})

/**
 * Default pair: a plain config (no skills, no memory) as A, and a config that differs from it in
 * exactly one field as B, so a first experiment is a clean comparison.
 */
function defaultPair(): [string, string] {
  const all = configs.value
  const a = all.find((c) => !c.skills.length && !c.memoryFiles?.length) ?? all[0]
  const b = all.find((c) => c !== a && diffConfigs(a, c).length === 1) ?? all.find((c) => c !== a)
  return [a?.id ?? '', b?.id ?? '']
}

/** Restores the saved draft, dropping configs and tasks that no longer exist. Defaults: a clean pair, all tasks. */
function restoreDraft() {
  const saved = draft.load()
  const configIds = new Set(configs.value.map((c) => c.id))
  const taskIds = new Set(tasks.value.map((t) => t.id))
  const knownConfig = (id: unknown, fallback: string) =>
    typeof id === 'string' && configIds.has(id) ? id : fallback

  name.value = typeof saved.name === 'string' ? saved.name : ''
  const [defaultA, defaultB] = defaultPair()
  configAId.value = knownConfig(saved.configAId, defaultA)
  configBId.value = knownConfig(saved.configBId, defaultB)
  repeats.value = Number.isInteger(saved.repeats) ? saved.repeats! : 5
  selectedTaskIds.value = Array.isArray(saved.taskIds)
    ? saved.taskIds.filter((id) => taskIds.has(id))
    : tasks.value.map((t) => t.id)
}

function saveDraft() {
  draft.save({
    name: name.value,
    configAId: configAId.value,
    configBId: configBId.value,
    repeats: repeats.value,
    taskIds: selectedTaskIds.value,
  })
}

const runCount = computed(() => selectedTaskIds.value.length * 2 * (repeats.value || 0))

// --- What differs between A and B: ideally exactly one thing, so a result can be attributed to it ---
const configA = computed(() => configs.value.find((c) => c.id === configAId.value))
const configB = computed(() => configs.value.find((c) => c.id === configBId.value))
const differences = computed(() => (configA.value && configB.value ? diffConfigs(configA.value, configB.value) : []))
const differingFields = computed(() => differences.value.map((d) => d.field))
const comparison = computed((): { kind: 'same' | 'none' | 'clean' | 'mixed'; title: string; text: string } => {
  const n = differences.value.length
  if (configAId.value === configBId.value) {
    return { kind: 'same', title: 'A and B are the same config', text: 'Pick a different config for one side.' }
  }
  if (n === 0) {
    return { kind: 'none', title: 'These configs behave the same', text: 'Only their names differ, so expect no real difference.' }
  }
  if (n === 1) {
    return {
      kind: 'clean',
      title: `Clean comparison: only ${differences.value[0].label.toLowerCase()} differs`,
      text: 'Any difference in results comes from this one change.',
    }
  }
  return {
    kind: 'mixed',
    title: `${n} things differ`,
    text: "A difference in results can't be pinned on one of them. For a clean test, change one thing at a time.",
  }
})

function swapConfigs() {
  ;[configAId.value, configBId.value] = [configBId.value, configAId.value]
}
const formProblem = computed(() => {
  if (!name.value.trim()) return 'Give the experiment a name.'
  if (!configAId.value || !configBId.value) return 'Pick both configs.'
  if (configAId.value === configBId.value) return 'Config A and B must be different.'
  if (selectedTaskIds.value.length === 0) return 'Pick at least one task.'
  if (!Number.isInteger(repeats.value) || repeats.value < 1 || repeats.value > 50) return 'Repeats must be 1 to 50.'
  return ''
})

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
    // Keep the configs, tasks and repeats for the next experiment; only the name is per experiment.
    name.value = ''
    saveDraft()
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
    <form class="new-experiment" @submit.prevent="submit">
      <div class="basics">
        <label>
          Name
          <input v-model="name" placeholder="e.g. deepseek-skill-vs-none" />
        </label>
        <label>
          Repeats per task
          <input v-model.number="repeats" type="number" min="1" max="50" />
        </label>
      </div>

      <h3>Configs</h3>
      <div class="configs">
        <ConfigPanel v-model="configAId" side="A" role="Baseline" :configs="configs" :differs="differingFields" />
        <button type="button" class="swap secondary" title="Swap A and B" aria-label="Swap A and B" @click="swapConfigs">
          ⇄
        </button>
        <ConfigPanel v-model="configBId" side="B" role="Challenger" :configs="configs" :differs="differingFields" />
      </div>
      <div v-if="configA && configB" class="comparison" :class="comparison.kind" role="status">
        <strong>{{ comparison.title }}</strong>
        <ul v-if="differences.length">
          <li v-for="d in differences" :key="d.field">
            {{ d.label }}: <span class="from">{{ d.a }}</span> → <span class="to">{{ d.b }}</span>
          </li>
        </ul>
        <span class="muted small">{{ comparison.text }}</span>
      </div>

      <h3>Tasks</h3>
      <TaskPicker v-model="selectedTaskIds" :tasks="tasks" />
    </form>

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
          <th>Experiment</th>
          <th>Configs</th>
          <th>Progress</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in experiments" :key="e.id">
          <td class="wrap name-cell">
            <RouterLink :to="`/experiments/${e.id}`">{{ e.name }}</RouterLink>
            <div class="muted small">{{ plural(e.taskIds.length, 'task') }} × {{ plural(e.repeats, 'repeat') }}</div>
          </td>
          <td class="wrap configs-cell">
            <div><span class="side">A</span>{{ configName(e.configAId) }}</div>
            <div><span class="side">B</span>{{ configName(e.configBId) }}</div>
          </td>
          <td><ExperimentProgress :experiment="e" :waiting-for="waitingFor(e)" /></td>
          <td class="muted small">{{ dateTime(e.createdAt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.new-experiment h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 1.5rem 0 0.6rem; }
.basics { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 1rem; }
.configs { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 0.75rem; align-items: start; }
.swap { align-self: center; margin-top: 2rem; padding: 0.3rem 0.6rem; font-size: 1.1rem; line-height: 1; }
.comparison { margin-top: 0.75rem; padding: 0.7rem 0.9rem; border-radius: 8px; border-left: 4px solid; display: flex; flex-direction: column; gap: 0.25rem; }
.comparison ul { margin: 0; padding-left: 1.1rem; font-size: 0.9rem; }
.comparison .from { color: var(--muted); }
.comparison .to { font-weight: 600; }
.comparison.clean { background: var(--good-bg); border-color: var(--good); }
.comparison.mixed, .comparison.none { background: var(--warn-bg); border-color: #d9a400; }
.comparison.same { background: var(--bad-bg); border-color: var(--bad); }
@media (max-width: 720px) {
  .basics, .configs { grid-template-columns: 1fr; }
  .swap { margin: 0; justify-self: center; transform: rotate(90deg); }
}
.name-cell { min-width: 160px; }
.configs-cell { font-size: 0.9rem; min-width: 220px; }
.configs-cell > div { display: flex; gap: 0.4rem; align-items: baseline; }
.side { font-weight: 700; color: var(--muted); font-size: 0.8rem; flex: none; }
td { vertical-align: top; }
</style>
