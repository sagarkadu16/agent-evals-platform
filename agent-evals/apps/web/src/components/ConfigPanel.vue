<script setup lang="ts">
import { computed } from 'vue'
import { CONFIG_FIELDS, type AgentConfig, type ConfigField } from '@evals/shared'

/**
 * Picks one side of the comparison and shows what that config actually is.
 * Rows listed in `differs` are highlighted, so the A-vs-B difference is visible at a glance.
 */
const props = defineProps<{ side: 'A' | 'B'; role: string; configs: AgentConfig[]; differs: ConfigField[] }>()
const selectedId = defineModel<string>({ required: true })

const config = computed(() => props.configs.find((c) => c.id === selectedId.value))

function listValue(c: AgentConfig, field: ConfigField): string[] | null {
  const value = c[field]
  return Array.isArray(value) ? value : field === 'memoryFiles' ? [] : null
}
/** "memory/sales-policy.md" -> "sales-policy.md": the folder is the same for every memory file. */
const shortName = (item: string) => item.replace(/^memory\//, '')
</script>

<template>
  <section class="panel" :class="`side-${side}`">
    <header>
      <span class="side">{{ side }}</span>
      <span class="role">{{ role }}</span>
    </header>
    <select v-model="selectedId" :aria-label="`Config ${side}`">
      <option v-for="c in configs" :key="c.id" :value="c.id">{{ c.name }}</option>
    </select>

    <dl v-if="config" class="spec">
      <div v-for="f in CONFIG_FIELDS" :key="f.key" class="spec-row" :class="{ differs: differs.includes(f.key) }">
        <dt>{{ f.label }}</dt>
        <dd>
          <template v-if="listValue(config, f.key)">
            <span v-if="!listValue(config, f.key)!.length" class="muted">none</span>
            <span v-for="item in listValue(config, f.key)" :key="item" class="chip" :title="item">
              {{ shortName(item) }}
            </span>
          </template>
          <code v-else-if="f.key === 'model'">{{ config.model }}</code>
          <template v-else-if="f.key === 'runBudgetSec'">{{ config.runBudgetSec }} s</template>
          <template v-else>{{ config[f.key] }}</template>
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
header { display: flex; align-items: center; gap: 0.5rem; }
.side {
  display: inline-grid; place-items: center; width: 1.6rem; height: 1.6rem; border-radius: 6px;
  font-weight: 800; font-size: 0.85rem; background: var(--neutral-bg); color: var(--text);
}
.side-B .side { background: var(--accent); color: #fff; }
.role { font-size: 0.85rem; color: var(--muted); }
select { width: 100%; }
.spec { margin: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.spec-row { display: grid; grid-template-columns: 6.5rem 1fr; gap: 0.5rem; padding: 0.35rem 0.7rem; font-size: 0.85rem; }
.spec-row + .spec-row { border-top: 1px solid var(--border); }
.spec-row.differs { background: var(--warn-bg); }
.spec-row.differs dt { color: var(--text); font-weight: 600; }
dt { color: var(--muted); }
dd { margin: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; min-width: 0; }
code { font-size: 0.8rem; word-break: break-all; }
</style>
