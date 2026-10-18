<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <header class="topbar">
    <RouterLink to="/" class="brand">Agent Evals</RouterLink>
  </header>
  <main class="page">
    <!-- Keyed by path (not query), so switching experiments reloads but filtering runs does not. -->
    <RouterView :key="$route.path" />
  </main>
</template>
