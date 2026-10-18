<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Step } from '@evals/shared'

/** One timeline step. Long content is collapsed until "show more" is clicked. */
const props = defineProps<{ step: Step; runStartedAt: number | null }>()

const COLLAPSED_CHARS = 400
const COLLAPSED_LINES = 8

const expanded = ref(false)
const lines = computed(() => props.step.content.split('\n'))
const isLong = computed(
  () => props.step.content.length > COLLAPSED_CHARS || lines.value.length > COLLAPSED_LINES,
)
const shown = computed(() => {
  if (expanded.value || !isLong.value) return props.step.content
  return lines.value.slice(0, COLLAPSED_LINES).join('\n').slice(0, COLLAPSED_CHARS) + '…'
})

const elapsed = computed(() => {
  const { timestampMs } = props.step
  if (timestampMs === undefined || props.runStartedAt === null) return ''
  return `+${(Math.max(0, timestampMs - props.runStartedAt) / 1000).toFixed(1)} s`
})

const kindLabel = { tool: 'Tool call', result: 'Tool result', model: 'Model' } as const
</script>

<template>
  <div class="step" :class="step.kind">
    <div class="head">
      <span class="kind">{{ kindLabel[step.kind] }}</span>
      <code v-if="step.toolName" class="tool">{{ step.toolName }}</code>
      <span class="spacer" />
      <span class="muted small">#{{ step.index + 1 }}</span>
      <span v-if="elapsed" class="muted small">{{ elapsed }}</span>
    </div>
    <pre>{{ shown || '(empty)' }}</pre>
    <button v-if="isLong" class="link small" @click="expanded = !expanded">
      {{ expanded ? 'show less' : `show more (${step.content.length.toLocaleString()} chars)` }}
    </button>
  </div>
</template>

<style scoped>
.step { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--neutral); border-radius: 8px; padding: 0.75rem 1rem; }
.step.tool { border-left-color: var(--accent); }
.step.result { border-left-color: var(--neutral); }
.step.model { border-left-color: var(--good); }
.head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.4rem; }
.kind { font-weight: 700; font-size: 0.85rem; }
.tool { font-size: 0.8rem; background: var(--neutral-bg); padding: 0.05rem 0.4rem; border-radius: 4px; }
.spacer { flex: 1; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
</style>
