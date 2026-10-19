<script setup lang="ts">
import { computed } from 'vue'
import type { ExperimentSummary, MetricComparison, QualityReason } from '@evals/shared'
import CiBar from './CiBar.vue'
import { factor, percent, seconds, usd } from '../format'

/**
 * The answer to "is B better?", split into quality, speed and cost. Each card says plainly what is
 * known: a pass-rate verdict needs at least 2 tasks, but speed and cost can be compared on one.
 */
const props = defineProps<{ summary: ExperimentSummary }>()

type Tone = 'good' | 'bad' | 'warn' | 'neutral'

const qualityLabels: Record<QualityReason, { text: string; tone: Tone }> = {
  'no-data': { text: 'No data yet', tone: 'neutral' },
  'too-few-tasks': { text: 'Needs ≥ 2 tasks', tone: 'neutral' },
  'no-difference': { text: 'No difference', tone: 'neutral' },
  'ci-includes-zero': { text: 'Unclear', tone: 'warn' },
  'ci-above-zero': { text: 'B better', tone: 'good' },
  'ci-below-zero': { text: 'B worse', tone: 'bad' },
}
const quality = computed(() => qualityLabels[props.summary.comparison.reason])

/** Pill and CI text for a B/A ratio. For both speed and cost, "lower" is good for B. */
function metricView(m: MetricComparison, lowerWord: string, higherWord: string, similarWord: string) {
  if (m.verdict === null || m.ratio === null || !m.ci95) {
    return { text: 'Not enough runs', tone: 'neutral' as Tone, ci: '' }
  }
  if (m.verdict === 'similar') {
    return {
      text: similarWord,
      tone: 'neutral' as Tone,
      ci: `95% CI of B ÷ A: ${factor(m.ci95.low)} to ${factor(m.ci95.high)}. It includes 1×, so no clear difference.`,
    }
  }
  const lower = m.verdict === 'lower'
  // Express the interval in the same direction as the claim: "1.2× to 2.1× faster".
  const [from, to] = lower ? [1 / m.ci95.high, 1 / m.ci95.low] : [m.ci95.low, m.ci95.high]
  const word = lower ? lowerWord : higherWord
  return {
    text: `B ${factor(lower ? 1 / m.ratio : m.ratio)} ${word}`,
    tone: (lower ? 'good' : 'bad') as Tone,
    ci: `95% CI: ${factor(from)} to ${factor(to)} ${word}`,
  }
}
const speed = computed(() => metricView(props.summary.speed, 'faster', 'slower', 'About as fast'))
const cost = computed(() => metricView(props.summary.cost, 'cheaper', 'more expensive', 'About the same cost'))
</script>

<template>
  <section class="summary">
    <p class="headline">{{ summary.headline }}</p>

    <div class="cards">
      <article class="card metric">
        <header>
          <h3>Quality</h3>
          <span class="pill" :class="quality.tone">{{ quality.text }}</span>
        </header>
        <div class="values">
          <span><span class="side">A</span>{{ percent(summary.configA.passRate) }}</span>
          <span class="arrow">→</span>
          <span><span class="side">B</span>{{ percent(summary.configB.passRate) }}</span>
        </div>
        <div class="muted small">
          pass rate · {{ summary.comparison.tasksUsed }} task{{ summary.comparison.tasksUsed === 1 ? '' : 's' }} compared
        </div>
        <CiBar
          v-if="summary.comparison.ci95 && summary.comparison.difference !== null"
          :difference="summary.comparison.difference"
          :low="summary.comparison.ci95.low"
          :high="summary.comparison.ci95.high"
          :verdict="summary.comparison.verdict"
        />
        <p class="explain">{{ summary.comparison.explanation }}</p>
        <p class="method">
          Paired bootstrap over tasks ({{ summary.comparison.iterations }} resamples, seed {{ summary.comparison.seed }}).
          Errors and judge errors are left out.
        </p>
      </article>

      <article class="card metric">
        <header>
          <h3>Speed</h3>
          <span class="pill" :class="speed.tone">{{ speed.text }}</span>
        </header>
        <div class="values">
          <span><span class="side">A</span>{{ seconds(summary.speed.a) }}</span>
          <span class="arrow">→</span>
          <span><span class="side">B</span>{{ seconds(summary.speed.b) }}</span>
        </div>
        <div class="muted small">median time per run</div>
        <p v-if="speed.ci" class="explain">{{ speed.ci }}</p>
        <p class="method">
          Bootstrap over runs within each task ({{ summary.speed.runsA }} A runs, {{ summary.speed.runsB }} B runs).
          The median ignores a single very slow run. Errored runs are left out.
        </p>
      </article>

      <article class="card metric">
        <header>
          <h3>Cost</h3>
          <span class="pill" :class="cost.tone">{{ cost.text }}</span>
        </header>
        <div class="values">
          <span><span class="side">A</span>{{ usd(summary.cost.a) }}</span>
          <span class="arrow">→</span>
          <span><span class="side">B</span>{{ usd(summary.cost.b) }}</span>
        </div>
        <div class="muted small">mean agent cost per run</div>
        <p v-if="cost.ci" class="explain">{{ cost.ci }}</p>
        <p class="explain small">
          Per passed run: A {{ usd(summary.cost.perPassA) }} · B {{ usd(summary.cost.perPassB) }}
        </p>
        <p class="method">
          Bootstrap over runs within each task. Judge cost is the platform's, not the config's, so it is not included.
        </p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.summary { margin-top: 1.25rem; }
.headline { font-size: 1.25rem; font-weight: 700; margin: 0 0 0.9rem; line-height: 1.35; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem; }
.metric { display: flex; flex-direction: column; gap: 0.35rem; padding: 1rem 1.1rem; }
header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
h3 { margin: 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.pill { font-size: 0.8rem; font-weight: 700; padding: 0.15rem 0.6rem; border-radius: 999px; white-space: nowrap; }
.pill.good { background: var(--good-bg); color: var(--good); }
.pill.bad { background: var(--bad-bg); color: var(--bad); }
.pill.warn { background: var(--warn-bg); color: var(--text); }
.pill.neutral { background: var(--neutral-bg); color: var(--muted); }
.values { display: flex; align-items: baseline; gap: 0.5rem; font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.values .side { font-size: 0.75rem; color: var(--muted); margin-right: 0.25rem; font-weight: 700; }
.arrow { color: var(--muted); font-weight: 400; font-size: 1rem; }
.explain { margin: 0.25rem 0 0; font-size: 0.9rem; }
.method { margin: auto 0 0; padding-top: 0.5rem; font-size: 0.75rem; color: var(--muted); }
</style>
