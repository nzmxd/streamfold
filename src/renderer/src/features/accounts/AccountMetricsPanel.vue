<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  AccountMetricDefinition,
  AccountMetricHistory,
  AccountMetricPeriod
} from '../../../../shared/contracts'
import {
  formatContentMetric,
  formatContentMetricDelta
} from '../content/metrics'
import { formatDate, messageOf } from '../shared/format'
import {
  accountMetricChartPoints,
  accountMetricDefinitions,
  accountMetricDefinitionsForSnapshot,
  accountMetricDelta,
  accountMetricPeriodOptions,
  accountMetricPolyline,
  accountMetricSeries,
  accountMetricStatusLabel,
  accountMetricValue,
  accountMetricZeroLineY,
  formatAccountMetricDate,
  latestAccountMetricSnapshot,
  previousAccountMetricSnapshot
} from './account-metrics'

const props = defineProps<{
  accountId: string
  refreshKey?: string | null
}>()

type SummaryPeriod = Exclude<AccountMetricPeriod, 'daily'>

const selectedPeriod = ref<SummaryPeriod>('last_7_days')
const summary = ref<AccountMetricHistory | null>(null)
const daily = ref<AccountMetricHistory | null>(null)
const summaryLoading = ref(false)
const trendLoading = ref(false)
const summaryError = ref('')
const trendError = ref('')
const selectedTrendMetricId = ref<string | null>(null)
const summaryExpanded = ref(false)
const trendExpanded = ref(false)
let summarySequence = 0
let trendSequence = 0

const definitions = computed(() => {
  const merged = new Map<string, AccountMetricDefinition>()
  for (const definition of daily.value?.metricDefinitions ?? []) merged.set(definition.id, definition)
  for (const definition of summary.value?.metricDefinitions ?? []) merged.set(definition.id, definition)
  return accountMetricDefinitions([...merged.values()])
})
const latestSnapshot = computed(() => latestAccountMetricSnapshot(summary.value?.snapshots ?? []))
const previousSnapshot = computed(() => previousAccountMetricSnapshot(summary.value?.snapshots ?? []))
const summaryDefinitions = computed(() => accountMetricDefinitionsForSnapshot(
  definitions.value,
  latestSnapshot.value
))
const trendDefinitions = computed(() => definitions.value.filter((definition) => (
  accountMetricSeries(daily.value?.snapshots ?? [], definition.id).length > 0
)))
const trendDefinition = computed(() => trendDefinitions.value.find((definition) => (
  definition.id === selectedTrendMetricId.value
)) ?? null)
const trendSeries = computed(() => trendDefinition.value
  ? accountMetricSeries(daily.value?.snapshots ?? [], trendDefinition.value.id)
  : [])
const trendPoints = computed(() => accountMetricChartPoints(trendSeries.value))
const trendPolyline = computed(() => accountMetricPolyline(trendPoints.value))
const zeroLineY = computed(() => accountMetricZeroLineY(trendSeries.value))
const periodDescription = computed(() => {
  const snapshot = latestSnapshot.value
  if (!snapshot) return ''
  if (snapshot.period === 'lifetime') return `累计至 ${formatAccountMetricDate(snapshot.periodEnd)}`
  return snapshot.periodStart
    ? `${formatAccountMetricDate(snapshot.periodStart)} 至 ${formatAccountMetricDate(snapshot.periodEnd)}`
    : `截至 ${formatAccountMetricDate(snapshot.periodEnd)}`
})

watch(
  () => [props.accountId, props.refreshKey, selectedPeriod.value] as const,
  () => void loadSummary(),
  { immediate: true }
)
watch(
  () => [props.accountId, props.refreshKey] as const,
  () => void loadTrend(),
  { immediate: true }
)
watch(trendDefinitions, (next) => {
  if (next.some((definition) => definition.id === selectedTrendMetricId.value)) return
  selectedTrendMetricId.value = next.find((definition) => definition.id === 'views')?.id
    ?? next[0]?.id
    ?? null
}, { immediate: true })
watch(() => props.accountId, () => {
  summaryExpanded.value = false
  trendExpanded.value = false
})

async function loadSummary(): Promise<void> {
  const sequence = ++summarySequence
  const accountId = props.accountId
  summaryLoading.value = true
  summaryError.value = ''
  summary.value = null
  try {
    const result = await window.socialVault.analytics.accountMetrics({
      accountId,
      period: selectedPeriod.value,
      limit: 2
    })
    if (sequence === summarySequence && accountId === props.accountId) summary.value = result
  } catch (cause) {
    if (sequence === summarySequence && accountId === props.accountId) {
      summary.value = null
      summaryError.value = messageOf(cause)
    }
  } finally {
    if (sequence === summarySequence) summaryLoading.value = false
  }
}

async function loadTrend(): Promise<void> {
  const sequence = ++trendSequence
  const accountId = props.accountId
  trendLoading.value = true
  trendError.value = ''
  daily.value = null
  try {
    const result = await window.socialVault.analytics.accountMetrics({
      accountId,
      period: 'daily',
      limit: 30
    })
    if (sequence === trendSequence && accountId === props.accountId) daily.value = result
  } catch (cause) {
    if (sequence === trendSequence && accountId === props.accountId) {
      daily.value = null
      trendError.value = messageOf(cause)
    }
  } finally {
    if (sequence === trendSequence) trendLoading.value = false
  }
}

function metricGroupLabel(group: AccountMetricDefinition['group']): string {
  return { reach: '流量', engagement: '互动', conversion: '转化', other: '其他' }[group]
}

function metricSecondaryText(definition: AccountMetricDefinition): string {
  const current = accountMetricValue(latestSnapshot.value, definition.id)
  if (current === null) {
    return isAdvancedMetric(definition.id) && latestSnapshot.value?.status
      ? accountMetricStatusLabel(latestSnapshot.value.status)
      : '本周期暂无数据'
  }
  return formatContentMetricDelta(
    accountMetricDelta(latestSnapshot.value, previousSnapshot.value, definition.id),
    definition
  )
}

function metricDeltaClass(definition: AccountMetricDefinition): string {
  const value = accountMetricDelta(latestSnapshot.value, previousSnapshot.value, definition.id)
  return value === null || value === 0 ? '' : value > 0 ? 'positive' : 'negative'
}

function isAdvancedMetric(metricId: string): boolean {
  return metricId === 'positive_interaction_rate' || metricId === 'follower_conversion'
}
</script>

<template>
  <section class="account-metrics-panel" aria-label="知乎创作数据">
    <section class="account-metric-section" aria-labelledby="account-metrics-title">
      <header class="account-metrics-head">
        <div>
          <span class="eyebrow">知乎创作数据</span>
          <h3 id="account-metrics-title">创作指标</h3>
          <p>{{ periodDescription || '同步后查看官方周期指标' }}</p>
        </div>
        <button
          class="account-metric-disclosure"
          type="button"
          :aria-expanded="summaryExpanded"
          aria-controls="account-metric-summary-content"
          :aria-label="summaryExpanded ? '折叠知乎创作数据' : '展开知乎创作数据'"
          :title="summaryExpanded ? '折叠知乎创作数据' : '展开知乎创作数据'"
          @click="summaryExpanded = !summaryExpanded"
        ><span aria-hidden="true">{{ summaryExpanded ? '⌃' : '⌄' }}</span></button>
      </header>

      <div v-if="summaryExpanded" id="account-metric-summary-content" class="account-metric-section-content">
        <div class="segmented account-metric-periods" role="group" aria-label="创作指标周期">
          <button
            v-for="option in accountMetricPeriodOptions"
            :key="option.value"
            type="button"
            :class="{ active: selectedPeriod === option.value }"
            :aria-pressed="selectedPeriod === option.value"
            @click="selectedPeriod = option.value"
          >{{ option.label }}</button>
        </div>
        <div v-if="summaryError" class="account-metric-error">
          <span>{{ summaryError }}</span><button type="button" @click="loadSummary">重试</button>
        </div>
        <div v-else-if="summaryLoading && !summary" class="account-metric-loading">正在读取周期指标…</div>
        <div v-else-if="!latestSnapshot" class="account-metric-empty">
          <strong>暂无创作指标</strong>
          <span>完成一次知乎数据同步后，这里会显示官方统计。</span>
        </div>
        <div v-else class="account-metric-grid" :aria-busy="summaryLoading">
          <article
            v-for="definition in summaryDefinitions"
            :key="definition.id"
            :data-metric-group="definition.group"
          >
            <span>{{ definition.label }}<em>{{ metricGroupLabel(definition.group) }}</em></span>
            <strong>{{ formatContentMetric(accountMetricValue(latestSnapshot, definition.id), definition) }}</strong>
            <small :class="metricDeltaClass(definition)">{{ metricSecondaryText(definition) }}</small>
          </article>
        </div>
        <footer v-if="latestSnapshot" class="account-metric-foot">
          <span>{{ periodDescription }}</span>
          <span>最近同步 {{ formatDate(latestSnapshot.capturedAt, true) }}</span>
        </footer>
      </div>
    </section>

    <section class="account-metric-section account-metric-trend" aria-labelledby="account-metric-trend-title">
      <div class="account-metric-trend-head">
        <div><h4 id="account-metric-trend-title">最近 30 天趋势</h4><p>按知乎官方每日口径记录</p></div>
        <button
          class="account-metric-disclosure"
          type="button"
          :aria-expanded="trendExpanded"
          aria-controls="account-metric-trend-content"
          :aria-label="trendExpanded ? '折叠最近 30 天趋势' : '展开最近 30 天趋势'"
          :title="trendExpanded ? '折叠最近 30 天趋势' : '展开最近 30 天趋势'"
          @click="trendExpanded = !trendExpanded"
        ><span aria-hidden="true">{{ trendExpanded ? '⌃' : '⌄' }}</span></button>
      </div>
      <div v-if="trendExpanded" id="account-metric-trend-content" class="account-metric-section-content">
        <label v-if="trendDefinitions.length > 0" class="account-metric-trend-select">
          <span>指标</span>
          <select v-model="selectedTrendMetricId">
            <option v-for="definition in trendDefinitions" :key="definition.id" :value="definition.id">
              {{ definition.label }}
            </option>
          </select>
        </label>
        <div v-if="trendLoading && !daily" class="account-metric-loading compact">正在读取每日趋势…</div>
        <div v-else-if="trendError" class="account-metric-error compact">
          <span>{{ trendError }}</span><button type="button" @click="loadTrend">重试</button>
        </div>
        <div v-else-if="!trendDefinition || trendSeries.length === 0" class="account-metric-empty compact">
          <span>暂无可用的每日趋势</span>
        </div>
        <div v-else class="account-metric-chart-wrap">
          <svg class="account-metric-chart" viewBox="0 0 720 164" preserveAspectRatio="none" role="img" :aria-label="`${trendDefinition.label}最近 30 天趋势`">
            <line v-if="zeroLineY !== null" x1="14" x2="706" :y1="zeroLineY" :y2="zeroLineY" class="account-metric-zero" />
            <polyline :points="trendPolyline" class="account-metric-line" />
            <circle v-for="point in trendPoints" :key="`${point.date}-${point.capturedAt}`" :cx="point.x" :cy="point.y" r="3" class="account-metric-dot">
              <title>{{ formatAccountMetricDate(point.date) }}：{{ formatContentMetric(point.value, trendDefinition) }} {{ trendDefinition.label }}</title>
            </circle>
          </svg>
          <div class="account-metric-chart-axis">
            <span>{{ formatAccountMetricDate(trendSeries[0]?.date) }}</span>
            <strong>{{ trendDefinition.label }} · {{ trendSeries.length }} 天</strong>
            <span>{{ formatAccountMetricDate(trendSeries.at(-1)?.date) }}</span>
          </div>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.account-metrics-panel { display: grid; margin-bottom: 15px; border-bottom: 1px solid var(--border); }
.account-metric-section { display: grid; gap: 13px; padding: 13px 0; }
.account-metric-section:first-child { padding-top: 2px; }
.account-metric-section + .account-metric-section { border-top: 1px solid var(--border); }
.account-metric-section-content { display: grid; gap: 13px; }
.account-metrics-head, .account-metric-trend-head, .account-metric-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.account-metrics-head h3 { margin-top: 3px; font-size: var(--font-section); line-height: var(--line-section); }
.account-metrics-head p, .account-metric-trend-head p { margin-top: 2px; color: var(--text-tertiary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.account-metric-periods { width: fit-content; }
.account-metric-disclosure { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; padding: 0; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 18px; line-height: 1; }
.account-metric-disclosure:hover { color: var(--brand); border-color: var(--brand); }
.account-metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; opacity: 1; transition: opacity .12s ease; }
.account-metric-grid[aria-busy="true"] { opacity: .6; }
.account-metric-grid article { display: grid; min-width: 0; gap: 5px; padding: 11px 12px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 8px; }
.account-metric-grid article > span { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 5px; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.account-metric-grid em { flex: 0 0 auto; padding: 1px 5px; color: var(--brand); background: var(--brand-soft); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); font-style: normal; }
.account-metric-grid article[data-metric-group="engagement"] em { color: #7665a9; background: #f0edf9; }
.account-metric-grid article[data-metric-group="conversion"] em { color: var(--success); background: var(--success-soft); }
.account-metric-grid strong { overflow: hidden; color: var(--text); font-size: var(--font-metric); line-height: var(--line-metric); text-overflow: ellipsis; white-space: nowrap; }
.account-metric-grid small { min-height: var(--line-caption); overflow: hidden; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); text-overflow: ellipsis; white-space: nowrap; }
.account-metric-grid small.positive { color: var(--success); }
.account-metric-grid small.negative { color: var(--danger); }
.account-metric-trend { gap: 13px; }
.account-metric-trend-head h4 { font-size: var(--font-body); line-height: var(--line-body); }
.account-metric-trend-select { display: flex; width: fit-content; align-items: center; gap: 7px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.account-metric-trend-select select { min-width: 132px; min-height: 33px; padding-block: 5px; }
.account-metric-chart-wrap { min-width: 0; }
.account-metric-chart { display: block; width: 100%; aspect-ratio: 720 / 164; overflow: visible; }
.account-metric-line { fill: none; stroke: var(--brand); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.account-metric-dot { fill: var(--surface); stroke: var(--brand); stroke-width: 2; vector-effect: non-scaling-stroke; }
.account-metric-zero { stroke: var(--border-strong); stroke-dasharray: 4 5; stroke-width: 1; vector-effect: non-scaling-stroke; }
.account-metric-chart-axis { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; margin-top: 3px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.account-metric-chart-axis strong { min-width: 0; overflow: hidden; color: var(--text-secondary); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.account-metric-chart-axis span:last-child { text-align: right; }
.account-metric-foot { padding-top: 10px; color: var(--text-tertiary); border-top: 1px solid var(--border); font-size: var(--font-caption); line-height: var(--line-caption); }
.account-metric-loading, .account-metric-empty { display: grid; min-height: 92px; place-content: center; justify-items: center; gap: 4px; color: var(--text-tertiary); background: var(--surface-subtle); border: 1px dashed var(--border-strong); border-radius: 8px; text-align: center; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.account-metric-empty strong { color: var(--text-secondary); }
.account-metric-loading.compact, .account-metric-empty.compact { min-height: 112px; }
.account-metric-error { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px; color: var(--danger); background: var(--danger-soft); border: 1px solid color-mix(in srgb, var(--danger) 28%, var(--border)); border-radius: 8px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.account-metric-error button { padding: 4px 8px; color: inherit; background: var(--surface); border: 1px solid currentColor; border-radius: 7px; cursor: pointer; }
.account-metric-error.compact { min-height: 48px; }
:global(html[data-theme="dark"]) .account-metric-grid article[data-metric-group="engagement"] em { color: #c3b8ef; background: #2e2944; }
@media (max-width: 1180px) { .account-metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 900px) {
  .account-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .account-metric-periods { width: 100%; }
  .account-metric-periods button { flex: 1; }
}
</style>
