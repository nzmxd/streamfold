<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AppLogEntry, AppLogLevel, AppLogListResult, AppLogQuery } from '../../../../shared/contracts'
import { confirmDialog } from '../../ui/dialog'
import { formatBytes, formatDate, messageOf } from '../shared/format'

const result = ref<AppLogListResult>({ items: [], total: 0, fileBytes: 0, scopes: [] })
const selectedId = ref('')
const loading = ref(true)
const exporting = ref(false)
const clearing = ref(false)
const error = ref('')
const success = ref('')
const search = ref('')
const level = ref<'' | AppLogLevel>('')
const scope = ref('')
let removeChangedListener: (() => void) | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null

const selected = computed(() => (
  result.value.items.find((entry) => entry.id === selectedId.value) ?? result.value.items[0] ?? null
))

function query(): AppLogQuery {
  return {
    ...(search.value.trim() ? { search: search.value.trim() } : {}),
    ...(level.value ? { level: level.value } : {}),
    ...(scope.value ? { scope: scope.value } : {}),
    limit: 500
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    result.value = await window.socialVault.logs.list(query())
    if (!result.value.items.some((entry) => entry.id === selectedId.value)) {
      selectedId.value = result.value.items[0]?.id ?? ''
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => void load(), 300)
}

function resetFilters(): void {
  search.value = ''
  level.value = ''
  scope.value = ''
  void load()
}

async function exportLogs(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  error.value = ''
  success.value = ''
  try {
    const exported = await window.socialVault.logs.export(query())
    if (!exported.cancelled) success.value = `已导出 ${exported.exportedCount} 条日志到 ${exported.fileName}`
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    exporting.value = false
  }
}

async function clearLogs(): Promise<void> {
  if (clearing.value) return
  const confirmed = await confirmDialog({
    title: '清空诊断日志？',
    description: '历史诊断记录将从本机删除。',
    details: ['不会删除账号、内容、任务或插件数据'],
    confirmLabel: '清空日志',
    tone: 'danger'
  })
  if (!confirmed) return
  clearing.value = true
  error.value = ''
  try {
    await window.socialVault.logs.clear()
    await load()
    success.value = '诊断日志已清空。'
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    clearing.value = false
  }
}

async function copySelected(): Promise<void> {
  if (!selected.value) return
  const entry = selected.value
  const text = [
    `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.scope}`,
    entry.code ? `code=${entry.code}` : '',
    entry.message,
    Object.keys(entry.context).length > 0 ? JSON.stringify(entry.context, null, 2) : '',
    entry.details ?? ''
  ].filter(Boolean).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    success.value = '诊断信息已复制。'
  } catch {
    error.value = '无法写入剪贴板。'
  }
}

function levelLabel(value: AppLogLevel): string {
  return { debug: '调试', info: '信息', warn: '警告', error: '错误' }[value]
}

function contextEntries(entry: AppLogEntry): Array<[string, string | number | boolean | null]> {
  return Object.entries(entry.context)
}

onMounted(() => {
  removeChangedListener = window.socialVault.logs.onChanged(scheduleReload)
  void load()
})
onBeforeUnmount(() => {
  removeChangedListener?.()
  if (reloadTimer) clearTimeout(reloadTimer)
})
</script>

<template>
  <div class="feature-page log-page">
    <header class="page-header feature-header compact-page-header">
      <div><span class="page-eyebrow">运行诊断</span><h1>日志中心</h1><p>{{ result.total }} 条记录 · {{ formatBytes(result.fileBytes) }}</p></div>
      <div class="header-actions">
        <button class="button" :disabled="loading" title="刷新日志" @click="load">刷新</button>
        <button class="button" :disabled="exporting" @click="exportLogs">{{ exporting ? '导出中…' : '导出' }}</button>
        <button class="button danger" :disabled="clearing" @click="clearLogs">清空</button>
      </div>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="success" class="alert success"><span>{{ success }}</span><button @click="success = ''">关闭</button></div>

    <form class="log-toolbar" @submit.prevent="load">
      <label class="log-search"><span>搜索</span><input v-model="search" type="search" placeholder="错误码、消息或任务 ID" /></label>
      <label><span>级别</span><select v-model="level"><option value="">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select></label>
      <label><span>模块</span><select v-model="scope"><option value="">全部模块</option><option v-for="item in result.scopes" :key="item" :value="item">{{ item }}</option></select></label>
      <button class="button primary" type="submit">筛选</button>
      <button class="button" type="button" @click="resetFilters">重置</button>
    </form>

    <div class="log-workspace">
      <section class="log-list" aria-label="日志记录">
        <div v-if="loading && result.items.length === 0" class="feature-loading">正在读取日志…</div>
        <div v-else-if="result.items.length === 0" class="compact-empty"><span>没有匹配的日志</span></div>
        <button
          v-for="entry in result.items"
          :key="entry.id"
          type="button"
          class="log-row"
          :class="[{ active: selected?.id === entry.id }, `level-${entry.level}`]"
          @click="selectedId = entry.id"
        >
          <span class="log-level">{{ levelLabel(entry.level) }}</span>
          <span class="log-row-main"><strong>{{ entry.message }}</strong><small>{{ entry.scope }}<template v-if="entry.code"> · {{ entry.code }}</template></small></span>
          <time>{{ formatDate(entry.timestamp, true) }}</time>
        </button>
      </section>

      <aside class="log-detail" aria-label="日志详情">
        <template v-if="selected">
          <div class="log-detail-head">
            <div><span class="log-level" :class="`level-${selected.level}`">{{ levelLabel(selected.level) }}</span><h2>{{ selected.message }}</h2></div>
            <button class="button" @click="copySelected">复制</button>
          </div>
          <dl class="log-metadata">
            <div><dt>时间</dt><dd>{{ formatDate(selected.timestamp, true) }}</dd></div>
            <div><dt>模块</dt><dd>{{ selected.scope }}</dd></div>
            <div><dt>错误码</dt><dd>{{ selected.code || '—' }}</dd></div>
            <div><dt>记录 ID</dt><dd>{{ selected.id }}</dd></div>
          </dl>
          <section v-if="contextEntries(selected).length" class="log-context"><h3>关联信息</h3><dl><div v-for="[key, value] in contextEntries(selected)" :key="key"><dt>{{ key }}</dt><dd>{{ value ?? '—' }}</dd></div></dl></section>
          <section v-if="selected.details" class="log-stack"><h3>调用栈</h3><pre>{{ selected.details }}</pre></section>
        </template>
        <div v-else class="compact-empty"><span>选择一条日志查看详情</span></div>
      </aside>
    </div>
  </div>
</template>
