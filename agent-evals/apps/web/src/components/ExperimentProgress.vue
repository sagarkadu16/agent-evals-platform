<script setup lang="ts">
import { computed } from 'vue'
import type { Experiment } from '@evals/shared'

/**
 * Progress of one experiment for the list: a bar split into finished / errored / running runs,
 * plus a status line. `waitingFor` is how many earlier experiments are still unfinished: the queue
 * runs experiments in the order they were created, so a queued one waits for those first.
 */
const props = defineProps<{ experiment: Experiment; waitingFor: number }>()

const counts = computed(() => props.experiment.counts)
const total = computed(() => counts.value.queued + counts.value.running + counts.value.done + counts.value.error)
const finished = computed(() => counts.value.done + counts.value.error)
const pct = (n: number) => `${total.value ? (n / total.value) * 100 : 0}%`

const statusLine = computed(() => {
  const { status } = props.experiment
  if (status === 'done') return counts.value.error ? 'Finished with errors' : 'Finished'
  if (status === 'running') return `Running · ${counts.value.running} in progress`
  return props.waitingFor > 0
    ? `Waiting for ${props.waitingFor} earlier experiment${props.waitingFor === 1 ? '' : 's'}`
    : 'Starting…'
})
</script>

<template>
  <div class="exp-progress">
    <div class="line">
      <span class="badge" :class="experiment.status">{{ experiment.status }}</span>
      <span class="count">{{ finished }} / {{ total }} runs</span>
      <span v-if="counts.error" class="badge error">{{ counts.error }} error{{ counts.error === 1 ? '' : 's' }}</span>
    </div>
    <div
      class="bar"
      role="progressbar"
      :aria-valuenow="finished"
      aria-valuemin="0"
      :aria-valuemax="total"
      :title="`${counts.done} done · ${counts.error} errored · ${counts.running} running · ${counts.queued} queued`"
    >
      <div class="seg seg-done" :style="{ width: pct(counts.done) }" />
      <div class="seg seg-error" :style="{ width: pct(counts.error) }" />
      <div class="seg seg-running" :style="{ width: pct(counts.running) }" />
    </div>
    <div class="muted small">{{ statusLine }}</div>
  </div>
</template>

<style scoped>
.exp-progress { display: flex; flex-direction: column; gap: 0.3rem; min-width: 180px; }
.line { display: flex; align-items: center; gap: 0.5rem; }
.count { font-variant-numeric: tabular-nums; font-size: 0.9rem; }
.bar { display: flex; height: 6px; background: var(--neutral-bg); border-radius: 3px; overflow: hidden; }
.seg { height: 100%; transition: width 0.4s; }
.seg-done { background: var(--accent); }
.seg-error { background: var(--bad); }
.seg-running {
  background: repeating-linear-gradient(45deg, var(--accent) 0 4px, transparent 4px 8px);
  opacity: 0.6;
}
</style>
