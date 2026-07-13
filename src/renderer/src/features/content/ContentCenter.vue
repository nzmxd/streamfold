<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type {
  Account,
  ContentDetail,
  ContentSummary,
  ContentType,
  MetricValues,
  PlatformId
} from '../../../../shared/contracts'
import { accountDisplayName } from '../accounts/presentation'
import { contentTypeLabel, delta, deltaLabel, formatDate, formatNumber, messageOf, platformLabel } from '../shared/format'
import { contentQueryFromFilters, reconcileContentSelection } from './query'

type MetricKey = keyof MetricValues

const accounts = ref<Account[]>([])
const items = ref<ContentSummary[]>([])
const selectedId = ref<string | null>(null)
const detail = ref<ContentDetail | null>(null)
const loading = ref(true)
const detailLoading = ref(false)
const saving = ref(false)
const error = ref('')
const success = ref('')
const search = ref('')
const accountId = ref('')
const platformId = ref<'' | PlatformId>('')
const type = ref<'' | ContentType>('')
const from = ref('')
const to = ref('')
const edit = reactive({ note: '', tags: '' })
let loadSequence = 0
let detailSequence = 0
let saveSequence = 0

const metricFields: Array<{ key: MetricKey; label: string }> = [
  { key: 'views', label: '浏览' },
  { key: 'likes', label: '点赞' },
  { key: 'comments', label: '评论' },
  { key: 'shares', label: '分享' },
  { key: 'favorites', label: '收藏' }
]

const selectedSummary = computed(() => items.value.find((item) => item.id === selectedId.value) ?? null)

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

function metricValue(item: ContentSummary, key: MetricKey): number | null {
  return item.latestSnapshot?.[key] ?? null
}

function metricDelta(item: ContentSummary, key: MetricKey): number | null {
  return delta(item.latestSnapshot?.[key], item.previousSnapshot?.[key])
}

function maxSnapshotViews(value: ContentDetail): number {
  return Math.max(1, ...value.snapshots.map((snapshot) => snapshot.views ?? 0))
}

watch(selectedId, (id) => void loadDetail(id))
watch([accountId, platformId, type, from, to], () => void loadItems())

onMounted(async () => {
  try {
    accounts.value = await window.socialVault.accounts.list()
  } catch (cause) {
    error.value = messageOf(cause)
  }
  await loadItems()
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
          <span class="content-row-metric"><strong>{{ formatNumber(item.latestSnapshot?.views) }}</strong><small>浏览</small></span>
        </button>
      </div>

      <article class="content-detail-panel">
        <div v-if="detailLoading" class="feature-loading">正在读取内容快照…</div>
        <div v-else-if="!detail || !selectedSummary" class="feature-empty"><span>⌁</span><strong>选择一条内容查看详情</strong><p>指标变化按相邻两次本地快照计算。</p></div>
        <template v-else>
          <header class="content-detail-head">
            <div><span class="content-kind">{{ contentTypeLabel(detail.type) }}</span><h2>{{ detail.title || '未命名内容' }}</h2><p>{{ detail.accountAlias }} · {{ platformLabel(detail.platformId) }} · 发布于 {{ formatDate(detail.publishedAt) }}</p></div>
            <span class="snapshot-time">最新快照 {{ formatDate(detail.latestSnapshot?.capturedAt, true) }}</span>
          </header>
          <p v-if="detail.bodyExcerpt" class="content-excerpt">{{ detail.bodyExcerpt }}</p>

          <section class="content-metric-grid">
            <article v-for="field in metricFields" :key="field.key">
              <span>{{ field.label }}</span><strong>{{ formatNumber(metricValue(detail, field.key)) }}</strong>
              <small :class="{ positive: (metricDelta(detail, field.key) ?? 0) > 0 }">{{ deltaLabel(metricDelta(detail, field.key)) }}</small>
            </article>
          </section>

          <section class="snapshot-section">
            <div class="feature-card-head"><div><h3>快照历史</h3><p>每次同步只记录发生变化的指标</p></div><span>{{ detail.snapshots.length }} 次</span></div>
            <div v-if="detail.snapshots.length === 0" class="compact-empty"><span>暂无指标快照</span></div>
            <div v-for="snapshot in detail.snapshots.slice().reverse()" :key="snapshot.capturedAt" class="snapshot-row">
              <span>{{ formatDate(snapshot.capturedAt, true) }}</span>
              <i><b :style="{ width: `${Math.max(2, ((snapshot.views ?? 0) / maxSnapshotViews(detail)) * 100)}%` }"></b></i>
              <strong>{{ formatNumber(snapshot.views) }} 浏览</strong><small>{{ formatNumber(snapshot.likes) }} 赞 · {{ formatNumber(snapshot.comments) }} 评</small>
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
