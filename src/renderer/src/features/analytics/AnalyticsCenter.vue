<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type {
  Account,
  AnalyticsComparison,
  AnalyticsComparisonDimension,
  AnalyticsMetricSummary,
  AnalyticsReliabilityStatus,
  AnalyticsScope,
  AnalyticsSummary,
  ContentDetail,
  ContentLifecycleItem,
  ContentLifecycleMilestone,
  ContentLifecycleResult,
  ContentMetricDefinition,
  Group,
  PlatformDefinition,
  StandardAnalyticsMetricId,
  StandardContentMetricId
} from '../../../../shared/contracts'
import {
  availableContentMetricDefinitions,
  formatContentMetric,
  formatContentMetricDelta
} from '../content/metrics'
import { formatDate, formatNumber, messageOf } from '../shared/format'
import {
  contentMetricSemanticsKey,
  contentMetricTrend,
  contentTrendChartSegments,
  contentTrendLatest,
  type ContentTrendPoint,
  contentTrendPolyline
} from './content-trend'
import {
  publishedRangeOptions,
  publishedRangeScope,
  type PublishedRangePreset
} from './published-range'

type AnalyticsView = 'overview' | 'comparison' | 'lifecycle' | 'quality'
type StatisticsGranularity = 'content' | 'week'

const viewOptions: Array<{ id: AnalyticsView; label: string; description: string }> = [
  { id: 'overview', label: '概览', description: '共同指标的当前值与可靠增量' },
  { id: 'comparison', label: '对比', description: '按账号、平台、分组或发布周横向比较' },
  { id: 'lifecycle', label: '内容统计', description: '逐条查看发布里程碑和各指标采集趋势' },
  { id: 'quality', label: '数据质量', description: '观察覆盖、缺失数据和同步警告' }
]

const metricOptions: Array<{ id: StandardAnalyticsMetricId; label: string }> = [
  { id: 'views', label: '浏览' },
  { id: 'likes', label: '点赞' },
  { id: 'comments', label: '评论' },
  { id: 'shares', label: '分享' },
  { id: 'favorites', label: '收藏' },
  { id: 'followers', label: '关注者' },
  { id: 'content_count', label: '内容数' }
]

const lifecycleMetricOptions = metricOptions.filter(
  (option): option is { id: StandardContentMetricId; label: string } => (
    option.id !== 'followers' && option.id !== 'content_count'
  )
)

const dimensionOptions: Array<{ id: AnalyticsComparisonDimension; label: string }> = [
  { id: 'account', label: '账号' },
  { id: 'platform', label: '平台' },
  { id: 'group', label: '分组' },
  { id: 'week', label: '发布周' }
]

const statusPresentation: Record<AnalyticsReliabilityStatus, { label: string; detail: string }> = {
  complete: { label: '完整', detail: '当前范围内存在可靠观察' },
  partial: { label: '部分数据', detail: '仅部分内容具有可靠观察' },
  revision: { label: '数据修订', detail: '累计值发生回退，本次不计算增量' },
  pending: { label: '待到达', detail: '内容尚未到达该生命周期里程碑' },
  missing: { label: '缺失', detail: '没有可证明的可靠观察' }
}

const activeView = ref<AnalyticsView>('overview')
const platforms = ref<PlatformDefinition[]>([])
const accounts = ref<Account[]>([])
const groups = ref<Group[]>([])
const filters = reactive({
  accountId: '',
  platformId: '',
  groupId: '',
  publishedRange: 'all' as PublishedRangePreset
})
const comparisonDimension = ref<AnalyticsComparisonDimension>('account')
const comparisonMetricId = ref<StandardAnalyticsMetricId>('views')
const statisticsGranularity = ref<StatisticsGranularity>('content')
const lifecycleMetricId = ref<StandardContentMetricId>('views')
const lifecycleOffset = ref(0)
const lifecycleLimit = 50

const summary = ref<AnalyticsSummary | null>(null)
const comparison = ref<AnalyticsComparison | null>(null)
const lifecycle = ref<ContentLifecycleResult | null>(null)
const weeklyStatistics = ref<AnalyticsComparison | null>(null)
const loading = ref(true)
const error = ref('')
const metadataError = ref('')
const trendDialogItem = ref<ContentLifecycleItem | null>(null)
const trendDetail = ref<ContentDetail | null>(null)
const trendLoading = ref(false)
const trendError = ref('')
let mounted = false
let requestSequence = 0
let trendRequestSequence = 0
let removeAccountListener: (() => void) | null = null
let removeContentListener: (() => void) | null = null

const platformMap = computed(() => new Map(platforms.value.map((platform) => [platform.id, platform])))
const activeViewDescription = computed(() => (
  viewOptions.find((option) => option.id === activeView.value)?.description ?? ''
))
const comparisonMetricLabel = computed(() => metricLabel(comparisonMetricId.value))
const comparisonMetricOptions = computed(() => (
  comparisonDimension.value === 'week' || filters.publishedRange !== 'all'
    ? lifecycleMetricOptions
    : metricOptions
))
const visibleSummaryMetrics = computed(() => (
  filters.publishedRange === 'all'
    ? summary.value?.metrics ?? []
    : (summary.value?.metrics ?? []).filter((metric) => (
        metric.metricId !== 'followers' && metric.metricId !== 'content_count'
      ))
))
const lifecycleMetricLabel = computed(() => metricLabel(lifecycleMetricId.value))
const lifecycleFirstItem = computed(() => lifecycle.value?.total
  ? lifecycleOffset.value + 1
  : 0)
const lifecycleLastItem = computed(() => Math.min(
  lifecycle.value?.total ?? 0,
  lifecycleOffset.value + (lifecycle.value?.items.length ?? 0)
))
const lifecycleHasNext = computed(() => lifecycleLastItem.value < (lifecycle.value?.total ?? 0))
const missingMetricRows = computed(() => {
  if (!summary.value) return []
  const options = filters.publishedRange === 'all' ? metricOptions : lifecycleMetricOptions
  return options
    .map((option) => ({
      ...option,
      count: summary.value?.quality.missingMetricCounts[option.id] ?? 0
    }))
    .filter((item) => item.count > 0)
})
const trendCharts = computed(() => {
  const detail = trendDetail.value
  if (!detail) return []
  const definitionsBySemantics = new Map(detail.metricSemantics.map((revision) => [
    contentMetricSemanticsKey(revision.contributionId, revision.semanticsRevision),
    new Map(revision.metricDefinitions.map((definition) => [definition.id, definition]))
  ]))
  const currentDefinitions = new Map(detail.metricDefinitions.map((definition) => [definition.id, definition]))
  const historicalDefinitions = detail.metricSemantics.flatMap((revision) => revision.metricDefinitions)
  return availableContentMetricDefinitions(
    [...historicalDefinitions, ...detail.metricDefinitions],
    detail.snapshots
  ).map((fallbackDefinition) => {
    const definitionFor = (semanticsKey: string | undefined): ContentMetricDefinition => (
      (semanticsKey ? definitionsBySemantics.get(semanticsKey)?.get(fallbackDefinition.id) : null) ??
      currentDefinitions.get(fallbackDefinition.id) ?? fallbackDefinition
    )
    const samples = contentMetricTrend(detail.snapshots, fallbackDefinition.id)
    const series = samples.filter((sample) => (
      sample.value !== null && Number.isFinite(sample.value)
    )) as Array<(typeof samples)[number] & { value: number }>
    const segments = contentTrendChartSegments(samples)
    const points = segments.flat()
    const latest = contentTrendLatest(samples)
    const latestDefinition = definitionFor(samples.at(-1)?.semanticsKey)
    let revisionCount = 0
    let semanticsBoundaryCount = 0
    for (let index = 1; index < samples.length; index += 1) {
      const previousSample = samples[index - 1]!
      const currentSample = samples[index]!
      if (previousSample.semanticsKey !== currentSample.semanticsKey) {
        semanticsBoundaryCount += 1
        continue
      }
      if (definitionFor(currentSample.semanticsKey).measurementKind === 'cumulative' &&
        previousSample.value !== null && currentSample.value !== null &&
        currentSample.value < previousSample.value) revisionCount += 1
    }
    const pointDefinitions = Object.fromEntries(samples.map((sample) => [
      sample.semanticsKey ?? '',
      definitionFor(sample.semanticsKey)
    ])) as Record<string, ContentMetricDefinition>
    return {
      definition: latestDefinition,
      pointDefinitions,
      samples,
      series,
      segments,
      points,
      polylines: segments.map((segment) => contentTrendPolyline(segment)),
      latestValue: latest.value,
      latestDelta: latest.delta,
      latestMissing: latest.missing,
      missingCount: samples.length - series.length,
      revisionCount,
      semanticsBoundaryCount
    }
  })
})

function trendPointDefinition(
  chart: { definition: ContentMetricDefinition; pointDefinitions: Record<string, ContentMetricDefinition> },
  point: ContentTrendPoint
): ContentMetricDefinition {
  return chart.pointDefinitions[point.semanticsKey ?? ''] ?? chart.definition
}

function metricLabel(metricId: StandardAnalyticsMetricId): string {
  return metricOptions.find((option) => option.id === metricId)?.label ?? metricId
}

function platformName(platformId: string | null): string {
  if (!platformId) return '跨平台'
  return platformMap.value.get(platformId)?.name ?? platformId
}

function statusLabel(status: AnalyticsReliabilityStatus): string {
  return statusPresentation[status].label
}

function statusDetail(status: AnalyticsReliabilityStatus): string {
  return statusPresentation[status].detail
}

function formatMetricValue(value: number | null): string {
  return value === null ? '—' : formatNumber(value)
}

function formatDelta(value: number | null): string {
  if (value === null) return '—'
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`
}

function formatGrowthRate(value: number | null): string {
  if (value === null) return '—'
  return new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: value === 0 ? 'auto' : 'always'
  }).format(value)
}

function metricForRow(
  metrics: AnalyticsMetricSummary[],
  metricId: StandardAnalyticsMetricId = comparisonMetricId.value
): AnalyticsMetricSummary {
  return metrics.find((metric) => metric.metricId === metricId) ?? {
    metricId,
    label: metricLabel(metricId),
    current: null,
    delta: null,
    growthRate: null,
    sampleCount: 0,
    missingCount: 0,
    revisionCount: 0,
    status: 'missing'
  }
}

function milestoneFor(
  milestones: ContentLifecycleMilestone[],
  id: ContentLifecycleMilestone['id']
): ContentLifecycleMilestone {
  return milestones.find((milestone) => milestone.id === id) ?? {
    id,
    targetHours: { '24h': 24, '7d': 168, '30d': 720 }[id],
    status: 'missing',
    value: null,
    delta: null,
    growthRate: null,
    observedAt: null
  }
}

function milestoneLabel(id: ContentLifecycleMilestone['id']): string {
  return { '24h': '24 小时', '7d': '7 天', '30d': '30 天' }[id]
}

function analyticsScope(): AnalyticsScope {
  return {
    ...(filters.accountId ? { accountIds: [filters.accountId] } : {}),
    ...(filters.platformId ? { platformId: filters.platformId } : {}),
    ...(filters.groupId ? { groupId: filters.groupId } : {}),
    ...publishedRangeScope(filters.publishedRange)
  }
}

async function loadMetadata(): Promise<void> {
  metadataError.value = ''
  try {
    const [platformResult, accountResult, groupResult] = await Promise.all([
      window.socialVault.platforms.list(),
      window.socialVault.accounts.list(),
      window.socialVault.groups.list()
    ])
    platforms.value = platformResult
    accounts.value = accountResult
    groups.value = groupResult
  } catch (cause) {
    metadataError.value = `筛选项读取失败：${messageOf(cause)}`
  }
}

async function loadActiveView(): Promise<void> {
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  try {
    if (activeView.value === 'overview' || activeView.value === 'quality') {
      const result = await window.socialVault.analytics.summary(analyticsScope())
      if (sequence === requestSequence) summary.value = result
    } else if (activeView.value === 'comparison') {
      const result = await window.socialVault.analytics.compare({
        ...analyticsScope(),
        dimension: comparisonDimension.value,
        standardMetricIds: [comparisonMetricId.value]
      })
      if (sequence === requestSequence) comparison.value = result
    } else {
      if (statisticsGranularity.value === 'week') {
        const result = await window.socialVault.analytics.compare({
          ...analyticsScope(),
          dimension: 'week',
          standardMetricIds: [lifecycleMetricId.value]
        })
        if (sequence === requestSequence) weeklyStatistics.value = result
      } else {
        const result = await window.socialVault.analytics.contentLifecycle({
          ...analyticsScope(),
          standardMetricId: lifecycleMetricId.value,
          limit: lifecycleLimit,
          offset: lifecycleOffset.value
        })
        if (sequence === requestSequence) lifecycle.value = result
      }
    }
  } catch (cause) {
    if (sequence === requestSequence) error.value = messageOf(cause)
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

async function refresh(): Promise<void> {
  await Promise.all([loadMetadata(), loadActiveView()])
}

function resetFilters(): void {
  filters.accountId = ''
  filters.platformId = ''
  filters.groupId = ''
  filters.publishedRange = 'all'
}

async function openContentTrend(item: ContentLifecycleItem): Promise<void> {
  const sequence = ++trendRequestSequence
  trendDialogItem.value = item
  trendDetail.value = null
  trendLoading.value = true
  trendError.value = ''
  try {
    const result = await window.socialVault.content.detail(item.contentId)
    if (sequence === trendRequestSequence && trendDialogItem.value?.contentId === item.contentId) {
      trendDetail.value = result
    }
  } catch (cause) {
    if (sequence === trendRequestSequence && trendDialogItem.value?.contentId === item.contentId) {
      trendError.value = messageOf(cause)
    }
  } finally {
    if (sequence === trendRequestSequence) trendLoading.value = false
  }
}

function closeContentTrend(): void {
  trendRequestSequence += 1
  trendDialogItem.value = null
  trendDetail.value = null
  trendLoading.value = false
  trendError.value = ''
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && trendDialogItem.value) closeContentTrend()
}

function goToLifecyclePage(direction: 'previous' | 'next'): void {
  lifecycleOffset.value = direction === 'previous'
    ? Math.max(0, lifecycleOffset.value - lifecycleLimit)
    : lifecycleOffset.value + lifecycleLimit
  void loadActiveView()
}

watch(activeView, () => {
  if (mounted) void loadActiveView()
})

watch(
  () => [filters.accountId, filters.platformId, filters.groupId, filters.publishedRange],
  () => {
    lifecycleOffset.value = 0
    if (filters.publishedRange !== 'all' &&
      (comparisonMetricId.value === 'followers' || comparisonMetricId.value === 'content_count')) {
      comparisonMetricId.value = 'views'
    }
    if (mounted) void loadActiveView()
  }
)

watch([comparisonDimension, comparisonMetricId], () => {
  if (comparisonDimension.value === 'week' &&
    (comparisonMetricId.value === 'followers' || comparisonMetricId.value === 'content_count')) {
    comparisonMetricId.value = 'views'
    return
  }
  if (mounted && activeView.value === 'comparison') void loadActiveView()
})

watch([lifecycleMetricId, statisticsGranularity], () => {
  lifecycleOffset.value = 0
  if (mounted && activeView.value === 'lifecycle') void loadActiveView()
})

onMounted(async () => {
  window.addEventListener('keydown', handleWindowKeydown)
  removeAccountListener = window.socialVault.accounts.onChanged(() => {
    void loadMetadata()
    void loadActiveView()
  })
  removeContentListener = window.socialVault.content.onChanged(() => {
    void loadActiveView()
    if (trendDialogItem.value) void openContentTrend(trendDialogItem.value)
  })
  await loadMetadata()
  mounted = true
  await loadActiveView()
})

onBeforeUnmount(() => {
  requestSequence += 1
  trendRequestSequence += 1
  removeAccountListener?.()
  removeContentListener?.()
  window.removeEventListener('keydown', handleWindowKeydown)
  removeAccountListener = null
  removeContentListener = null
})
</script>

<template>
  <div class="feature-page analysis-page">
    <header class="page-header analysis-header">
      <div>
        <span class="page-eyebrow">可靠分析</span>
        <h1>数据分析</h1>
        <p>{{ activeViewDescription }}</p>
      </div>
      <button class="button analysis-refresh" type="button" :disabled="loading" @click="refresh">
        {{ loading ? '计算中…' : '刷新数据' }}
      </button>
    </header>

    <nav class="analysis-tabs" aria-label="分析视图">
      <button
        v-for="option in viewOptions"
        :key="option.id"
        type="button"
        :class="{ active: activeView === option.id }"
        :aria-current="activeView === option.id ? 'page' : undefined"
        @click="activeView = option.id"
      >
        {{ option.label }}
      </button>
    </nav>

    <section class="analysis-toolbar" aria-label="分析范围">
      <label>
        <span>账号</span>
        <select v-model="filters.accountId">
          <option value="">全部账号</option>
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.alias || account.remoteName }} · {{ platformName(account.platformId) }}
          </option>
        </select>
      </label>
      <label>
        <span>平台</span>
        <select v-model="filters.platformId">
          <option value="">全部平台</option>
          <option v-for="platform in platforms" :key="platform.id" :value="platform.id">
            {{ platform.name }}
          </option>
        </select>
      </label>
      <label>
        <span>分组</span>
        <select v-model="filters.groupId">
          <option value="">全部分组</option>
          <option v-for="group in groups" :key="group.id" :value="group.id">
            {{ group.name }}
          </option>
        </select>
      </label>
      <button class="analysis-reset" type="button" @click="resetFilters">重置</button>
      <div class="published-range-control">
        <span>发帖时间</span>
        <div class="analysis-range-shortcuts" role="group" aria-label="按发帖时间筛选">
          <button
            v-for="option in publishedRangeOptions"
            :key="option.id"
            type="button"
            :class="{ active: filters.publishedRange === option.id }"
            :aria-pressed="filters.publishedRange === option.id"
            :title="option.description"
            @click="filters.publishedRange = option.id"
          >{{ option.label }}</button>
        </div>
      </div>
    </section>

    <div v-if="metadataError" class="analysis-inline-note warning" role="status">
      <span>{{ metadataError }}</span>
      <button type="button" @click="loadMetadata">重试</button>
    </div>

    <div v-if="error" class="analysis-state error" role="alert">
      <span class="analysis-state-icon">!</span>
      <strong>分析数据读取失败</strong>
      <p>{{ error }}</p>
      <button class="button" type="button" @click="loadActiveView">重试</button>
    </div>

    <div v-else-if="loading" class="analysis-state loading" role="status" aria-live="polite">
      <span class="analysis-spinner" aria-hidden="true"></span>
      <strong>正在计算可靠指标</strong>
      <p>数据量较大时可能需要一些时间。</p>
    </div>

    <template v-else-if="activeView === 'overview' && summary">
      <section v-if="visibleSummaryMetrics.length > 0" class="summary-grid" aria-label="指标概览">
        <article v-for="metric in visibleSummaryMetrics" :key="metric.metricId" class="metric-card">
          <header>
            <span>{{ metric.label || metricLabel(metric.metricId) }}</span>
            <span
              class="status-badge"
              :class="`status-${metric.status}`"
              :title="statusDetail(metric.status)"
            >{{ statusLabel(metric.status) }}</span>
          </header>
          <strong :class="{ unknown: metric.current === null }">{{ formatMetricValue(metric.current) }}</strong>
          <small v-if="metric.current === null" class="unknown-copy">无可靠当前值</small>
          <dl>
            <div><dt>增量</dt><dd :class="{ unknown: metric.delta === null }">{{ formatDelta(metric.delta) }}</dd></div>
            <div><dt>增幅</dt><dd :class="{ unknown: metric.growthRate === null }">{{ formatGrowthRate(metric.growthRate) }}</dd></div>
            <div><dt>样本</dt><dd>{{ formatNumber(metric.sampleCount) }}</dd></div>
          </dl>
          <footer v-if="metric.missingCount > 0 || metric.revisionCount > 0">
            <span v-if="metric.missingCount > 0">缺失 {{ metric.missingCount }}</span>
            <span v-if="metric.revisionCount > 0">修订 {{ metric.revisionCount }}</span>
          </footer>
        </article>
      </section>
      <section v-else class="analysis-state empty">
        <span class="analysis-state-icon">◇</span>
        <strong>当前范围没有可分析的指标</strong>
        <p>同步账号内容后，这里会展示当前值、可靠增量和样本覆盖。</p>
      </section>

      <div class="analysis-method-note">
        <strong>计算口径</strong>
        <span>只比较插件明确映射的共同标准指标；缺失观察保持为空，累计值回退标记为“数据修订”，不会制造增量。</span>
      </div>
      <p class="analysis-generated">计算时间：{{ formatDate(summary.generatedAt, true) }}</p>
    </template>

    <template v-else-if="activeView === 'comparison' && comparison">
      <section class="view-controls">
        <div>
          <span>对比维度</span>
          <div class="analysis-segmented" role="group" aria-label="对比维度">
            <button
              v-for="option in dimensionOptions"
              :key="option.id"
              type="button"
              :class="{ active: comparisonDimension === option.id }"
              :aria-pressed="comparisonDimension === option.id"
              @click="comparisonDimension = option.id"
            >{{ option.label }}</button>
          </div>
        </div>
        <label>
          <span>共同指标</span>
          <select v-model="comparisonMetricId">
            <option v-for="option in comparisonMetricOptions" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </label>
        <p v-if="comparisonDimension === 'week'">按内容的本地发布时间所在自然周分组，周一为每周第一天。</p>
        <p v-else-if="filters.publishedRange !== 'all'">发帖时间范围只作用于内容指标，账号级指标不参与当前筛选。</p>
        <p v-else>仅比较各适配器已声明语义一致的标准指标。</p>
      </section>

      <section class="table-card comparison-card">
        <header class="table-card-head">
          <div><h2>{{ comparisonMetricLabel }}对比</h2><p>{{ comparison.rows.length }} 个{{ comparisonDimension === 'week' ? '发布周' : '对比对象' }}</p></div>
          <span>共同口径</span>
        </header>
        <div v-if="comparison.rows.length === 0" class="compact-state">
          <strong>当前范围没有可对比的数据</strong>
          <p>可以扩大时间范围，或切换对比维度。</p>
        </div>
        <div v-else class="analysis-table-wrap">
          <table>
            <thead>
              <tr><th>{{ comparisonDimension === 'week' ? '发布周' : '对象' }}</th><th>内容</th><th>当前值</th><th>绝对增量</th><th>增长率</th><th>可靠样本</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in comparison.rows" :key="row.id">
                <td><strong>{{ row.label }}</strong><small v-if="row.platformId">{{ platformName(row.platformId) }}</small></td>
                <td>{{ formatNumber(row.contentCount) }}</td>
                <td :class="{ unknown: metricForRow(row.metrics).current === null }">{{ formatMetricValue(metricForRow(row.metrics).current) }}</td>
                <td :class="{ unknown: metricForRow(row.metrics).delta === null }">{{ formatDelta(metricForRow(row.metrics).delta) }}</td>
                <td :class="{ unknown: metricForRow(row.metrics).growthRate === null }">{{ formatGrowthRate(metricForRow(row.metrics).growthRate) }}</td>
                <td>{{ formatNumber(metricForRow(row.metrics).sampleCount) }}</td>
                <td><span class="status-badge" :class="`status-${metricForRow(row.metrics).status}`">{{ statusLabel(metricForRow(row.metrics).status) }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p class="analysis-generated">计算时间：{{ formatDate(comparison.generatedAt, true) }}</p>
    </template>

    <template v-else-if="activeView === 'lifecycle' && (lifecycle || weeklyStatistics)">
      <section class="view-controls lifecycle-controls">
        <div>
          <span>统计方式</span>
          <div class="analysis-segmented" role="group" aria-label="内容统计方式">
            <button
              type="button"
              :class="{ active: statisticsGranularity === 'content' }"
              :aria-pressed="statisticsGranularity === 'content'"
              @click="statisticsGranularity = 'content'"
            >按内容</button>
            <button
              type="button"
              :class="{ active: statisticsGranularity === 'week' }"
              :aria-pressed="statisticsGranularity === 'week'"
              @click="statisticsGranularity = 'week'"
            >按周</button>
          </div>
        </div>
        <label>
          <span>内容指标</span>
          <select v-model="lifecycleMetricId">
            <option v-for="option in lifecycleMetricOptions" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </label>
        <p v-if="statisticsGranularity === 'content'">在目标时间容差内选择最近的可靠观察，不插值、不估算。</p>
        <p v-else>按内容发布时间所在自然周汇总最新可靠值和最近一次采集增量。</p>
      </section>

      <template v-if="statisticsGranularity === 'content' && lifecycle">
      <section class="lifecycle-aggregate-grid" aria-label="生命周期中位数">
        <article v-for="aggregate in lifecycle.aggregates" :key="aggregate.id">
          <header><span>{{ milestoneLabel(aggregate.id) }}</span><small>中位数</small></header>
          <strong :class="{ unknown: aggregate.medianValue === null }">{{ formatMetricValue(aggregate.medianValue) }}</strong>
          <dl>
            <div><dt>中位增量</dt><dd :class="{ unknown: aggregate.medianDelta === null }">{{ formatDelta(aggregate.medianDelta) }}</dd></div>
            <div><dt>可靠样本</dt><dd>{{ aggregate.sampleCount }}</dd></div>
          </dl>
          <footer>
            <span v-if="aggregate.pendingCount > 0" class="status-pending">待到达 {{ aggregate.pendingCount }}</span>
            <span v-if="aggregate.missingCount > 0" class="status-missing">缺失 {{ aggregate.missingCount }}</span>
            <span v-if="aggregate.revisionCount > 0" class="status-revision">修订 {{ aggregate.revisionCount }}</span>
            <span v-if="aggregate.sampleCount === 0">无可靠样本</span>
          </footer>
        </article>
      </section>

      <section class="table-card lifecycle-card">
        <header class="table-card-head">
          <div><h2>内容里程碑</h2><p>{{ lifecycleMetricLabel }} · 共 {{ lifecycle.total }} 条内容</p></div>
          <span>{{ lifecycleFirstItem }}–{{ lifecycleLastItem }} / {{ lifecycle.total }}</span>
        </header>
        <div v-if="lifecycle.items.length === 0" class="compact-state">
          <strong>当前范围没有生命周期数据</strong>
          <p>内容需要具有发布时间和同步观察，才能建立可靠里程碑。</p>
        </div>
        <div v-else class="analysis-table-wrap lifecycle-table-wrap">
          <table>
            <thead><tr><th>内容</th><th>发布时间</th><th>24 小时</th><th>7 天</th><th>30 天</th></tr></thead>
            <tbody>
              <tr v-for="item in lifecycle.items" :key="item.contentId">
                <td>
                  <button class="content-trend-trigger" type="button" :aria-label="`查看${item.title || '未命名内容'}的指标趋势`" @click="openContentTrend(item)">
                    <span><strong>{{ item.title || '未命名内容' }}</strong><small>{{ item.accountAlias }} · {{ platformName(item.platformId) }}</small></span>
                    <em>查看趋势</em>
                  </button>
                </td>
                <td>{{ formatDate(item.publishedAt, true) }}</td>
                <td v-for="milestoneId in (['24h', '7d', '30d'] as const)" :key="milestoneId">
                  <div class="milestone-cell">
                    <span class="status-badge" :class="`status-${milestoneFor(item.milestones, milestoneId).status}`">{{ statusLabel(milestoneFor(item.milestones, milestoneId).status) }}</span>
                    <strong :class="{ unknown: milestoneFor(item.milestones, milestoneId).value === null }">{{ formatMetricValue(milestoneFor(item.milestones, milestoneId).value) }}</strong>
                    <small>增量 {{ formatDelta(milestoneFor(item.milestones, milestoneId).delta) }} · 增长 {{ formatGrowthRate(milestoneFor(item.milestones, milestoneId).growthRate) }}</small>
                    <small>观察 {{ formatDate(milestoneFor(item.milestones, milestoneId).observedAt, true) }}</small>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer v-if="lifecycle.total > lifecycleLimit" class="analysis-pagination">
          <button class="button" type="button" :disabled="lifecycleOffset === 0" @click="goToLifecyclePage('previous')">上一页</button>
          <span>{{ lifecycleFirstItem }}–{{ lifecycleLastItem }} / {{ lifecycle.total }}</span>
          <button class="button" type="button" :disabled="!lifecycleHasNext" @click="goToLifecyclePage('next')">下一页</button>
        </footer>
      </section>
      <p class="analysis-generated">计算时间：{{ formatDate(lifecycle.generatedAt, true) }}</p>
      </template>

      <template v-else-if="statisticsGranularity === 'week' && weeklyStatistics">
        <section class="table-card weekly-statistics-card">
          <header class="table-card-head">
            <div><h2>每周内容表现</h2><p>{{ lifecycleMetricLabel }} · {{ weeklyStatistics.rows.length }} 个发布周</p></div>
            <span>周一至周日</span>
          </header>
          <div v-if="weeklyStatistics.rows.length === 0" class="compact-state">
            <strong>当前范围没有周统计数据</strong>
            <p>可以扩大上方发帖时间范围，或同步包含发布时间的内容。</p>
          </div>
          <div v-else class="analysis-table-wrap">
            <table>
              <thead><tr><th>发布周</th><th>内容</th><th>当前值</th><th>最近增量</th><th>增幅</th><th>可靠样本</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="row in weeklyStatistics.rows" :key="row.id">
                  <td><strong>{{ row.label }}</strong></td>
                  <td>{{ formatNumber(row.contentCount) }}</td>
                  <td :class="{ unknown: metricForRow(row.metrics, lifecycleMetricId).current === null }">{{ formatMetricValue(metricForRow(row.metrics, lifecycleMetricId).current) }}</td>
                  <td :class="{ unknown: metricForRow(row.metrics, lifecycleMetricId).delta === null }">{{ formatDelta(metricForRow(row.metrics, lifecycleMetricId).delta) }}</td>
                  <td :class="{ unknown: metricForRow(row.metrics, lifecycleMetricId).growthRate === null }">{{ formatGrowthRate(metricForRow(row.metrics, lifecycleMetricId).growthRate) }}</td>
                  <td>{{ formatNumber(metricForRow(row.metrics, lifecycleMetricId).sampleCount) }}</td>
                  <td><span class="status-badge" :class="`status-${metricForRow(row.metrics, lifecycleMetricId).status}`">{{ statusLabel(metricForRow(row.metrics, lifecycleMetricId).status) }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <div class="analysis-method-note">
          <strong>周统计口径</strong>
          <span>每条内容只归入其发布周；当前值和增量来自该内容最近两次可靠观察，不把关注者等账号指标归因到发帖周。</span>
        </div>
        <p class="analysis-generated">计算时间：{{ formatDate(weeklyStatistics.generatedAt, true) }}</p>
      </template>
    </template>

    <template v-else-if="activeView === 'quality' && summary">
      <section class="quality-grid" aria-label="数据质量概览">
        <article>
          <span>内容总数</span><strong>{{ formatNumber(summary.quality.contentCount) }}</strong>
          <small>当前筛选范围</small>
        </article>
        <article>
          <span>已观察内容</span><strong>{{ formatNumber(summary.quality.observedContentCount) }}</strong>
          <small v-if="summary.quality.contentCount > 0">覆盖 {{ ((summary.quality.observedContentCount / summary.quality.contentCount) * 100).toFixed(1) }}%</small>
          <small v-else>暂无内容，覆盖率未知</small>
        </article>
        <article :class="{ attention: summary.quality.unobservedContentCount > 0 }">
          <span>未观察内容</span><strong>{{ formatNumber(summary.quality.unobservedContentCount) }}</strong>
          <small>没有任何可靠同步观察</small>
        </article>
        <article :class="{ attention: summary.quality.missingPublishedAtCount > 0 }">
          <span>缺少发布时间</span><strong>{{ formatNumber(summary.quality.missingPublishedAtCount) }}</strong>
          <small>无法进入生命周期分析</small>
        </article>
      </section>

      <div class="quality-latest">
        <span>最近可靠观察</span>
        <strong>{{ summary.quality.latestObservationAt ? formatDate(summary.quality.latestObservationAt, true) : '尚无观察' }}</strong>
        <small>指标修订 {{ summary.quality.revisionCount }} 次</small>
      </div>

      <div class="quality-columns">
        <section class="table-card quality-account-card">
          <header class="table-card-head">
            <div><h2>账号覆盖</h2><p>最近同步、最近观察和字段缺失</p></div>
            <span>{{ summary.quality.accounts.length }} 个账号</span>
          </header>
          <div v-if="summary.quality.accounts.length === 0" class="compact-state">
            <strong>当前范围没有账号数据</strong><p>添加并同步账号后可检查采集覆盖。</p>
          </div>
          <div v-else class="analysis-table-wrap">
            <table>
              <thead><tr><th>账号</th><th>内容 / 已观察</th><th>缺发布时间</th><th>最近同步</th><th>最近观察</th></tr></thead>
              <tbody>
                <tr v-for="account in summary.quality.accounts" :key="account.accountId">
                  <td><strong>{{ account.accountAlias }}</strong><small>{{ platformName(account.platformId) }}</small></td>
                  <td>{{ account.contentCount }} / {{ account.observedContentCount }}</td>
                  <td :class="{ attention: account.missingPublishedAtCount > 0 }">{{ account.missingPublishedAtCount }}</td>
                  <td :class="{ unknown: !account.lastSyncedAt }">{{ account.lastSyncedAt ? formatDate(account.lastSyncedAt, true) : '从未同步' }}</td>
                  <td :class="{ unknown: !account.latestObservationAt }">{{ account.latestObservationAt ? formatDate(account.latestObservationAt, true) : '尚无观察' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <aside class="quality-side">
          <section class="table-card missing-card">
            <header class="table-card-head"><div><h2>共同指标缺失</h2><p>缺少可靠当前值的内容数</p></div></header>
            <div v-if="missingMetricRows.length === 0" class="quality-ok">当前范围未发现共同指标缺失</div>
            <dl v-else class="missing-metrics">
              <div v-for="item in missingMetricRows" :key="item.id"><dt>{{ item.label }}</dt><dd>{{ item.count }}</dd></div>
            </dl>
          </section>

          <section class="table-card warning-card">
            <header class="table-card-head">
              <div><h2>同步警告</h2><p>最近任务返回的非致命问题</p></div>
              <span>{{ summary.quality.warnings.length }}</span>
            </header>
            <div v-if="summary.quality.warnings.length === 0" class="quality-ok">当前范围没有同步警告</div>
            <div v-else class="warning-list">
              <article v-for="warning in summary.quality.warnings" :key="`${warning.jobId}-${warning.occurredAt}-${warning.message}`">
                <strong>{{ summary.quality.accounts.find((account) => account.accountId === warning.accountId)?.accountAlias || '未知账号' }}</strong>
                <p>{{ warning.message }}</p>
                <small>{{ formatDate(warning.occurredAt, true) }}</small>
              </article>
            </div>
          </section>
        </aside>
      </div>
      <p class="analysis-generated">检查时间：{{ formatDate(summary.generatedAt, true) }}</p>
    </template>

    <div v-if="trendDialogItem" class="modal-backdrop analysis-trend-backdrop" @click.self="closeContentTrend">
      <section class="modal content-trend-dialog" role="dialog" aria-modal="true" aria-labelledby="content-trend-title" @keydown.esc="closeContentTrend">
        <div class="modal-head content-trend-head">
          <div>
            <span class="page-eyebrow">内容指标趋势</span>
            <h2 id="content-trend-title">{{ trendDialogItem.title || '未命名内容' }}</h2>
            <p>{{ trendDialogItem.accountAlias }} · {{ platformName(trendDialogItem.platformId) }} · 发布 {{ formatDate(trendDialogItem.publishedAt, true) }}</p>
          </div>
          <button type="button" autofocus aria-label="关闭内容指标趋势" @click="closeContentTrend">×</button>
        </div>

        <div v-if="trendLoading" class="content-trend-state" role="status">
          <span class="analysis-spinner" aria-hidden="true"></span>
          <strong>正在读取指标变化快照</strong>
        </div>
        <div v-else-if="trendError" class="content-trend-state error" role="alert">
          <strong>内容趋势读取失败</strong>
          <p>{{ trendError }}</p>
          <button class="button" type="button" @click="openContentTrend(trendDialogItem)">重试</button>
        </div>
        <div v-else-if="trendDetail" class="content-trend-body">
          <div class="content-trend-summary">
            <span><strong>{{ trendDetail.snapshotCount }}</strong> 个指标变化快照</span>
            <span>首次 {{ formatDate(trendDetail.firstCapturedAt, true) }}</span>
            <span>最近 {{ formatDate(trendDetail.lastCapturedAt, true) }}</span>
            <span v-if="trendDetail.snapshotsTruncated" class="trend-history-limit">图表显示最近 {{ trendDetail.snapshots.length }} 个</span>
            <span class="trend-snapshot-note">指标未变化的同步不会重复保存快照</span>
          </div>
          <div v-if="trendCharts.length === 0" class="content-trend-state empty">
            <strong>暂无可绘制的指标</strong>
            <p>该内容还没有包含数值指标的采集快照。</p>
          </div>
          <section v-else class="content-trend-grid" aria-label="各指标变化折线图">
            <article v-for="chart in trendCharts" :key="chart.definition.id">
              <header>
                <span>
                  {{ chart.definition.label }}
                  <small v-if="chart.definition.measurementKind === 'period_total'">周期值</small>
                </span>
                <strong>{{ formatContentMetric(chart.latestValue, chart.definition) }}</strong>
              </header>
              <div class="content-trend-meta">
                <span v-if="chart.latestMissing" class="missing">最近采集缺失</span>
                <span v-else>{{ formatContentMetricDelta(chart.latestDelta, chart.definition) }}</span>
                <span v-if="chart.missingCount > 0">缺失 {{ chart.missingCount }} 个快照点</span>
                <span v-if="chart.semanticsBoundaryCount > 0" class="semantics">指标口径切换 {{ chart.semanticsBoundaryCount }} 次</span>
                <span v-if="chart.revisionCount > 0" class="revision">数据回退 {{ chart.revisionCount }} 次</span>
              </div>
              <svg viewBox="0 0 360 104" preserveAspectRatio="none" role="img" :aria-label="`${chart.definition.label}变化趋势，共${chart.series.length}个有效变化快照`">
                <line x1="12" x2="348" y1="94" y2="94" class="content-trend-gridline" />
                <line x1="12" x2="348" y1="52" y2="52" class="content-trend-gridline" />
                <line x1="12" x2="348" y1="10" y2="10" class="content-trend-gridline" />
                <polyline
                  v-for="(segment, segmentIndex) in chart.segments"
                  v-show="segment.length > 1"
                  :key="`segment-${segmentIndex}`"
                  :points="chart.polylines[segmentIndex]"
                  class="content-trend-line"
                />
                <circle v-for="(point, pointIndex) in chart.points" :key="`${point.capturedAt}-${pointIndex}`" :cx="point.x" :cy="point.y" r="3" class="content-trend-dot">
                  <title>{{ formatDate(point.capturedAt, true) }}：{{ formatContentMetric(point.value, trendPointDefinition(chart, point)) }}</title>
                </circle>
              </svg>
              <footer>
                <span>{{ formatDate(chart.series[0]?.capturedAt, true) }}</span>
                <strong>{{ chart.series.length }} 个有效快照</strong>
                <span>{{ formatDate(chart.series.at(-1)?.capturedAt, true) }}</span>
              </footer>
            </article>
          </section>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.analysis-page { gap: 8px; padding-bottom: 14px; }
.analysis-header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 20px; }
.analysis-refresh { margin-top: 7px; }
.analysis-tabs { display: flex; flex: 0 0 auto; gap: 3px; padding: 3px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 8px; }
.analysis-tabs button { flex: 1; min-height: 32px; padding: 5px 12px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 6px; cursor: pointer; font-size: var(--font-ui); line-height: var(--line-ui); font-weight: 600; }
.analysis-tabs button:hover { color: var(--text); background: color-mix(in srgb, var(--surface) 60%, transparent); }
.analysis-tabs button.active { color: var(--brand); background: var(--surface); box-shadow: var(--shadow-sm); }
.analysis-toolbar { display: grid; flex: 0 0 auto; grid-template-columns: repeat(3, minmax(120px, 1fr)) minmax(360px, 2fr) auto; align-items: end; gap: 7px; padding: 8px 9px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-sm); }
.analysis-toolbar label, .view-controls label, .view-controls > div { display: grid; min-width: 0; gap: 5px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.analysis-toolbar select, .view-controls select { width: 100%; min-height: var(--control-height); padding-block: 5px; }
.analysis-reset { min-height: var(--control-height); grid-column: 5; grid-row: 1; padding: 5px 9px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 6px; cursor: pointer; font-size: var(--font-secondary); }
.analysis-reset:hover { color: var(--text); background: var(--surface-hover); }
.published-range-control { display: grid; min-width: 0; grid-column: 4; grid-row: 1; gap: 5px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.analysis-range-shortcuts { display: flex; min-width: 0; min-height: var(--control-height); align-items: stretch; gap: 2px; padding: 2px; overflow-x: auto; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 7px; scrollbar-width: thin; }
.analysis-range-shortcuts button { min-width: max-content; flex: 1 0 auto; padding: 4px 8px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 5px; cursor: pointer; font-size: var(--font-caption); line-height: var(--line-caption); white-space: nowrap; }
.analysis-range-shortcuts button:hover { color: var(--text); background: var(--surface-hover); }
.analysis-range-shortcuts button.active { color: var(--brand); background: var(--surface); box-shadow: var(--shadow-sm); font-weight: 650; }
.analysis-inline-note { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 11px; color: var(--warning); background: var(--warning-soft); border: 1px solid color-mix(in srgb, var(--warning) 28%, var(--border)); border-radius: 9px; font-size: var(--font-secondary); }
.analysis-inline-note button { color: inherit; background: transparent; border: 0; cursor: pointer; text-decoration: underline; }
.analysis-state { display: grid; min-height: 240px; flex: 1; place-content: center; justify-items: center; gap: 7px; padding: 28px; color: var(--text-tertiary); background: var(--surface); border: 1px solid var(--border); border-radius: 13px; text-align: center; }
.analysis-state strong { color: var(--text); font-size: var(--font-section); line-height: var(--line-section); }
.analysis-state p { max-width: 480px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.analysis-state.error .analysis-state-icon { color: var(--danger); background: var(--danger-soft); }
.analysis-state-icon { display: grid; width: 38px; height: 38px; place-items: center; color: var(--text-secondary); background: var(--surface-subtle); border-radius: 11px; font-size: var(--font-title); }
.analysis-spinner { width: 28px; height: 28px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: analysis-spin .75s linear infinite; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.metric-card { display: grid; min-width: 0; align-content: start; gap: 5px; padding: 11px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-sm); }
.metric-card header, .lifecycle-aggregate-grid article header { display: flex; align-items: center; justify-content: space-between; gap: 9px; color: var(--text-secondary); font-size: var(--font-secondary); }
.metric-card > strong, .lifecycle-aggregate-grid article > strong { font-size: var(--font-metric); line-height: var(--line-metric); letter-spacing: 0; }
.unknown { color: var(--text-tertiary) !important; }
.unknown-copy { margin-top: -7px; color: var(--text-tertiary); font-size: var(--font-caption); }
.metric-card dl, .lifecycle-aggregate-grid dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin: 0; }
.metric-card dl div, .lifecycle-aggregate-grid dl div { min-width: 0; padding: 5px 6px; background: var(--surface-subtle); border-radius: 6px; }
.metric-card dt, .lifecycle-aggregate-grid dt { overflow: hidden; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); text-overflow: ellipsis; white-space: nowrap; }
.metric-card dd, .lifecycle-aggregate-grid dd { margin: 2px 0 0; overflow: hidden; color: var(--text); font-size: var(--font-body); line-height: var(--line-body); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.metric-card footer, .lifecycle-aggregate-grid footer { display: flex; flex-wrap: wrap; gap: 5px; color: var(--warning); font-size: var(--font-caption); line-height: var(--line-caption); }
.status-badge { display: inline-flex; width: fit-content; align-items: center; padding: 2px 7px; color: var(--success); background: var(--success-soft); border: 1px solid color-mix(in srgb, var(--success) 25%, var(--border)); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); white-space: nowrap; }
.status-partial, .status-pending { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 28%, var(--border)); }
.status-revision { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 28%, var(--border)); }
.status-missing { color: var(--text-tertiary); background: var(--surface-subtle); border-color: var(--border); }
.analysis-method-note { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.analysis-method-note strong { flex: 0 0 auto; color: var(--text); }
.analysis-generated { margin: 0; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); text-align: right; }
.view-controls { display: grid; grid-template-columns: minmax(240px, auto) minmax(150px, 220px) minmax(200px, 1fr); align-items: end; gap: 11px; padding: 11px 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 11px; }
.view-controls > p { align-self: center; margin: 18px 0 0; color: var(--text-tertiary); font-size: var(--font-secondary); line-height: var(--line-secondary); text-align: right; }
.analysis-segmented { display: flex; min-height: 36px; padding: 3px; background: var(--surface-subtle); border-radius: 8px; }
.analysis-segmented button { flex: 1; padding: 5px 11px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 6px; cursor: pointer; font-size: var(--font-secondary); }
.analysis-segmented button.active { color: var(--brand); background: var(--surface); box-shadow: var(--shadow-sm); }
.lifecycle-controls { grid-template-columns: minmax(150px, 220px) minmax(150px, 220px) minmax(260px, 1fr); }
.table-card { min-width: 0; flex: 0 0 auto; overflow: hidden; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-sm); }
.table-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 13px 15px; border-bottom: 1px solid var(--border); }
.table-card-head h2 { font-size: var(--font-section); line-height: var(--line-section); }
.table-card-head p { margin-top: 2px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.table-card-head > span { padding: 3px 7px; color: var(--text-secondary); background: var(--surface-subtle); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); white-space: nowrap; }
.analysis-table-wrap { overflow: auto; }
.analysis-table-wrap table { width: 100%; border-collapse: collapse; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.analysis-table-wrap th { padding: 8px 12px; color: var(--text-tertiary); background: var(--surface-subtle); font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 600; text-align: left; white-space: nowrap; }
.analysis-table-wrap td { padding: 10px 12px; border-top: 1px solid var(--border); white-space: nowrap; }
.analysis-table-wrap tbody tr:first-child td { border-top: 0; }
.analysis-table-wrap td:first-child { min-width: 150px; }
.analysis-table-wrap td > strong, .analysis-table-wrap td > small { display: block; }
.analysis-table-wrap td > small { margin-top: 2px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.content-trend-trigger { display: flex; width: 100%; min-width: 210px; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 5px; color: inherit; background: transparent; border: 0; border-radius: 6px; cursor: pointer; text-align: left; }
.content-trend-trigger:hover { background: var(--surface-hover); }
.content-trend-trigger:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.content-trend-trigger > span { min-width: 0; }
.content-trend-trigger strong, .content-trend-trigger small { display: block; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.content-trend-trigger small { margin-top: 2px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.content-trend-trigger em { flex: 0 0 auto; color: var(--brand); font-size: var(--font-caption); line-height: var(--line-caption); font-style: normal; opacity: .8; }
.compact-state { display: grid; min-height: 145px; place-content: center; justify-items: center; gap: 4px; padding: 20px; color: var(--text-tertiary); text-align: center; }
.compact-state strong { color: var(--text); font-size: var(--font-body); }
.compact-state p { font-size: var(--font-caption); line-height: var(--line-caption); }
.lifecycle-aggregate-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.lifecycle-aggregate-grid article { display: grid; min-width: 0; grid-template-columns: minmax(64px, .8fr) auto minmax(112px, 1.4fr); grid-template-areas: "milestone value details" "status status status"; align-items: center; gap: 5px 8px; padding: 9px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.lifecycle-aggregate-grid article header { grid-area: milestone; display: grid; align-items: start; justify-content: start; gap: 1px; }
.lifecycle-aggregate-grid article header small { color: var(--text-tertiary); }
.lifecycle-aggregate-grid article > strong { grid-area: value; font-size: var(--font-section); line-height: var(--line-section); }
.lifecycle-aggregate-grid dl { grid-area: details; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; }
.lifecycle-aggregate-grid dl div { padding: 4px 5px; }
.lifecycle-aggregate-grid footer { grid-area: status; min-height: var(--line-caption); gap: 4px 7px; }
.lifecycle-card { display: grid; flex: 0 0 auto; grid-template-rows: auto auto auto; }
.lifecycle-table-wrap { min-height: 0; height: auto; overflow-x: auto; overflow-y: visible; overscroll-behavior: auto; scrollbar-gutter: auto; }
.lifecycle-table-wrap table { min-width: 980px; }
.lifecycle-table-wrap th { position: sticky; z-index: 1; top: 0; }
.milestone-cell { display: grid; min-width: 150px; gap: 3px; }
.milestone-cell > strong { margin-top: 2px; font-size: var(--font-section); line-height: var(--line-section); }
.milestone-cell > small { margin: 0 !important; }
.analysis-pagination { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--border); color: var(--text-tertiary); font-size: var(--font-caption); }
.analysis-pagination .button { min-height: 32px; padding: 5px 10px; }
.quality-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
.quality-grid article { display: grid; gap: 4px; padding: 14px 15px; background: var(--surface); border: 1px solid var(--border); border-radius: 11px; }
.quality-grid article.attention { border-color: color-mix(in srgb, var(--warning) 38%, var(--border)); }
.quality-grid span { color: var(--text-secondary); font-size: var(--font-secondary); }
.quality-grid strong { font-size: var(--font-metric); line-height: var(--line-metric); }
.quality-grid small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.quality-latest { display: flex; align-items: center; gap: 8px; padding: 9px 12px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; font-size: var(--font-secondary); }
.quality-latest strong { color: var(--text); }
.quality-latest small { margin-left: auto; color: var(--text-tertiary); }
.quality-columns { display: grid; min-height: 260px; grid-template-columns: minmax(0, 1.45fr) minmax(280px, .55fr); align-items: start; gap: 9px; }
.quality-side { display: grid; gap: 9px; }
.quality-account-card .analysis-table-wrap { max-height: 430px; }
.quality-account-card td.attention { color: var(--warning); font-weight: 650; }
.missing-metrics { display: grid; gap: 0; margin: 0; padding: 5px 14px 10px; }
.missing-metrics div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); }
.missing-metrics div:last-child { border-bottom: 0; }
.missing-metrics dt { color: var(--text-secondary); }
.missing-metrics dd { margin: 0; color: var(--warning); font-weight: 650; }
.quality-ok { padding: 17px 15px; color: var(--success); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.warning-list { max-height: 300px; overflow: auto; }
.warning-list article { display: grid; gap: 3px; padding: 10px 14px; border-top: 1px solid var(--border); }
.warning-list article:first-child { border-top: 0; }
.warning-list strong { font-size: var(--font-secondary); }
.warning-list p { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.warning-list small { color: var(--text-tertiary); font-size: var(--font-caption); }
.analysis-trend-backdrop { z-index: 75; }
.content-trend-dialog { width: min(960px, 100%); max-height: calc(100vh - 48px); grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
.content-trend-head { min-width: 0; }
.content-trend-head > div { min-width: 0; }
.content-trend-head h2 { max-width: 780px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.content-trend-state { display: grid; min-height: 260px; place-content: center; justify-items: center; gap: 7px; padding: 20px; color: var(--text-tertiary); background: var(--surface-subtle); border: 1px dashed var(--border-strong); border-radius: 8px; text-align: center; }
.content-trend-state strong { color: var(--text); font-size: var(--font-body); line-height: var(--line-body); }
.content-trend-state p { max-width: 520px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.content-trend-state.error { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 30%, var(--border)); }
.content-trend-state.empty { min-height: 220px; }
.content-trend-body { min-height: 0; overflow: auto; }
.content-trend-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 7px 16px; margin-bottom: 10px; padding: 8px 10px; color: var(--text-tertiary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 7px; font-size: var(--font-caption); line-height: var(--line-caption); }
.content-trend-summary strong { color: var(--text); }
.content-trend-summary .trend-history-limit { color: var(--warning); }
.content-trend-summary .trend-snapshot-note { margin-left: auto; color: var(--text-secondary); }
.content-trend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.content-trend-grid article { display: grid; min-width: 0; gap: 7px; padding: 11px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.content-trend-grid article > header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.content-trend-grid article > header span { min-width: 0; }
.content-trend-grid article > header small { margin-left: 5px; color: var(--text-tertiary); font-size: var(--font-caption); }
.content-trend-grid article > header strong { overflow: hidden; color: var(--text); font-size: var(--font-section); line-height: var(--line-section); text-overflow: ellipsis; white-space: nowrap; }
.content-trend-meta { display: flex; min-height: 18px; flex-wrap: wrap; gap: 4px 10px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.content-trend-meta .missing { color: var(--warning); }
.content-trend-meta .semantics { color: var(--accent); }
.content-trend-meta .revision { color: var(--danger); }
.content-trend-grid svg { display: block; width: 100%; aspect-ratio: 360 / 104; overflow: visible; }
.content-trend-gridline { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.content-trend-line { fill: none; stroke: var(--brand); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.content-trend-dot { fill: var(--surface); stroke: var(--brand); stroke-width: 2; vector-effect: non-scaling-stroke; }
.content-trend-grid article > footer { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 6px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.content-trend-grid article > footer strong { min-width: 0; overflow: hidden; color: var(--text-secondary); font-weight: 600; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.content-trend-grid article > footer span:last-child { text-align: right; }

@media (max-width: 1180px) {
  .analysis-toolbar { grid-template-columns: repeat(3, minmax(0, 1fr)) auto; }
  .analysis-reset { grid-column: 4; grid-row: 1; }
  .published-range-control { grid-column: 1 / -1; grid-row: auto; }
  .quality-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .quality-columns { grid-template-columns: 1fr; }
  .quality-side { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 980px) {
  .view-controls { grid-template-columns: 1fr 180px; }
  .view-controls > p { grid-column: 1 / -1; margin: 0; text-align: left; }
  .lifecycle-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lifecycle-controls > p { grid-column: 1 / -1; }
}

@media (max-width: 780px) {
  .analysis-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .analysis-reset { grid-column: 2; grid-row: 2; justify-self: end; }
  .published-range-control { grid-column: 1 / -1; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lifecycle-aggregate-grid { grid-template-columns: repeat(3, minmax(210px, 1fr)); overflow-x: auto; padding-bottom: 2px; }
  .content-trend-grid { grid-template-columns: 1fr; }
}

@keyframes analysis-spin { to { transform: rotate(360deg); } }
</style>
