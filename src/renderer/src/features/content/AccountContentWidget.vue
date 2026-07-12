<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ContentSummary } from '../../../../shared/contracts'
import { contentTypeLabel, delta, deltaLabel, formatDate, formatNumber, messageOf } from '../shared/format'

const props = defineProps<{ accountId: string }>()
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

watch(() => props.accountId, (id) => void load(id), { immediate: true })
</script>

<template>
  <section class="account-content-widget">
    <div class="feature-card-head">
      <div><h3>本地内容数据</h3><p>来自用户确认归属的本地导入文件</p></div>
      <button class="button" :disabled="loading" @click="load(accountId)">刷新</button>
    </div>
    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="loading" class="feature-loading compact">正在读取…</div>
    <div v-else-if="items.length === 0" class="feature-empty compact"><span>▤</span><strong>还没有内容数据</strong><p>前往插件中心，选择该账号并导入平台官方导出或按模板整理的文件。</p></div>
    <div v-else class="account-content-list">
      <article v-for="item in items" :key="item.id">
        <span class="content-kind">{{ contentTypeLabel(item.type) }}</span>
        <div><strong>{{ item.title || '未命名内容' }}</strong><small>{{ formatDate(item.publishedAt) }} · 最近采集 {{ formatDate(item.latestSnapshot?.capturedAt, true) }}</small></div>
        <div class="mini-metric"><strong>{{ formatNumber(item.latestSnapshot?.views) }}</strong><small>浏览 · {{ deltaLabel(delta(item.latestSnapshot?.views, item.previousSnapshot?.views)) }}</small></div>
      </article>
    </div>
  </section>
</template>
