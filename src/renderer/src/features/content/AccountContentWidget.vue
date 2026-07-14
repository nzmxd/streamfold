<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ContentSummary } from '../../../../shared/contracts'
import { contentTypeLabel, delta, deltaLabel, formatDate, formatNumber, messageOf } from '../shared/format'
import { primaryContentMetric } from './metrics'

const props = defineProps<{ accountId: string; refreshKey?: string | null }>()
const items = ref<ContentSummary[]>([])
const loading = ref(false)
const error = ref('')
let loadSequence = 0

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
</script>

<template>
  <section class="account-content-widget">
    <div class="feature-card-head">
      <div><h3>内容数据</h3><p>最近同步的内容与指标</p></div>
      <button class="button" :disabled="loading" @click="load(accountId)">刷新</button>
    </div>
    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="loading" class="feature-loading compact">正在读取…</div>
    <div v-else-if="items.length === 0" class="feature-empty compact"><span>▤</span><strong>还没有内容数据</strong><p>请在账号概览同步平台本人数据。</p></div>
    <div v-else class="account-content-list">
      <article v-for="item in items" :key="item.id">
        <span class="content-kind">{{ contentTypeLabel(item.type) }}</span>
        <div><strong>{{ item.title || '未命名内容' }}</strong><small>{{ formatDate(item.publishedAt) }} · 最近采集 {{ formatDate(item.latestSnapshot?.capturedAt, true) }}</small></div>
        <div class="mini-metric"><strong>{{ formatNumber(primaryContentMetric(item).value) }}</strong><small>{{ primaryContentMetric(item).label }} · {{ deltaLabel(delta(primaryContentMetric(item).value, primaryContentMetric(item).previousValue)) }}</small></div>
      </article>
    </div>
  </section>
</template>
