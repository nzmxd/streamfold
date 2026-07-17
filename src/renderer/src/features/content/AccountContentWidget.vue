<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ContentSummary } from '../../../../shared/contracts'
import { contentTypeLabel, delta, deltaLabel, formatDate, formatNumber, messageOf } from '../shared/format'
import { primaryContentMetric } from './metrics'

const props = defineProps<{ accountId: string; refreshKey?: string | null }>()
const items = ref<ContentSummary[]>([])
const loading = ref(false)
const error = ref('')
const notice = ref('')
const copyingOriginalId = ref<string | null>(null)
let loadSequence = 0
let removeContentListener: (() => void) | null = null

const excerptCount = computed(() => items.value.filter((item) => Boolean(item.bodyExcerpt)).length)

async function load(accountId: string): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await window.socialVault.content.list({ accountId, limit: 50 })
    if (sequence === loadSequence && props.accountId === accountId) items.value = result
  } catch (cause) {
    if (sequence === loadSequence && props.accountId === accountId) error.value = messageOf(cause)
  } finally {
    if (sequence === loadSequence && props.accountId === accountId) loading.value = false
  }
}

watch(
  () => [props.accountId, props.refreshKey] as const,
  ([id]) => void load(id),
  { immediate: true }
)

onMounted(() => {
  removeContentListener = window.socialVault.content.onChanged(() => void load(props.accountId))
})

onBeforeUnmount(() => {
  removeContentListener?.()
  removeContentListener = null
})

async function copyOriginalUrl(item: ContentSummary): Promise<void> {
  if (!item.url || copyingOriginalId.value) return
  copyingOriginalId.value = item.id
  error.value = ''
  notice.value = ''
  try {
    await navigator.clipboard.writeText(item.url)
    notice.value = `已复制《${item.title || '未命名内容'}》的原帖链接。`
  } catch (cause) {
    error.value = `无法复制原帖链接：${messageOf(cause)}`
  } finally {
    if (copyingOriginalId.value === item.id) copyingOriginalId.value = null
  }
}
</script>

<template>
  <section class="account-content-widget">
    <div class="feature-card-head">
      <div>
        <h3>内容数据</h3>
        <p v-if="items.length > 0">最近同步的内容与指标 · {{ excerptCount }}/{{ items.length }} 条包含摘要</p>
        <p v-else>最近同步的内容与指标</p>
      </div>
      <button class="button" :disabled="loading" @click="load(accountId)">刷新</button>
    </div>
    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="notice" class="alert success" role="status"><span>{{ notice }}</span><button @click="notice = ''">关闭</button></div>
    <div v-if="loading" class="feature-loading compact">正在读取…</div>
    <div v-else-if="items.length === 0" class="feature-empty compact"><span>▤</span><strong>还没有内容数据</strong><p>请在账号概览同步平台本人数据。</p></div>
    <div v-else class="account-content-list">
      <article v-for="item in items" :key="item.id">
        <span class="content-kind">{{ contentTypeLabel(item.type) }}</span>
        <div class="account-content-copy">
          <span class="account-content-title"><strong>{{ item.title || '未命名内容' }}</strong><button
            v-if="item.url"
            class="content-copy-link"
            type="button"
            :disabled="copyingOriginalId === item.id"
            :aria-label="`复制《${item.title || '未命名内容'}》原帖链接`"
            :title="copyingOriginalId === item.id ? '正在复制原帖链接' : '复制原帖链接'"
            @click="copyOriginalUrl(item)"
          ><span aria-hidden="true">⧉</span></button></span>
          <p v-if="item.bodyExcerpt" class="account-content-excerpt">{{ item.bodyExcerpt }}</p>
          <p v-else class="account-content-excerpt empty">平台未提供正文摘要</p>
          <small>{{ formatDate(item.publishedAt) }} · 最近采集 {{ formatDate(item.latestSnapshot?.capturedAt, true) }}</small>
        </div>
        <div class="mini-metric"><strong>{{ formatNumber(primaryContentMetric(item).value) }}</strong><small>{{ primaryContentMetric(item).label }} · {{ deltaLabel(delta(primaryContentMetric(item).value, primaryContentMetric(item).previousValue)) }}</small></div>
      </article>
    </div>
  </section>
</template>
