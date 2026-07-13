<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type {
  Account,
  EncryptedBackupResult,
  ExportDataResult,
  StorageOverview
} from '../../../../shared/contracts'
import { formatBytes, formatDate, formatNumber, messageOf } from '../shared/format'

const overview = ref<StorageOverview | null>(null)
const accounts = ref<Account[]>([])
const loading = ref(true)
const error = ref('')
const success = ref('')
const retentionDays = ref(30)
const savingRetention = ref(false)
const exportFormat = ref<'json' | 'csv'>('json')
const exportAccountId = ref('')
const exporting = ref(false)
const exportResult = ref<ExportDataResult | null>(null)
const clearingAccountId = ref<string | null>(null)
const backupPassword = ref('')
const backupPasswordConfirm = ref('')
const restorePassword = ref('')
const backupBusy = ref(false)
const restoreBusy = ref(false)
const backupResult = ref<EncryptedBackupResult | null>(null)

function safeFileName(value: string | null): string {
  if (!value) return '—'
  return value.split(/[\\/]/).at(-1) || '—'
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [settingsResult, accountResult] = await Promise.all([
      window.socialVault.settings.overview(),
      window.socialVault.accounts.list()
    ])
    overview.value = settingsResult
    retentionDays.value = settingsResult.rawRetentionDays
    accounts.value = accountResult
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function saveRetention(): Promise<void> {
  if (savingRetention.value || !Number.isInteger(retentionDays.value) || retentionDays.value < 0 || retentionDays.value > 365) return
  savingRetention.value = true
  error.value = ''
  success.value = ''
  try {
    overview.value = await window.socialVault.settings.update({ rawRetentionDays: retentionDays.value })
    success.value = '原始响应保留策略已保存。'
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    savingRetention.value = false
  }
}

async function exportData(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  error.value = ''
  exportResult.value = null
  try {
    exportResult.value = await window.socialVault.settings.exportData({
      format: exportFormat.value,
      ...(exportAccountId.value ? { accountId: exportAccountId.value } : {})
    })
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    exporting.value = false
  }
}

async function clearAccountHistory(account: Account): Promise<void> {
  if (clearingAccountId.value) return
  const confirmed = window.confirm(
    `清空“${account.alias}”的全部本地历史数据？\n\n将删除内容、账号/内容指标快照、导入批次、任务记录和同步游标。登录会话、账号分组和备注会保留，但此操作无法撤销。如需保留账号、内容与指标快照，请先导出 JSON；任务和游标不在导出范围。`
  )
  if (!confirmed) return
  clearingAccountId.value = account.id
  error.value = ''
  success.value = ''
  try {
    await window.socialVault.content.clearAccount(account.id)
    success.value = `已清空“${account.alias}”的内容、指标、导入任务和同步历史。`
    await load()
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    clearingAccountId.value = null
  }
}

async function createEncryptedBackup(): Promise<void> {
  if (backupBusy.value || backupPassword.value.length < 12 || backupPassword.value !== backupPasswordConfirm.value) return
  backupBusy.value = true
  error.value = ''
  success.value = ''
  backupResult.value = null
  try {
    backupResult.value = await window.socialVault.settings.createBackup({ password: backupPassword.value })
    if (!backupResult.value.cancelled) {
      success.value = `加密备份已创建：${safeFileName(backupResult.value.fileName)}`
      await load()
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    backupPassword.value = ''
    backupPasswordConfirm.value = ''
    backupBusy.value = false
  }
}

async function restoreEncryptedBackup(): Promise<void> {
  if (restoreBusy.value || restorePassword.value.length < 12) return
  const confirmed = window.confirm(
    '从加密备份恢复本地数据库？\n\n当前账号、分组、内容、快照、任务和设置将被备份中的版本替换。所有账号都会暂停同步并要求重新打开官方页面核验身份。恢复前请先为当前数据创建新备份。'
  )
  if (!confirmed) return
  restoreBusy.value = true
  error.value = ''
  success.value = ''
  backupResult.value = null
  try {
    backupResult.value = await window.socialVault.settings.restoreBackup({
      password: restorePassword.value,
      confirmReplace: true
    })
    if (!backupResult.value.cancelled) {
      success.value = `已恢复 ${safeFileName(backupResult.value.fileName)}；账号同步已暂停，请重新核验登录身份。`
      if (backupResult.value.warning) success.value += ` ${backupResult.value.warning}`
      await load()
    }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    restorePassword.value = ''
    restoreBusy.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="feature-page settings-page">
    <header class="page-header feature-header">
      <div><span class="page-eyebrow">LOCAL APPLICATION</span><h1>应用设置</h1><p>管理本地存储、数据导出和保留策略</p></div>
      <button class="button" :disabled="loading" @click="load">刷新信息</button>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="success" class="alert success"><span>{{ success }}</span><button @click="success = ''">关闭</button></div>
    <div v-if="loading && !overview" class="feature-loading">正在读取本地设置…</div>

    <template v-else-if="overview">
      <section class="settings-overview">
        <article><span>应用版本</span><strong>v{{ overview.appVersion }}</strong><small>Electron {{ overview.electronVersion }} · Chromium {{ overview.chromiumVersion }}</small></article>
        <article><span>数据库占用</span><strong>{{ formatBytes(overview.databaseBytes) }}</strong><small>SQLite 本地数据库，不展示完整路径</small></article>
        <article><span>内容与快照</span><strong>{{ formatNumber(overview.contentCount) }}</strong><small>{{ formatNumber(overview.contentSnapshotCount) }} 条内容快照 · {{ formatNumber(overview.accountSnapshotCount) }} 条账号快照</small></article>
        <article><span>导入记录</span><strong>{{ formatNumber(overview.importCount) }}</strong><small>{{ formatNumber(overview.jobCount) }} 个任务 · 最近导出 {{ formatDate(overview.lastExportAt, true) }}</small></article>
      </section>

      <div class="settings-columns">
        <section class="feature-card setting-card">
          <div class="feature-card-head"><div><h2>数据保留</h2><p>为未来平台插件预留；结构化内容和指标不会因此自动删除</p></div></div>
          <form class="retention-form" @submit.prevent="saveRetention">
            <label><span>未来平台插件原始响应保留天数</span><input v-model.number="retentionDays" type="number" min="0" max="365" step="1" /><small>文件导入从不保留所选原文件；此策略仅供未来平台插件使用，范围 0–365 天。</small></label>
            <button class="button primary" :disabled="savingRetention || !Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 365" type="submit">{{ savingRetention ? '保存中…' : '保存保留策略' }}</button>
          </form>
        </section>

        <section class="feature-card setting-card">
          <div class="feature-card-head"><div><h2>导出本地数据</h2><p>生成便于归档或二次分析的结构化文件；结构化导出不用于数据库恢复</p></div></div>
          <form class="export-form" @submit.prevent="exportData">
            <label><span>范围</span><select v-model="exportAccountId"><option value="">全部账号</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.alias }}</option></select></label>
            <label><span>格式</span><select v-model="exportFormat"><option value="json">JSON（账号、内容与快照）</option><option value="csv">CSV（内容表格）</option></select></label>
            <button class="button primary" :disabled="exporting" type="submit">{{ exporting ? '正在导出…' : '选择位置并导出' }}</button>
          </form>
          <div v-if="exportResult" class="export-result" :class="{ cancelled: exportResult.cancelled }">
            <strong>{{ exportResult.cancelled ? '已取消导出' : '导出完成' }}</strong>
            <span v-if="!exportResult.cancelled">{{ safeFileName(exportResult.fileName) }} · {{ exportResult.exportedContentCount }} 条内容</span>
            <span v-else>没有创建任何文件。</span>
          </div>
        </section>
      </div>

      <section class="feature-card local-data-card">
        <div class="feature-card-head"><div><h2>加密备份与恢复</h2><p>AES-256-GCM 加密完整本地数据库；密码不会保存，遗失后无法找回</p></div><span>最近备份 {{ formatDate(overview.lastBackupAt, true) }}</span></div>
        <div class="backup-grid">
          <form class="backup-form" @submit.prevent="createEncryptedBackup">
            <strong>创建完整备份</strong>
            <label><span>备份密码</span><input v-model="backupPassword" type="password" minlength="12" maxlength="256" autocomplete="new-password" placeholder="至少 12 个字符" /></label>
            <label><span>再次输入</span><input v-model="backupPasswordConfirm" type="password" minlength="12" maxlength="256" autocomplete="new-password" /></label>
            <small v-if="backupPasswordConfirm && backupPassword !== backupPasswordConfirm" class="danger-text">两次密码不一致</small>
            <button class="button primary" :disabled="backupBusy || backupPassword.length < 12 || backupPassword !== backupPasswordConfirm" type="submit">{{ backupBusy ? '正在加密…' : '选择位置并备份' }}</button>
          </form>
          <form class="backup-form" @submit.prevent="restoreEncryptedBackup">
            <strong>恢复完整备份</strong>
            <label><span>备份密码</span><input v-model="restorePassword" type="password" minlength="12" maxlength="256" autocomplete="current-password" placeholder="输入该备份的密码" /></label>
            <small>恢复会关闭账号浏览器、替换当前本地数据，并暂停所有账号同步等待身份复验。最近恢复 {{ formatDate(overview.lastRestoreAt, true) }}</small>
            <button class="button danger" :disabled="restoreBusy || restorePassword.length < 12" type="submit">{{ restoreBusy ? '正在校验并恢复…' : '选择备份并恢复' }}</button>
          </form>
        </div>
        <div v-if="backupResult?.cancelled" class="export-result cancelled"><strong>已取消</strong><span>没有写入或替换任何数据。</span></div>
      </section>

      <section class="feature-card local-data-card">
        <div class="feature-card-head"><div><h2>按账号管理历史数据</h2><p>清除内容、指标、导入任务和同步游标；登录会话、账号备注及平台数据不受影响</p></div><span>{{ accounts.length }} 个账号</span></div>
        <div v-if="accounts.length === 0" class="compact-empty"><span>还没有本地账号</span></div>
        <div v-for="account in accounts" :key="account.id" class="data-account-row">
          <div><strong>{{ account.alias }}</strong><small>{{ account.remoteName || '身份待确认' }} · 上次同步 {{ formatDate(account.lastSyncedAt, true) }}</small></div>
          <button class="button danger" :disabled="clearingAccountId !== null" @click="clearAccountHistory(account)">{{ clearingAccountId === account.id ? '正在清空…' : '清空历史数据' }}</button>
        </div>
      </section>

      <section class="settings-security-note"><strong>本地优先</strong><span>数据库、导出文件、登录 Cookie 和插件导入文件都只在本机处理。Social Vault 不会代替您向平台发布、删除或修改任何内容。</span></section>
    </template>
  </div>
</template>
