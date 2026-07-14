<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  Account,
  InstalledPluginPackage,
  PluginContributionState,
  PluginRunRecord,
  PluginRunStatus
} from '../../../../shared/contracts'
import { formatDate } from '../shared/format'
import {
  runStatusLabel,
  runStatusTone,
  triggerLabel
} from './plugin-presentation'

const props = defineProps<{
  runs: PluginRunRecord[]
  packages: InstalledPluginPackage[]
  contributions: PluginContributionState[]
  accounts: Account[]
  busy: boolean
}>()

const emit = defineEmits<{
  retry: [run: PluginRunRecord]
}>()

const statusFilter = ref<'all' | PluginRunStatus>('all')
const pluginFilter = ref('all')

const filteredRuns = computed(() => [...props.runs]
  .filter((run) => statusFilter.value === 'all' || run.status === statusFilter.value)
  .filter((run) => pluginFilter.value === 'all' || run.pluginId === pluginFilter.value)
  .sort((left, right) => right.createdAt.localeCompare(left.createdAt)))

function accountLabel(id: string): string {
  const account = props.accounts.find((item) => item.id === id)
  return account ? account.alias || account.remoteName || account.id : id
}

function contributionLabel(run: PluginRunRecord): string {
  return props.contributions.find((item) => (
    item.pluginId === run.pluginId && item.contribution.id === run.contributionId
  ))?.contribution.name ?? run.contributionId
}
</script>

<template>
  <section class="runs-view">
    <div class="run-toolbar feature-card">
      <div><strong>运行记录</strong><span>记录手动、事件与计划触发的插件执行</span></div>
      <label>插件<select v-model="pluginFilter"><option value="all">全部插件</option><option v-for="plugin in packages" :key="plugin.manifest.id" :value="plugin.manifest.id">{{ plugin.manifest.name }}</option></select></label>
      <label>状态<select v-model="statusFilter"><option value="all">全部状态</option><option value="queued">等待运行</option><option value="running">运行中</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option><option value="interrupted">已中断</option></select></label>
    </div>

    <div v-if="filteredRuns.length" class="run-table-wrap feature-card">
      <table class="run-table">
        <thead><tr><th>状态</th><th>插件 / 贡献点</th><th>触发</th><th>范围</th><th>时间</th><th>结果</th><th></th></tr></thead>
        <tbody>
          <tr v-for="run in filteredRuns" :key="run.id">
            <td><span class="run-status" :class="`tone-${runStatusTone(run.status)}`"><i></i>{{ runStatusLabel(run.status) }}</span></td>
            <td><strong>{{ packages.find((item) => item.manifest.id === run.pluginId)?.manifest.name ?? run.pluginId }}</strong><small>{{ contributionLabel(run) }}</small></td>
            <td><strong>{{ triggerLabel(run.trigger) }}</strong><small>第 {{ run.attempt }} 次尝试</small></td>
            <td><span>{{ run.accountId ? accountLabel(run.accountId) : '通用任务' }}</span><small v-if="run.eventId">事件 {{ run.eventId }}</small></td>
            <td><span>{{ formatDate(run.startedAt ?? run.createdAt, true) }}</span><small v-if="run.nextAttemptAt">下次 {{ formatDate(run.nextAttemptAt, true) }}</small></td>
            <td class="run-result"><span v-if="run.errorMessage" class="run-error" :title="run.errorMessage">{{ run.errorMessage }}</span><small v-if="run.errorCode">{{ run.errorCode }}</small><span v-if="!run.errorMessage">—</span></td>
            <td><button v-if="run.status === 'failed' || run.status === 'interrupted'" class="button" type="button" :disabled="busy" @click="emit('retry', run)">重试</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="feature-card feature-empty"><span>◎</span><strong>没有符合条件的运行记录</strong><p>插件执行后会在这里显示状态、触发来源和错误摘要。</p></div>
  </section>
</template>

<style scoped>
.runs-view { display: grid; gap: 13px; }
.run-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px 160px; align-items: end; gap: 12px; padding: 14px 15px; }
.run-toolbar > div { display: grid; gap: 2px; }
.run-toolbar > div strong { font-size: var(--font-section); line-height: var(--line-section); }
.run-toolbar > div span { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.run-toolbar label { display: grid; gap: 4px; color: var(--text-secondary); font-size: var(--font-caption); line-height: var(--line-caption); }
.run-table-wrap { overflow: auto; }
.run-table { width: 100%; border-collapse: collapse; text-align: left; }
.run-table th { padding: 10px 12px; color: var(--text-tertiary); background: var(--surface-subtle); border-bottom: 1px solid var(--border); font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 600; white-space: nowrap; }
.run-table td { max-width: 260px; padding: 11px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.run-table tbody tr:last-child td { border-bottom: 0; }
.run-table td > strong, .run-table td > span, .run-table td > small { display: block; }
.run-table td > small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.run-status { display: inline-flex !important; align-items: center; gap: 6px; width: max-content; padding: 4px 7px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 99px; font-size: var(--font-caption); line-height: var(--line-caption); }
.run-status.tone-success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 25%, var(--border)); }
.run-status.tone-warning { color: var(--warning); background: var(--warning-soft); border-color: color-mix(in srgb, var(--warning) 25%, var(--border)); }
.run-status.tone-danger { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 25%, var(--border)); }
.run-status.tone-brand { color: var(--brand); background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 25%, var(--border)); }
.run-status i { width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
.run-error { overflow: hidden; color: var(--danger); text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1120px) {
  .run-toolbar { grid-template-columns: minmax(0, 1fr) 160px 150px; }
}
@media (max-width: 960px) {
  .run-toolbar { grid-template-columns: 1fr 1fr; }
  .run-toolbar > div { grid-column: 1 / -1; }
}
</style>
