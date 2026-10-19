<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TaskDef } from '@evals/shared'

/**
 * Task selection: search and tag filters narrow the list; "Select all" acts on what is shown,
 * so "all sales tasks" is two clicks. Selected tasks hidden by a filter stay selected.
 */
const props = defineProps<{ tasks: TaskDef[] }>()
const selected = defineModel<string[]>({ required: true })

const query = ref('')
const activeTag = ref('')

/** Tags in use, most common first, for the filter chips. */
const tagCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const t of props.tasks) for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
})

const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.tasks.filter(
    (t) =>
      (!activeTag.value || t.tags?.includes(activeTag.value)) &&
      (!q || [t.name, t.id, ...(t.tags ?? [])].some((s) => s.toLowerCase().includes(q))),
  )
})
const filtered = computed(() => visible.value.length !== props.tasks.length)

const visibleSelected = computed(() => visible.value.filter((t) => selected.value.includes(t.id)).length)
const allVisibleSelected = computed(() => visible.value.length > 0 && visibleSelected.value === visible.value.length)
const someVisibleSelected = computed(() => visibleSelected.value > 0 && !allVisibleSelected.value)
const hiddenSelected = computed(() => selected.value.length - visibleSelected.value)

function toggleVisible(on: boolean) {
  const ids = new Set(visible.value.map((t) => t.id))
  const others = selected.value.filter((id) => !ids.has(id))
  // Keep the task order stable, whatever order the clicks came in.
  selected.value = on ? props.tasks.filter((t) => ids.has(t.id) || others.includes(t.id)).map((t) => t.id) : others
}

function clearFilters() {
  query.value = ''
  activeTag.value = ''
}

const fileCount = (t: TaskDef) => Object.keys(t.files ?? {}).length
const scorerLabel = (t: TaskDef) => (t.scorerType === 'regex' ? 'exact match' : 'LLM judge')
const preview = (t: TaskDef) => (t.prompt.length > 400 ? `${t.prompt.slice(0, 400)}…` : t.prompt)
</script>

<template>
  <section class="task-picker">
    <div class="toolbar">
      <input v-model="query" type="search" placeholder="Search tasks" aria-label="Search tasks" />
      <span class="count">
        <strong>{{ selected.length }}</strong> of {{ tasks.length }} selected
        <span v-if="filtered && hiddenSelected" class="muted">({{ hiddenSelected }} not shown)</span>
      </span>
    </div>

    <div class="filters" role="group" aria-label="Filter by tag">
      <button type="button" class="filter" :class="{ on: !activeTag }" @click="activeTag = ''">All</button>
      <button
        v-for="[tag, n] in tagCounts"
        :key="tag"
        type="button"
        class="filter"
        :class="{ on: activeTag === tag }"
        :aria-pressed="activeTag === tag"
        @click="activeTag = activeTag === tag ? '' : tag"
      >
        {{ tag }} <span class="n">{{ n }}</span>
      </button>
    </div>

    <label class="select-all">
      <input
        type="checkbox"
        :checked="allVisibleSelected"
        :indeterminate="someVisibleSelected"
        :disabled="!visible.length"
        @change="toggleVisible(($event.target as HTMLInputElement).checked)"
      />
      {{ filtered ? `Select all ${visible.length} shown` : 'Select all' }}
    </label>

    <ul v-if="visible.length" class="list">
      <li v-for="t in visible" :key="t.id">
        <label class="task" :class="{ checked: selected.includes(t.id) }" :title="preview(t)">
          <input v-model="selected" type="checkbox" :value="t.id" />
          <span class="body">
            <span class="name">{{ t.name }}</span>
            <span class="meta">
              <span class="chip" :class="t.scorerType">{{ scorerLabel(t) }}</span>
              <span v-if="fileCount(t)" class="chip">{{ fileCount(t) }} file{{ fileCount(t) === 1 ? '' : 's' }}</span>
              <span v-for="tag in t.tags" :key="tag" class="tag">{{ tag }}</span>
            </span>
          </span>
        </label>
      </li>
    </ul>
    <p v-else class="empty muted">
      No tasks match. <button type="button" class="link" @click="clearFilters">Clear filters</button>
    </p>
  </section>
</template>

<style scoped>
.task-picker { display: flex; flex-direction: column; gap: 0.6rem; }
.toolbar { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
.toolbar input { flex: 1 1 220px; max-width: 320px; }
.count { font-size: 0.9rem; }
.filters { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.filter {
  border: 1px solid var(--border); background: transparent; color: var(--text);
  padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.8rem;
}
.filter.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.filter .n { opacity: 0.65; margin-left: 0.15rem; }
.select-all {
  flex-direction: row; align-items: center; gap: 0.5rem; color: var(--text); font-size: 0.9rem; font-weight: 600;
  cursor: pointer; padding: 0.4rem 0 0.5rem; border-bottom: 1px solid var(--border);
}
.list {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 0.4rem;
}
.task {
  flex-direction: row; align-items: flex-start; gap: 0.6rem; color: var(--text); cursor: pointer;
  padding: 0.5rem 0.65rem; border: 1px solid var(--border); border-radius: 8px; height: 100%;
}
.task:hover { border-color: var(--accent); }
.task.checked { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.task input { margin-top: 0.15rem; }
.body { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.name { font-size: 0.9rem; line-height: 1.35; }
.meta { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
.chip.judge { color: var(--accent); }
.tag { font-size: 0.75rem; color: var(--muted); }
.tag::before { content: '#'; opacity: 0.6; }
.empty { margin: 0.5rem 0; }
</style>
