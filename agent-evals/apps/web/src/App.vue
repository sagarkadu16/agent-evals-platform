<script setup lang="ts">
import { ref, onMounted } from 'vue';

const status = ref('checking…');

onMounted(async () => {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    status.value = `${j.status} (runner: ${j.runner})`;
  } catch {
    status.value = 'API unreachable';
  }
});
</script>

<template>
  <h1>Agent Evals</h1>
  <p>API: {{ status }}</p>
</template>
