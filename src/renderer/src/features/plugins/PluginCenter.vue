<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  Account,
  FileImportPreview,
  FileImportResult,
  JobRecord,
  PluginCapability,
  PluginInstallation
} from '../../../../shared/contracts'
import { contentTypeLabel, formatDate, formatNumber, jobStatusLabel, messageOf } from '../shared/format'

type ImportStep = 'account' | 'preview' | 'result'

const plugins = ref<PluginInstallation[]>([])
const accounts = ref<Account[]>([])
const jobs = ref<JobRecord[]>([])
const loading = ref(true)
const error = ref('')
const busyPluginId = ref<string | null>(null)
const importOpen = ref(false)
const importStep = ref<ImportStep>('account')
const importAccountId = ref('')
const preview = ref<FileImportPreview | null>(null)
const importResult = ref<FileImportResult | null>(null)
const ownershipConfirmed = ref(false)
const importBusy = ref(false)
let removeJobListener: (() => void) | null = null

const capabilityLabels: Record<PluginCapability, string> = {
  'account.identity': '核验当前登录身份',
  'account.profile': '读取账号资料',
  'account.metrics': '读取账号指标',
  'content.list': '读取内容列表',
  'content.metrics': '读取内容指标',
  'file.import': '读取所选本地文件'
}

const selectedAccount = computed(() => accounts.value.find((item) => item.id === importAccountId.value) ?? null)
const fileImportPlugin = computed(() => plugins.value.find((item) =>
  item.availability === 'available' && item.manifest.mode === 'file_import'
))
const canImport = computed(() => accounts.value.length > 0 && fileImportPlugin.value?.enabled === true)

function safeFileName(value: string): string {
  return value.split(/[\\/]/).at(-1) || '所选文件'
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [pluginResult, accountResult, jobResult] = await Promise.all([
      window.socialVault.plugins.list(),
      window.socialVault.accounts.list(),
      window.socialVault.jobs.list()
    ])
    plugins.value = pluginResult
    accounts.value = accountResult
    jobs.value = jobResult.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    if (!importAccountId.value && accountResult[0]) importAccountId.value = accountResult[0].id
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function togglePlugin(plugin: PluginInstallation): Promise<void> {
  if (plugin.availability !== 'available' || busyPluginId.value) return
  busyPluginId.value = plugin.manifest.id
  error.value = ''
  try {
    const updated = await window.socialVault.plugins.setEnabled(plugin.manifest.id, !plugin.enabled)
    const index = plugins.value.findIndex((item) => item.manifest.id === updated.manifest.id)
    if (index >= 0) plugins.value.splice(index, 1, updated)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyPluginId.value = null
  }
}

function openImport(): void {
  if (!canImport.value) {
    error.value = accounts.value.length === 0 ? '请先添加本人账号。' : '请先启用内置文件导入插件。'
    return
  }
  importOpen.value = true
  importStep.value = 'account'
  preview.value = null
  importResult.value = null
  ownershipConfirmed.value = false
}

function closeImport(): void {
  if (!importBusy.value) importOpen.value = false
}

async function chooseFileAndPreview(): Promise<void> {
  if (!importAccountId.value || importBusy.value) return
  importBusy.value = true
  error.value = ''
  try {
    const result = await window.socialVault.imports.preview(importAccountId.value)
    if (!result) return
    preview.value = result
    ownershipConfirmed.value = false
    importStep.value = 'preview'
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    importBusy.value = false
  }
}

async function commitImport(): Promise<void> {
  if (!preview.value || !ownershipConfirmed.value || importBusy.value) return
  importBusy.value = true
  error.value = ''
  try {
    const result = await window.socialVault.imports.commit({
      token: preview.value.token,
      accountId: preview.value.accountId,
      confirmOwnership: true
    })
    importResult.value = result
    importStep.value = 'result'
    const index = jobs.value.findIndex((job) => job.id === result.job.id)
    if (index < 0) jobs.value.unshift(result.job)
    else jobs.value.splice(index, 1, result.job)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    importBusy.value = false
  }
}

async function cancelJob(job: JobRecord): Promise<void> {
  if (!['queued', 'validating'].includes(job.status)) return
  try {
    const updated = await window.socialVault.jobs.cancel(job.id)
    const index = jobs.value.findIndex((item) => item.id === job.id)
    if (index >= 0) jobs.value.splice(index, 1, updated)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

function finishImport(): void {
  importOpen.value = false
  void load()
}

onMounted(() => {
  void load()
  removeJobListener = window.socialVault.jobs.onChanged((job) => {
    const index = jobs.value.findIndex((item) => item.id === job.id)
    if (index < 0) jobs.value.unshift(job)
    else jobs.value.splice(index, 1, job)
    if (importResult.value?.job.id === job.id) importResult.value = { ...importResult.value, job }
  })
})
onBeforeUnmount(() => removeJobListener?.())
</script>

<template>
  <div class="feature-page plugin-page">
    <header class="page-header feature-header">
      <div><span class="page-eyebrow">AUDITED EXTENSIONS</span><h1>插件中心</h1><p>仅启用固定版本、明确权限和只读范围的本地插件</p></div>
      <button class="button primary" :disabled="!canImport" :title="!canImport ? '请先添加账号并启用文件导入插件' : undefined" @click="openImport">导入本人数据文件</button>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button @click="error = ''">关闭</button></div>
    <div v-if="loading" class="feature-loading">正在读取插件清单…</div>

    <template v-else>
      <div v-if="accounts.length === 0" class="metric-caveat warning"><strong>需要先添加账号</strong><span>导入前必须选择一个本地账号空间，以确保数据只归属到您本人确认的账号。</span></div>
      <section class="plugin-grid">
        <article v-for="plugin in plugins" :key="plugin.manifest.id" class="plugin-card" :class="{ planned: plugin.availability === 'planned' }">
          <header>
            <span class="plugin-mark">{{ plugin.manifest.mode === 'file_import' ? '⇩' : '◇' }}</span>
            <div><div class="title-line"><h2>{{ plugin.manifest.name }}</h2><span>v{{ plugin.manifest.version }}</span></div><p>{{ plugin.manifest.description }}</p></div>
            <button
              class="switch-control"
              role="switch"
              :aria-checked="plugin.enabled"
              :aria-label="`${plugin.enabled ? '停用' : '启用'} ${plugin.manifest.name}`"
              :disabled="plugin.availability !== 'available' || busyPluginId !== null"
              :class="{ active: plugin.enabled }"
              @click="togglePlugin(plugin)"
            ><i></i></button>
          </header>

          <div class="plugin-badges">
            <span>{{ plugin.manifest.source === 'builtin' ? '内置' : '已审计包' }}</span>
            <span>{{ plugin.manifest.readOnly ? '只读' : '可写' }}</span>
            <span>{{ plugin.manifest.ownedAccountOnly ? '仅本人账号' : '通用' }}</span>
            <span :class="`risk-${plugin.manifest.riskLevel}`">{{ plugin.manifest.riskLevel === 'low' ? '低风险' : plugin.manifest.riskLevel === 'medium' ? '中风险' : '高风险' }}</span>
            <span v-if="plugin.availability === 'planned'" class="planned-badge">规划中</span>
          </div>

          <dl class="manifest-list">
            <div><dt>权限</dt><dd><span v-for="capability in plugin.manifest.capabilities" :key="capability">{{ capabilityLabels[capability] }}</span></dd></div>
            <div><dt>{{ plugin.manifest.mode === 'managed_browser' ? '允许页面' : '网络访问' }}</dt><dd>{{ plugin.manifest.allowedHosts.length ? plugin.manifest.allowedHosts.join('、') : '无网络访问权限' }}</dd></div>
            <div><dt>版本与来源标识</dt><dd>{{ plugin.manifest.commitHash || '随应用内置版本锁定' }}</dd></div>
            <div><dt>运行记录</dt><dd>成功 {{ plugin.successCount }} 次 · 失败 {{ plugin.failureCount }} 次 · 最近 {{ formatDate(plugin.lastRunAt, true) }}</dd></div>
          </dl>

          <footer>
            <span v-if="plugin.lastError" class="plugin-error">最近错误：{{ plugin.lastError }}</span>
            <span v-else>{{ plugin.availability === 'planned' ? '尚未完成安全审计，不能启用' : plugin.enabled ? '插件已启用' : '插件当前停用' }}</span>
            <button v-if="plugin.manifest.mode === 'file_import' && plugin.availability === 'available'" class="button" :disabled="accounts.length === 0 || !plugin.enabled" @click="openImport">选择文件</button>
          </footer>
        </article>
      </section>

      <section class="feature-card job-panel">
        <div class="feature-card-head"><div><h2>本地任务</h2><p>关闭页面不会中断已经提交的数据库写入</p></div><span>{{ jobs.length }} 条</span></div>
        <div v-if="jobs.length === 0" class="compact-empty"><span>还没有导入任务</span></div>
        <div v-for="job in jobs.slice(0, 10)" :key="job.id" class="job-row">
          <span class="job-state" :class="job.status">{{ jobStatusLabel(job.status) }}</span>
          <div><strong>{{ accounts.find((account) => account.id === job.accountId)?.alias || '已移除账号' }}</strong><small>{{ job.stage || '等待处理' }} · {{ formatDate(job.createdAt, true) }}</small></div>
          <div class="job-progress"><i><b :style="{ width: `${Math.max(0, Math.min(100, job.progress))}%` }"></b></i><span>{{ Math.round(job.progress) }}%</span></div>
          <button v-if="['queued', 'validating'].includes(job.status)" class="button" @click="cancelJob(job)">取消</button>
          <span v-else-if="job.errorMessage" class="job-error" :title="job.errorMessage">{{ job.errorMessage }}</span>
        </div>
      </section>
    </template>

    <div v-if="importOpen" class="modal-backdrop" @click.self="closeImport">
      <section class="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div class="modal-head"><div><span class="page-eyebrow">LOCAL FILE IMPORT</span><h2 id="import-title">导入本人账号数据</h2><p>文件只在本机读取、校验并写入本地数据库。</p></div><button :disabled="importBusy" aria-label="关闭" @click="closeImport">×</button></div>

        <ol class="wizard-steps" aria-label="导入步骤"><li :class="{ active: importStep === 'account', done: importStep !== 'account' }">1 选择账号</li><li :class="{ active: importStep === 'preview', done: importStep === 'result' }">2 校验预览</li><li :class="{ active: importStep === 'result' }">3 写入结果</li></ol>

        <template v-if="importStep === 'account'">
          <label>目标账号<select v-model="importAccountId"><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.alias }}</option></select></label>
          <div class="import-guidance"><strong>请选择平台官方导出或按 Social Vault 模板整理的 JSON/CSV</strong><span>不要选择来路不明的抓取包、Cookie 文件或包含密码的文件。选择后会先展示身份与样例，不会直接写入。</span></div>
          <div class="modal-actions"><button class="button" @click="closeImport">取消</button><button class="button primary" :disabled="!selectedAccount || importBusy" @click="chooseFileAndPreview">{{ importBusy ? '正在校验…' : '选择文件并预览' }}</button></div>
        </template>

        <template v-else-if="importStep === 'preview' && preview">
          <section class="preview-summary">
            <div><span>文件</span><strong>{{ safeFileName(preview.fileName) }}</strong><small>{{ preview.format.toUpperCase() }} · 文件名仅用于本地识别</small></div>
            <div><span>目标账号</span><strong>{{ selectedAccount?.alias }}</strong><small>内容 {{ preview.contentCount }} 条 · 快照 {{ preview.snapshotCount }} 条</small></div>
            <div><span>文件身份</span><strong>{{ preview.identity?.remoteName || '未提供身份' }}</strong><small>ID {{ preview.identity?.remoteId || '—' }} · 关注者 {{ formatNumber(preview.identity?.followers) }}</small></div>
          </section>
          <div v-if="preview.warnings.length" class="preview-warnings"><strong>校验提示</strong><ul><li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li></ul></div>
          <section class="sample-table"><div class="feature-card-head"><div><h3>内容样例</h3><p>最多展示解析器返回的少量样例</p></div></div><div v-if="preview.sample.length === 0" class="compact-empty"><span>文件中没有可预览内容</span></div><div v-for="item in preview.sample" :key="item.remoteId" class="sample-row"><span>{{ contentTypeLabel(item.type) }}</span><div><strong>{{ item.title || '未命名内容' }}</strong><small>{{ formatDate(item.publishedAt) }} · {{ formatNumber(item.latestSnapshot?.views) }} 浏览</small></div></div></section>
          <label class="ownership-confirm"><input v-model="ownershipConfirmed" type="checkbox" /><span><strong>我确认这是本人账号的数据</strong><small>确认后才允许将数据写入所选账号空间；客户端不验证文件来源，也不会上传文件或更改平台内容。</small></span></label>
          <div class="modal-actions"><button class="button" :disabled="importBusy" @click="importStep = 'account'">重新选择</button><button class="button primary" :disabled="!ownershipConfirmed || importBusy" @click="commitImport">{{ importBusy ? '正在写入…' : '确认并导入' }}</button></div>
        </template>

        <template v-else-if="importStep === 'result' && importResult">
          <div class="result-hero" :class="importResult.job.status"><span>{{ importResult.job.status === 'failed' ? '!' : '✓' }}</span><h3>{{ jobStatusLabel(importResult.job.status) }}</h3><p>{{ importResult.job.status === 'failed' ? importResult.job.errorMessage : '文件已完成校验并提交到本地数据库。' }}</p></div>
          <section class="result-grid"><div><strong>{{ importResult.newContentCount }}</strong><span>新增内容</span></div><div><strong>{{ importResult.updatedContentCount }}</strong><span>更新内容</span></div><div><strong>{{ importResult.snapshotCount }}</strong><span>新增快照</span></div><div><strong>{{ importResult.skippedSnapshotCount }}</strong><span>跳过重复快照</span></div></section>
          <div class="modal-actions"><button class="button primary" @click="finishImport">完成</button></div>
        </template>
      </section>
    </div>
  </div>
</template>
