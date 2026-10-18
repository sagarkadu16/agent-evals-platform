<script setup lang="ts">
import { computed } from 'vue'
import type { Verdict } from '@evals/shared'
import { points } from '../format'

/** Horizontal 95% CI for passRate(B) - passRate(A), with a line at 0 to show whether it is crossed. */
const props = defineProps<{ difference: number; low: number; high: number; verdict: Verdict }>()

// Symmetric scale around 0, at least ±20 points, rounded up to the next 10 points.
const half = computed(() => {
  const widest = Math.max(0.2, Math.abs(props.low), Math.abs(props.high), Math.abs(props.difference))
  return Math.min(1, Math.ceil(widest * 10) / 10)
})
const x = (v: number) => `${((v + half.value) / (2 * half.value)) * 100}%`
</script>

<template>
  <div class="ci">
    <div class="track">
      <div class="zero" :style="{ left: x(0) }"><span>0</span></div>
      <div class="interval" :class="verdict" :style="{ left: x(low), width: `calc(${x(high)} - ${x(low)})` }" />
      <div class="point" :class="verdict" :style="{ left: x(difference) }" :title="`${points(difference)} points`" />
    </div>
    <div class="scale">
      <span>{{ points(-half) }}</span>
      <span>A better ← · → B better</span>
      <span>{{ points(half) }}</span>
    </div>
    <p class="small">
      Difference <strong>{{ points(difference) }} points</strong> (B − A), 95% CI
      <strong>{{ points(low) }}</strong> to <strong>{{ points(high) }}</strong> points.
    </p>
  </div>
</template>

<style scoped>
.ci { margin: 1rem 0 0; }
.track { position: relative; height: 34px; background: var(--neutral-bg); border-radius: 6px; }
.zero { position: absolute; top: -6px; bottom: -6px; width: 2px; margin-left: -1px; background: var(--text); }
.zero span { position: absolute; top: -1.3rem; left: 50%; transform: translateX(-50%); font-size: 0.75rem; color: var(--muted); }
.interval { position: absolute; top: 9px; height: 16px; border-radius: 8px; min-width: 2px; opacity: 0.85; background: var(--neutral); }
.point { position: absolute; top: 5px; width: 4px; height: 24px; margin-left: -2px; border-radius: 2px; background: var(--text); }
.interval.better { background: var(--good); }
.interval.worse { background: var(--bad); }
.scale { display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--muted); margin-top: 0.3rem; }
</style>
