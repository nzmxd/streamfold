<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type {
  Account,
  ContentDetail,
  ContentMetricDefinition,
  ContentSnapshot,
  ContentSummary,
  ContentType,
  PlatformId
} from '../../../../shared/contracts'
import { accountDisplayName } from '../accounts/presentation'
import { contentTypeLabel, formatDate, formatNumber, messageOf, platformLabel } from '../shared/format'
import {
  availableContentMetricDefinitions,
  contentMetricDelta,
  contentMetricValue,
  formatContentMetric,
  formatContentMetricDelta,
  primaryContentMetric,
  resolveContentMetricDefinitions,
  type ContentMetricId
} from './metrics'
import { contentQueryFromFilters, reconcileContentSelection } from './query'

const accounts = ref<Account[]>([])
const items = ref<ContentSummary[]>([])
const selectedId = ref<string | null>(null)
const detail = ref<ContentDetail | null>(null)
const loading = ref(true)
const detailLoading = ref(false)
const saving = ref(false)
const openingOriginalId = ref<string | null>(null)
const error = ref('')
const success = ref('')
const search = ref('')
const accountId = ref('')
const platformId = ref<'' | PlatformId>('')
const type = ref<'' | ContentType>('')
const from = ref('')
const to = ref('')
const edit = reactive({ note: '', tags: '' })
const selectedHistoryMetricId = ref<ContentMetricId | null>(null)
let loadSequence = 0
let detailSequence = 0
let saveSequence = 0
let removeContentListener: (() => void) | null = null

const selectedSummary = computed(() => items.value.find((item) => item.id === selectedId.value) ?? null)
const metricDefinitions = computed(() => resolveContentMetricDefinitions(detail.value?.metricDefinitions ?? []))
const historyMetricDefinitions = computed(() => availableContentMetricDefinitions(
  detail.value?.metricDefinitions ?? [],
  detail.value?.snapshots ?? []
))
const historyMetricDefinition = computed(() => historyMetricDefinitions.value.find((definition) => (
  definition.id === selectedHistoryMetricId.value
)) ?? null)

async function loadItems(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await window.socialVault.content.list(contentQueryFromFilters({
      search: search.value,
      accountId: accountId.value,
      platformId: platformId.value,
      type: type.value,
      from: from.value,
      to: to.value
    }))
    if (sequence !== loadSequence) return
    items.value = result
    selectedId.value = reconcileContentSelection(result, selectedId.value)
  } catch (cause) {
    if (sequence === loadSequence) error.value = messageOf(cause)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadDetail(id: string | null): Promise<void> {
  const sequence = ++detailSequence
  success.value = ''
  detail.value = null
  detailLoading.value = Boolean(id)
  if (!id) return
  try {
    const result = await window.socialVault.content.detail(id)
    if (sequence !== detailSequence || selectedId.value !== id) return
    detail.value = result
    edit.note = result.note
    edit.tags = result.tags.join(', ')
  } catch (cause) {
    if (sequence === detailSequence && selectedId.value === id) error.value = messageOf(cause)
  } finally {
    if (sequence === detailSequence && selectedId.value === id) detailLoading.value = false
  }
}

async function saveMetadata(): Promise<void> {
  if (!detail.value || saving.value) return
  const targetId = detail.value.id
  const sequence = ++saveSequence
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    const result = await window.socialVault.content.update({
      id: targetId,
      note: edit.note,
      tags: edit.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
    })
    if (sequence !== saveSequence || selectedId.value !== targetId) return
    detail.value = result
    const index = items.value.findIndex((item) => item.id === result.id)
    if (index >= 0) items.value.splice(index, 1, result)
    success.value = '备注与标签已保存。'
  } catch (cause) {
    if (sequence === saveSequence && selectedId.value === targetId) error.value = messageOf(cause)
  } finally {
    if (sequence === saveSequence) saving.value = false
  }
}

async function openOriginal(): Promise<void> {
  if (!detail.value?.url || openingOriginalId.value) return
  const targetId = detail.value.id
  openingOriginalId.value = targetId
  error.value = ''
  try {
    await window.socialVault.content.openOriginal(targetId)
  } catch (cause) {
    error.value = `无法打开原帖：${messageOf(cause)}`
  } finally {
    if (openingOriginalId.value === targetId) openingOriginalId.value = null
  }
}

function metricValue(item: ContentSummary, metricId: ContentMetricId): number | null {
  return contentMetricValue(item.latestSnapshot, metricId)
}

function metricDelta(item: ContentSummary, metricId: ContentMetricId): number | null {
  return contentMetricDelta(item.latestSnapshot, item.previousSnapshot, metricId)
}

function snapshotMetricWidth(
  snapshot: ContentSnapshot,
  metricId: ContentMetricId,
  value: ContentDetail
): number {
  const current = contentMetricValue(snapshot, metricId)
  if (current === null || current <= 0) return 0
  const maximum = Math.max(0, ...value.snapshots.map((item) => contentMetricValue(item, metricId) ?? 0))
  return maximum > 0 ? Math.max(2, (current / maximum) * 100) : 0
}

function snapshotSecondaryLabel(snapshot: ContentSnapshot, primary: ContentMetricId | null): string {
  const values = metricDefinitions.value
    .filter((definition) => definition.id !== primary && contentMetricValue(snapshot, definition.id) !== null)
    .slice(0, 2)
    .map((definition) => `${formatContentMetric(contentMetricValue(snapshot, definition.id), definition)} ${definition.label}`)
  return values.join(' · ') || '暂无其他指标'
}

function metricGroupLabel(group: ContentMetricDefinition['group']): string {
  return { reach: '流量', engagement: '互动', conversion: '转化', other: '其他' }[group]
}

watch(selectedId, (id) => void loadDetail(id))
watch([accountId, platformId, type, from, to], () => void loadItems())
watch(historyMetricDefinitions, (definitions) => {
  if (definitions.some((definition) => definition.id === selectedHistoryMetricId.value)) return
  selectedHistoryMetricId.value = definitions[0]?.id ?? null
}, { immediate: true })

async function refreshContent(): Promise<void> {
  await loadItems()
  await loadDetail(selectedId.value)
}

onMounted(async () => {
  removeContentListener = window.socialVault.content.onChanged(() => void refreshContent())
  try {
    accounts.value = await window.socialVault.accounts.list()
  } catch (cause) {
    error.value = messageOf(cause)
  }
  await loadItems()
})

onBeforeUnmount(() => {
  removeContentListener?.()
  removeContentListener = null
})
</script>

<template>
  <div class="feature-page content-page">
    <header class="page-header feature-header">
      <div><span class="page-eyebrow">内容资料库</span><h1>内容中心</h1><p>查看账号内容、指标快照和备注</p></div>
      <span class="header-count">{{ items.length }} 条结果</span>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>

    <form class="filter-bar" role="search" @submit.prevent="loadItems">
      <label class="filter-search"><span>⌕</span><input v-model="search" type="search" placeholder="搜索标题、正文摘要或标签" /></label>
      <label><span>账号</span><select v-model="accountId"><option value="">全部账号</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ accountDisplayName(account, platformLabel(account.platformId)) }}</option></select></label>
      <label><span>平台</span><select v-model="platformId"><option value="">全部平台</option><option value="xiaohongshu">小红书</option><option value="weibo">微博</option><option value="douyin">抖音</option><option value="zhihu">知乎</option></select></label>
      <label><span>类型</span><select v-model="type"><option value="">全部类型</option><option value="article">文章</option><option value="post">动态</option><option value="image">图文</option><option value="video">视频</option><option value="answer">回答</option></select></label>
      <label><span>开始日期</span><input v-model="from" type="date" :max="to || undefined" /></label>
      <label><span>结束日期</span><input v-model="to" type="date" :min="from || undefined" /></label>
      <button class="button" type="submit">搜索</button>
    </form>

    <section class="content-workspace">
      <div class="content-results" role="listbox" aria-label="内容列表">
        <div v-if="loading" class="feature-loading">正在读取内容索引…</div>
        <div v-else-if="items.length === 0" class="feature-empty">
          <span>▤</span><strong>没有匹配的内容</strong>
          <p v-if="accounts.length === 0">请先在账号中心添加本人账号，通过内置浏览器登录官方页面后同步数据。</p>
          <p v-else>可以调整筛选条件，或前往账号中心同步平台本人数据。</p>
        </div>
        <button
          v-for="item in items"
          :key="item.id"
          class="content-row"
          :class="{ active: selectedId === item.id }"
          role="option"
          :aria-selected="selectedId === item.id"
          @click="selectedId = item.id"
        >
          <span class="content-kind">{{ contentTypeLabel(item.type) }}</span>
          <span class="content-row-main"><strong>{{ item.title || '未命名内容' }}</strong><small>{{ item.accountAlias }} · {{ platformLabel(item.platformId) }} · {{ formatDate(item.publishedAt) }}</small><em>{{ item.bodyExcerpt || '没有正文摘要' }}</em></span>
          <span class="content-row-metric"><strong>{{ formatNumber(primaryContentMetric(item).value) }}</strong><small>{{ primaryContentMetric(item).label }}</small></span>
        </button>
      </div>

      <article class="content-detail-panel">
        <div v-if="detailLoading" class="feature-loading">正在读取内容快照…</div>
        <div v-else-if="!detail || !selectedSummary" class="feature-empty"><span>⌁</span><strong>选择一条内容查看详情</strong><p>指标变化按相邻两次本地快照计算。</p></div>
        <template v-else>
          <header class="content-detail-head">
            <div><span class="content-kind">{{ contentTypeLabel(detail.type) }}</span><h2>{{ detail.title || '未命名内容' }}</h2><p>{{ detail.accountAlias }} · {{ platformLabel(detail.platformId) }} · 发布于 {{ formatDate(detail.publishedAt) }}</p></div>
            <div class="content-detail-actions">
              <span class="snapshot-time">最新快照 {{ formatDate(detail.latestSnapshot?.capturedAt, true) }}</span>
              <button
                v-if="detail.url"
                class="button content-original-button"
                type="button"
                :disabled="openingOriginalId === detail.id"
                :aria-busy="openingOriginalId === detail.id"
                :aria-label="`在账号浏览器中查看《${detail.title || '未命名内容'}》原帖`"
                @click="openOriginal"
              >
                {{ openingOriginalId === detail.id ? '正在打开…' : '↗ 查看原帖' }}
              </button>
              <span v-else class="content-original-unavailable">暂无原帖链接</span>
            </div>
          </header>
          <p v-if="detail.bodyExcerpt" class="content-excerpt">{{ detail.bodyExcerpt }}</p>

          <section class="content-metric-grid">
            <article v-for="definition in metricDefinitions" :key="definition.id" :data-metric-group="definition.group">
              <span>{{ definition.label }}<em>{{ metricGroupLabel(definition.group) }}</em></span>
              <strong>{{ formatContentMetric(metricValue(detail, definition.id), definition) }}</strong>
              <small :class="{ positive: (metricDelta(detail, definition.id) ?? 0) > 0 }">{{ formatContentMetricDelta(metricDelta(detail, definition.id), definition) }}</small>
            </article>
          </section>

          <section class="snapshot-section">
            <div class="feature-card-head snapshot-section-head">
              <div><h3>快照历史</h3><p>每次同步只记录发生变化的指标</p></div>
              <div class="snapshot-controls">
                <label v-if="historyMetricDefinitions.length > 0">查看指标<select v-model="selectedHistoryMetricId"><option v-for="definition in historyMetricDefinitions" :key="definition.id" :value="definition.id">{{ definition.label }}</option></select></label>
                <span>{{ detail.snapshots.length }} 次</span>
              </div>
            </div>
            <div v-if="detail.snapshots.length === 0" class="compact-empty"><span>暂无指标快照</span></div>
            <div v-for="snapshot in detail.snapshots.slice().reverse()" :key="snapshot.capturedAt" class="snapshot-row">
              <span>{{ formatDate(snapshot.capturedAt, true) }}</span>
              <i><b v-if="historyMetricDefinition && contentMetricValue(snapshot, historyMetricDefinition.id) !== null" :style="{ width: `${snapshotMetricWidth(snapshot, historyMetricDefinition.id, detail)}%` }"></b></i>
              <strong v-if="historyMetricDefinition">{{ formatContentMetric(contentMetricValue(snapshot, historyMetricDefinition.id), historyMetricDefinition) }} {{ historyMetricDefinition.label }}</strong><strong v-else>暂无可用指标</strong>
              <small>{{ snapshotSecondaryLabel(snapshot, historyMetricDefinition?.id ?? null) }}</small>
            </div>
          </section>

          <form class="metadata-form" @submit.prevent="saveMetadata">
            <div class="feature-card-head"><div><h3>内容整理</h3><p>为内容添加标签和复盘备注</p></div></div>
            <label>标签<input v-model="edit.tags" placeholder="使用逗号分隔" /></label>
            <label>备注<textarea v-model="edit.note" rows="3" maxlength="1000" placeholder="记录选题、复盘或负责人"></textarea></label>
            <div class="form-actions"><button class="button primary" :disabled="saving" type="submit">{{ saving ? '保存中…' : '保存备注' }}</button><span v-if="success" class="success-message">{{ success }}</span></div>
          </form>
        </template>
      </article>
    </section>
  </div>
</template>
