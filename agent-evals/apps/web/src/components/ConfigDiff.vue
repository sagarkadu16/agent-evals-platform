<script setup lang="ts">
import { computed } from 'vue'
import { diffConfigs, type AgentConfig } from '@evals/shared'

/** "What changed" between A and B. One change is a clean test; more means the result can't be pinned on one. */
const props = defineProps<{ a: AgentConfig; b: AgentConfig }>()
const differences = computed(() => diffConfigs(props.a, props.b))
const kind = computed(() => (differences.value.length === 1 ? 'clean' : differences.value.length ? 'mixed' : 'none'))
</script>

<template>
  <div class="config-diff" :class="kind">
    <strong>What changed (A → B)</strong>
    <ul v-if="differences.length">
      <li v-for="d in differences" :key="d.field">
        {{ d.label }}: <span class="from">{{ d.a }}</span> → <span class="to">{{ d.b }}</span>
      </li>
    </ul>
    <span class="small">
      <template v-if="kind === 'clean'">Only one thing changed, so any difference in results comes from it.</template>
      <template v-else-if="kind === 'mixed'">
        {{ differences.length }} things changed, so a difference in results can't be pinned on one of them.
      </template>
      <template v-else>Nothing that affects the agent changed; only the names differ.</template>
    </span>
  </div>
</template>

<style scoped>
.config-diff { margin-top: 1rem; padding: 0.7rem 0.9rem; border-radius: 8px; border-left: 4px solid; display: flex; flex-direction: column; gap: 0.25rem; }
ul { margin: 0; padding-left: 1.1rem; font-size: 0.9rem; }
.from { color: var(--muted); }
.to { font-weight: 600; }
.clean { background: var(--good-bg); border-color: var(--good); }
.mixed, .none { background: var(--warn-bg); border-color: #d9a400; }
</style>
