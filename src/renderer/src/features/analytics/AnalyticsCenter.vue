<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AnalyticsOverview, PlatformId } from '../../../../shared/contracts'
import { contentTypeLabel, formatDate, formatNumber, messageOf, platformLabel } from '../shared/format'
import { chartPoints, polylineValue, typeDistribution } from './chart'

type Period = 7 | 30 | 90 | 365

const periods: Period[] = [7, 30, 90, 365]
const days = ref<Period>(30)
const platformId = ref<'' | PlatformId>('')
const overview = ref<AnalyticsOverview | null>(null)
const loading = ref(true)
const error = ref('')
let requestSequence = 0

const viewPoints = computed(() => chartPoints(overview.value?.timeline ?? [], 'views'))
const interactionPoints = computed(() => chartPoints(overview.value?.timeline ?? [], 'interactions'))
const viewPolyline = computed(() => polylineValue(viewPoints.value))
const interactionPolyline = computed(() => polylineValue(interactionPoints.value))
const distribution = computed(() => typeDistribution(overview.value?.byType ?? []))
const sortedAccounts = computed(() => [...(overview.value?.accounts ?? [])]
  .sort((left, right) => right.views - left.views))

async function load(): Promise<void> {
  const sequence = ++requestSequence
  loading.value = true
  overview.value = null
  error.value = ''
  try {
    const result = await window.socialVault.analytics.overview({
      days: days.value,
      ...(platformId.value ? { platformId: platformId.value } : {})
    })
    if (sequence === requestSequence) overview.value = result
  } catch (cause) {
    if (sequence === requestSequence) error.value = messageOf(cause)
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

watch([days, platformId], () => void load())
onMounted(() => void load())
</script>

<template>
  <div class="feature-page analytics-page">
    <header class="page-header feature-header">
      <div><span class="page-eyebrow">ANALYTICS</span><h1>数据分析</h1><p>查看账号和内容指标的变化趋势</p></div>
      <div class="analytics-controls">
        <select v-model="platformId" aria-label="筛选平台"><option value="">全部平台</option><option value="xiaohongshu">小红书</option><option value="weibo">微博</option><option value="douyin">抖音</option><option value="zhihu">知乎</option></select>
        <div class="segmented" role="group" aria-label="统计周期">
          <button v-for="period in periods" :key="period" :class="{ active: days === period }" :aria-pressed="days === period" @click="days = period">{{ period }} 天</button>
        </div>
      </div>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="loading && !overview" class="feature-loading">正在计算指标…</div>

    <template v-else-if="overview">
      <section class="analytics-metrics">
        <article><span>内容数</span><strong>{{ formatNumber(overview.contentCount) }}</strong><small>周期内有快照的内容</small></article>
        <article><span>浏览量</span><strong>{{ formatNumber(overview.views) }}</strong><small>最新可见值汇总</small></article>
        <article><span>互动量</span><strong>{{ formatNumber(overview.interactions) }}</strong><small>赞、评、转、藏</small></article>
        <article><span>关注者</span><strong>{{ formatNumber(overview.followers) }}</strong><small>账号最新快照合计</small></article>
      </section>

      <div class="metric-caveat"><strong>口径提示</strong><span>各平台对浏览、阅读、播放和互动的定义不同，跨平台合计仅用于个人趋势观察，不能视为完全可比的绩效口径。</span></div>

      <section class="feature-card trend-card">
        <div class="feature-card-head">
          <div><h2>{{ overview.days }} 天趋势</h2><p>浏览与互动分别按自身峰值归一化显示</p></div>
          <div class="chart-legend"><span class="views">浏览</span><span class="interactions">互动</span></div>
        </div>
        <div v-if="overview.timeline.length === 0" class="feature-empty compact"><span>⌁</span><strong>还没有趋势数据</strong><p>完成至少两次同步后，趋势会更有参考价值。</p></div>
        <div v-else class="trend-chart">
          <svg viewBox="0 0 800 180" role="img" :aria-label="`${overview.days} 天浏览与互动趋势图`" preserveAspectRatio="none">
            <line v-for="index in 4" :key="index" x1="12" x2="788" :y1="index * 36" :y2="index * 36" class="grid-line" />
            <polyline :points="viewPolyline" class="chart-line views" />
            <polyline :points="interactionPolyline" class="chart-line interactions" />
            <circle v-for="point in viewPoints" :key="`v-${point.date}`" :cx="point.x" :cy="point.y" r="3" class="chart-dot views"><title>{{ point.date }}：{{ formatNumber(point.value) }} 浏览</title></circle>
            <circle v-for="point in interactionPoints" :key="`i-${point.date}`" :cx="point.x" :cy="point.y" r="3" class="chart-dot interactions"><title>{{ point.date }}：{{ formatNumber(point.value) }} 互动</title></circle>
          </svg>
          <div class="chart-axis"><span>{{ formatDate(overview.timeline[0]?.date) }}</span><span>{{ formatDate(overview.timeline.at(-1)?.date) }}</span></div>
        </div>
      </section>

      <div class="analytics-lower">
        <section class="feature-card account-ranking">
          <div class="feature-card-head"><div><h2>账号明细</h2><p>按浏览量从高到低</p></div><span>{{ overview.accounts.length }} 个</span></div>
          <div v-if="sortedAccounts.length === 0" class="compact-empty"><span>暂无账号指标</span></div>
          <div v-else class="analytics-table-wrap">
            <table><thead><tr><th>账号</th><th>内容</th><th>浏览</th><th>互动</th><th>关注者</th></tr></thead>
              <tbody><tr v-for="account in sortedAccounts" :key="account.accountId"><td><strong>{{ account.accountAlias }}</strong><small>{{ platformLabel(account.platformId) }}</small></td><td>{{ formatNumber(account.contentCount) }}</td><td>{{ formatNumber(account.views) }}</td><td>{{ formatNumber(account.interactions) }}</td><td>{{ formatNumber(account.followers) }}</td></tr></tbody>
            </table>
          </div>
        </section>

        <section class="feature-card type-distribution">
          <div class="feature-card-head"><div><h2>内容类型</h2><p>当前筛选范围内的数量分布</p></div></div>
          <div v-if="distribution.length === 0" class="compact-empty"><span>暂无内容类型数据</span></div>
          <div v-for="item in distribution" :key="item.type" class="distribution-row">
            <span>{{ contentTypeLabel(item.type) }}</span><i><b :style="{ width: `${item.percent}%` }"></b></i><strong>{{ item.count }}</strong><small>{{ item.percent.toFixed(0) }}%</small>
          </div>
        </section>
      </div>
      <p class="generated-at">更新时间：{{ formatDate(overview.generatedAt, true) }}</p>
    </template>
  </div>
</template>
