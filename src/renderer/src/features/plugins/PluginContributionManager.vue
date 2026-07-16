<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type {
  Account,
  Group,
  PluginConfigProperty,
  PluginContributionState,
  PluginPermission,
  PluginSchedule,
  PluginScheduleCadence
} from '../../../../shared/contracts'
import { confirmDialog } from '../../ui/dialog'
import { formatDate, messageOf } from '../shared/format'
import { cloneConfigValues, initialConfigValue } from './plugin-config'
import {
  accountsForContribution,
  availableDataScopes,
  parseNetworkOrigins,
  requiresAccountScope,
  toggleListValue,
  type PluginDataScope,
  type PluginManagerSection
} from './plugin-manager-state'
import {
  contributionKindLabel,
  defaultScheduleMinutes,
  minimumScheduleMinutes,
  permissionLabel,
  scheduleCadenceLabel,
  scheduleWeekdayOptions
} from './plugin-presentation'

const props = defineProps<{
  contribution: PluginContributionState
  initialSection: PluginManagerSection
  accounts: Account[]
  groups: Group[]
  schedules: PluginSchedule[]
}>()

const emit = defineEmits<{
  close: []
  'contribution-updated': [contribution: PluginContributionState]
  'schedules-updated': [schedules: PluginSchedule[]]
  toast: [message: string]
}>()

const section = ref<PluginManagerSection>(props.initialSection)
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const configValues = ref<Record<string, unknown>>({})
const secretValues = ref<Record<string, string>>({})
const configuredSecrets = ref<string[]>([])
const clearSecrets = ref<string[]>([])
const networkOriginsText = ref('')

const grantDraft = reactive<{
  permissions: PluginPermission[]
  accountIds: string[]
  groupIds: string[]
  dataScopes: PluginDataScope[]
}>({
  permissions: [...props.contribution.contribution.permissions],
  accountIds: [],
  groupIds: [],
  dataScopes: []
})

type ScheduleCadenceType = PluginScheduleCadence['type']

const scheduleDraft = reactive({
  accountIds: [] as string[],
  groupIds: [] as string[],
  cadenceType: 'interval' as ScheduleCadenceType,
  intervalMinutes: defaultScheduleMinutes(props.contribution.contribution),
  time: '09:00',
  weekdays: [1, 2, 3, 4, 5] as number[],
  monthDays: [1] as number[],
  enabled: false
})
const monthDayOptions = Array.from({ length: 31 }, (_, index) => index + 1)
const scheduleCadenceOptions = [
  { type: 'interval', label: '间隔' },
  { type: 'daily', label: '每天' },
  { type: 'weekly', label: '每周' },
  { type: 'monthly', label: '每月' }
] as const

const selectedSchedules = computed(() => props.schedules.filter((schedule) => (
  schedule.pluginId === props.contribution.pluginId
    && schedule.contributionId === props.contribution.contribution.id
)))
const scheduleCapable = computed(() => props.contribution.contribution.permissions.includes('scheduler.run'))
const visibleAccounts = computed(() => accountsForContribution(props.contribution.contribution, props.accounts))
const dataScopes = computed(() => availableDataScopes(props.contribution.contribution.permissions))
const minimumMinutes = computed(() => minimumScheduleMinutes(props.contribution.contribution))
const scheduleEnableHint = computed(() => scheduleDraft.cadenceType === 'interval'
  ? '启用后从创建时间开始计时，不会立即执行'
  : '启用后等待下一个设定时间，不会立即执行')

async function initialize(): Promise<void> {
  grantDraft.dataScopes = dataScopes.value.map((scope) => scope.id)
  try {
    await Promise.all([loadConfig(), loadGrant()])
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function loadGrant(): Promise<void> {
  if (!props.contribution.granted) return
  const grant = await window.socialVault.plugins.getGrant(
    props.contribution.pluginId,
    props.contribution.contribution.id
  )
  if (!grant) return
  grantDraft.permissions = [...grant.permissions]
  grantDraft.accountIds = [...grant.accountIds]
  grantDraft.groupIds = [...grant.groupIds]
  grantDraft.dataScopes = [...grant.dataScopes]
  networkOriginsText.value = grant.networkOrigins.join('\n')
}

async function loadConfig(): Promise<void> {
  const schema = props.contribution.contribution.configSchema
  if (!schema) return
  const config = await window.socialVault.plugins.getConfig(
    props.contribution.pluginId,
    props.contribution.contribution.id
  )
  const values: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property.type === 'string' && property.format === 'secret') continue
    const saved = config.values[key]
    values[key] = initialConfigValue(property, saved)
  }
  configValues.value = values
  configuredSecrets.value = config.configuredSecrets
}

function close(): void {
  if (!busy.value) emit('close')
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || busy.value) return
  event.preventDefault()
  emit('close')
}

function togglePermission(permission: PluginPermission): void {
  grantDraft.permissions = toggleListValue(grantDraft.permissions, permission)
}

function toggleAccount(id: string, target: 'grant' | 'schedule'): void {
  if (target === 'grant') grantDraft.accountIds = toggleListValue(grantDraft.accountIds, id)
  else scheduleDraft.accountIds = toggleListValue(scheduleDraft.accountIds, id)
}

function toggleGroup(id: string, target: 'grant' | 'schedule'): void {
  if (target === 'grant') grantDraft.groupIds = toggleListValue(grantDraft.groupIds, id)
  else scheduleDraft.groupIds = toggleListValue(scheduleDraft.groupIds, id)
}

function toggleScheduleWeekday(day: number): void {
  scheduleDraft.weekdays = toggleNumberValue(scheduleDraft.weekdays, day)
}

function toggleScheduleMonthDay(day: number): void {
  scheduleDraft.monthDays = toggleNumberValue(scheduleDraft.monthDays, day)
}

function toggleNumberValue(values: readonly number[], value: number): number[] {
  return (values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value]
  ).sort((left, right) => left - right)
}

function scheduleCadenceFromDraft(): PluginScheduleCadence {
  if (scheduleDraft.cadenceType === 'interval') {
    return { type: 'interval', intervalMinutes: scheduleDraft.intervalMinutes }
  }
  if (scheduleDraft.cadenceType === 'daily') {
    return { type: 'daily', time: scheduleDraft.time }
  }
  if (scheduleDraft.cadenceType === 'weekly') {
    return { type: 'weekly', weekdays: [...scheduleDraft.weekdays], time: scheduleDraft.time }
  }
  return { type: 'monthly', monthDays: [...scheduleDraft.monthDays], time: scheduleDraft.time }
}

function toggleDataScope(scope: PluginDataScope): void {
  grantDraft.dataScopes = toggleListValue(grantDraft.dataScopes, scope)
}

async function saveGrant(): Promise<void> {
  if (busy.value) return
  error.value = ''
  if (requiresAccountScope(grantDraft.permissions)
    && grantDraft.accountIds.length === 0
    && grantDraft.groupIds.length === 0) {
    error.value = '请选择允许访问的账号或分组。'
    return
  }
  const networkOrigins = parseNetworkOrigins(networkOriginsText.value)
  if (grantDraft.permissions.includes('network.https') && networkOrigins.length === 0) {
    error.value = '请填写至少一个允许访问的公网 HTTPS 来源。'
    return
  }
  busy.value = true
  try {
    await window.socialVault.plugins.grant({
      pluginId: props.contribution.pluginId,
      contributionId: props.contribution.contribution.id,
      permissions: [...grantDraft.permissions],
      accountIds: [...grantDraft.accountIds],
      groupIds: [...grantDraft.groupIds],
      dataScopes: [...grantDraft.dataScopes],
      networkOrigins
    })
    emit('contribution-updated', { ...props.contribution, granted: true })
    emit('toast', `${props.contribution.contribution.name}的权限范围已保存。`)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = false
  }
}

function stringValue(key: string): string {
  const value = configValues.value[key]
  return typeof value === 'string' ? value : ''
}

function numberValue(key: string): number | string {
  const value = configValues.value[key]
  return typeof value === 'number' ? value : ''
}

function booleanValue(key: string): boolean {
  return configValues.value[key] === true
}

function arrayValue(key: string): string[] {
  const value = configValues.value[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function setTextConfig(key: string, event: Event): void {
  configValues.value[key] = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
}

function setNumberConfig(key: string, event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  configValues.value[key] = raw === '' ? undefined : Number(raw)
}

function setBooleanConfig(key: string, event: Event): void {
  configValues.value[key] = (event.target as HTMLInputElement).checked
}

function setArrayTextConfig(key: string, event: Event): void {
  configValues.value[key] = (event.target as HTMLTextAreaElement).value
    .split(/[,\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function toggleArrayConfig(key: string, value: string): void {
  configValues.value[key] = toggleListValue(arrayValue(key), value)
}

function setSecret(key: string, event: Event): void {
  secretValues.value[key] = (event.target as HTMLInputElement).value
  clearSecrets.value = clearSecrets.value.filter((item) => item !== key)
}

function toggleClearSecret(key: string): void {
  clearSecrets.value = toggleListValue(clearSecrets.value, key)
  if (clearSecrets.value.includes(key)) secretValues.value[key] = ''
}

function propertyRequired(key: string): boolean {
  return props.contribution.contribution.configSchema?.required?.includes(key) ?? false
}

function propertyInputType(property: PluginConfigProperty): string {
  if (property.type !== 'string') return 'text'
  if (property.format === 'secret') return 'password'
  if (property.format === 'url') return 'url'
  return 'text'
}

async function saveConfig(): Promise<void> {
  if (!props.contribution.contribution.configSchema || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const secrets = Object.fromEntries(
      Object.entries(secretValues.value).filter(([, value]) => value.length > 0)
    )
    const config = await window.socialVault.plugins.saveConfig({
      pluginId: props.contribution.pluginId,
      contributionId: props.contribution.contribution.id,
      values: cloneConfigValues(configValues.value),
      ...(Object.keys(secrets).length ? { secrets } : {}),
      ...(clearSecrets.value.length ? { clearSecrets: [...clearSecrets.value] } : {})
    })
    configuredSecrets.value = config.configuredSecrets
    secretValues.value = {}
    clearSecrets.value = []
    emit('toast', `${props.contribution.contribution.name}的配置已保存。`)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = false
  }
}

async function createSchedule(): Promise<void> {
  if (busy.value) return
  error.value = ''
  if (!props.contribution.granted) {
    error.value = '请先在“权限范围”中授权定时执行。'
    return
  }
  if (scheduleDraft.accountIds.length === 0 && scheduleDraft.groupIds.length === 0) {
    error.value = '请选择计划适用的账号或分组。'
    return
  }
  if (scheduleDraft.cadenceType === 'interval' && (
    !Number.isInteger(scheduleDraft.intervalMinutes)
      || scheduleDraft.intervalMinutes < minimumMinutes.value
  )) {
    error.value = `运行间隔不能少于 ${minimumMinutes.value} 分钟。`
    return
  }
  if (scheduleDraft.cadenceType !== 'interval' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleDraft.time)) {
    error.value = '请选择有效的执行时间。'
    return
  }
  if (scheduleDraft.cadenceType === 'weekly' && scheduleDraft.weekdays.length === 0) {
    error.value = '请至少选择一个星期执行日。'
    return
  }
  if (scheduleDraft.cadenceType === 'monthly' && scheduleDraft.monthDays.length === 0) {
    error.value = '请至少选择一个每月执行日。'
    return
  }
  busy.value = true
  try {
    const created = await window.socialVault.plugins.createSchedule({
      pluginId: props.contribution.pluginId,
      contributionId: props.contribution.contribution.id,
      accountIds: [...scheduleDraft.accountIds],
      groupIds: [...scheduleDraft.groupIds],
      cadence: scheduleCadenceFromDraft(),
      enabled: scheduleDraft.enabled
    })
    emit('schedules-updated', [...props.schedules, created])
    scheduleDraft.enabled = false
    emit('toast', '运行计划已创建。')
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = false
  }
}

async function toggleSchedule(schedule: PluginSchedule): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const updated = await window.socialVault.plugins.setScheduleEnabled(schedule.id, !schedule.enabled)
    emit('schedules-updated', props.schedules.map((item) => item.id === updated.id ? updated : item))
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = false
  }
}

async function removeSchedule(schedule: PluginSchedule): Promise<void> {
  if (busy.value) return
  const confirmed = await confirmDialog({
    title: '删除这个运行计划？',
    description: '删除后不会再按这个计划触发插件，已有运行记录会继续保留。',
    confirmLabel: '删除计划',
    tone: 'warning'
  })
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    await window.socialVault.plugins.removeSchedule(schedule.id)
    emit('schedules-updated', props.schedules.filter((item) => item.id !== schedule.id))
    emit('toast', '运行计划已删除。')
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = false
  }
}

function accountLabel(id: string): string {
  const account = props.accounts.find((item) => item.id === id)
  return account ? account.alias || account.remoteName || account.id : id
}

function groupLabel(id: string): string {
  return props.groups.find((item) => item.id === id)?.name ?? id
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  void initialize()
})
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div class="modal-backdrop plugin-manager-backdrop" @pointerdown.self="close">
    <section class="modal plugin-manager" role="dialog" aria-modal="true" aria-labelledby="plugin-manager-title">
      <header class="modal-head plugin-manager-head">
        <div>
          <span class="page-eyebrow">{{ contributionKindLabel(contribution.contribution.kind) }}</span>
          <h2 id="plugin-manager-title">{{ contribution.contribution.name }}</h2>
          <p>{{ contribution.pluginName }} · v{{ contribution.pluginVersion }}</p>
        </div>
        <button type="button" aria-label="关闭" :disabled="busy" @click="close">×</button>
      </header>

      <nav class="manager-tabs" aria-label="贡献点设置">
        <button type="button" :class="{ active: section === 'permissions' }" @click="section = 'permissions'">权限范围</button>
        <button v-if="contribution.contribution.configSchema" type="button" :class="{ active: section === 'config' }" @click="section = 'config'">配置</button>
        <button v-if="scheduleCapable" type="button" :class="{ active: section === 'schedules' }" @click="section = 'schedules'">运行计划 <span>{{ selectedSchedules.length }}</span></button>
      </nav>

      <div v-if="error" class="manager-error"><span>{{ error }}</span><button type="button" @click="error = ''">关闭</button></div>
      <div v-if="loading" class="feature-loading compact">正在读取配置…</div>

      <div v-else-if="section === 'permissions'" class="manager-pane permission-pane">
        <div class="manager-intro"><strong>确认实际授权范围</strong><p>清单声明的是权限上限；这里保存的是此贡献点在本机可使用的实际范围。</p></div>

        <fieldset class="manager-fieldset">
          <legend>能力权限</legend>
          <label v-for="permission in contribution.contribution.permissions" :key="permission" class="check-row">
            <input type="checkbox" :checked="grantDraft.permissions.includes(permission)" @change="togglePermission(permission)">
            <span><strong>{{ permissionLabel(permission) }}</strong><small>{{ permission }}</small></span>
          </label>
        </fieldset>

        <fieldset v-if="dataScopes.length" class="manager-fieldset inline-options">
          <legend>允许返回的数据类型</legend>
          <label v-for="scope in dataScopes" :key="scope.id"><input type="checkbox" :checked="grantDraft.dataScopes.includes(scope.id)" @change="toggleDataScope(scope.id)"><span>{{ scope.label }}</span></label>
        </fieldset>

        <div v-if="requiresAccountScope(grantDraft.permissions)" class="scope-columns">
          <fieldset class="manager-fieldset scope-list">
            <legend>允许访问的账号</legend>
            <p v-if="visibleAccounts.length === 0">没有可用于此贡献点的账号。</p>
            <label v-for="account in visibleAccounts" :key="account.id" class="check-row"><input type="checkbox" :checked="grantDraft.accountIds.includes(account.id)" @change="toggleAccount(account.id, 'grant')"><span><strong>{{ account.alias || account.remoteName || '未命名账号' }}</strong><small>{{ account.remoteName || account.platformId }}</small></span></label>
          </fieldset>
          <fieldset class="manager-fieldset scope-list">
            <legend>允许访问的分组</legend>
            <p v-if="groups.length === 0">还没有账号分组。</p>
            <label v-for="group in groups" :key="group.id" class="check-row"><input type="checkbox" :checked="grantDraft.groupIds.includes(group.id)" @change="toggleGroup(group.id, 'grant')"><span><strong>{{ group.name }}</strong><small>{{ group.accountCount }} 个账号</small></span></label>
          </fieldset>
        </div>

        <label v-if="grantDraft.permissions.includes('network.https')" class="manager-label">允许访问的公网 HTTPS 来源<textarea v-model="networkOriginsText" rows="3" placeholder="https://api.example.com&#10;每行一个来源，不包含路径"></textarea><small>只保存 HTTPS origin；本机、局域网、IP 地址和 URL 凭证会被拒绝。</small></label>

        <div v-if="contribution.granted" class="authorization-note">再次保存会替换此贡献点之前的授权范围。</div>
        <footer class="manager-actions"><button class="button" type="button" :disabled="busy" @click="close">取消</button><button class="button primary" type="button" :disabled="busy" @click="saveGrant">{{ busy ? '正在保存' : '保存授权' }}</button></footer>
      </div>

      <form v-else-if="section === 'config' && contribution.contribution.configSchema" class="manager-pane config-pane" @submit.prevent="saveConfig">
        <div class="manager-intro"><strong>贡献点配置</strong><p>表单由归页根据插件的受限 Schema 生成，不加载插件页面。</p></div>
        <div v-for="(property, key) in contribution.contribution.configSchema.properties" :key="key" class="config-field">
          <label :for="`plugin-config-${String(key)}`">{{ property.title }} <em v-if="propertyRequired(String(key))">必填</em></label>
          <p v-if="property.description">{{ property.description }}</p>

          <select v-if="property.type === 'string' && property.enum" :id="`plugin-config-${String(key)}`" :value="stringValue(String(key))" @change="setTextConfig(String(key), $event)"><option value="">请选择</option><option v-for="option in property.enum" :key="option" :value="option">{{ option }}</option></select>
          <textarea v-else-if="property.type === 'string' && property.format === 'multiline'" :id="`plugin-config-${String(key)}`" rows="4" :value="stringValue(String(key))" @input="setTextConfig(String(key), $event)"></textarea>
          <div v-else-if="property.type === 'string' && property.format === 'secret'" class="secret-field">
            <input :id="`plugin-config-${String(key)}`" :type="propertyInputType(property)" autocomplete="new-password" :value="secretValues[String(key)] ?? ''" :placeholder="configuredSecrets.includes(String(key)) ? '已安全保存；留空表示不修改' : '输入后安全保存'" @input="setSecret(String(key), $event)">
            <label v-if="configuredSecrets.includes(String(key))"><input type="checkbox" :checked="clearSecrets.includes(String(key))" @change="toggleClearSecret(String(key))">清除已保存的值</label>
          </div>
          <input v-else-if="property.type === 'string'" :id="`plugin-config-${String(key)}`" :type="propertyInputType(property)" :value="stringValue(String(key))" :minlength="property.minLength" :maxlength="property.maxLength" @input="setTextConfig(String(key), $event)">
          <label v-else-if="property.type === 'boolean'" class="boolean-field"><input :id="`plugin-config-${String(key)}`" type="checkbox" :checked="booleanValue(String(key))" @change="setBooleanConfig(String(key), $event)"><span>启用</span></label>
          <input v-else-if="property.type === 'integer' || property.type === 'number'" :id="`plugin-config-${String(key)}`" type="number" :step="property.type === 'integer' ? 1 : 'any'" :min="property.minimum" :max="property.maximum" :value="numberValue(String(key))" @input="setNumberConfig(String(key), $event)">
          <div v-else-if="property.type === 'array' && property.items.enum" class="array-options"><label v-for="option in property.items.enum" :key="option"><input type="checkbox" :checked="arrayValue(String(key)).includes(option)" @change="toggleArrayConfig(String(key), option)"><span>{{ option }}</span></label></div>
          <textarea v-else-if="property.type === 'array'" :id="`plugin-config-${String(key)}`" rows="3" :value="arrayValue(String(key)).join('\n')" placeholder="每行一个值" @input="setArrayTextConfig(String(key), $event)"></textarea>
        </div>
        <footer class="manager-actions"><button class="button" type="button" :disabled="busy" @click="close">取消</button><button class="button primary" type="submit" :disabled="busy">{{ busy ? '正在保存' : '保存配置' }}</button></footer>
      </form>

      <div v-else-if="section === 'schedules'" class="manager-pane schedules-pane">
        <div class="manager-intro"><strong>自动运行计划</strong><p>计划默认关闭。错过多个周期只补执行一次，同账号任务会互斥运行。</p></div>

        <div v-if="selectedSchedules.length" class="schedule-list">
          <article v-for="schedule in selectedSchedules" :key="schedule.id" :class="{ suspended: schedule.suspendedReason }">
            <header><div><strong>{{ scheduleCadenceLabel(schedule.cadence) }}</strong><span>{{ schedule.enabled ? '运行中' : '已暂停' }}</span></div><button class="switch-control update-switch" role="switch" :aria-label="schedule.enabled ? '暂停计划' : '启用计划'" :aria-checked="schedule.enabled" :disabled="busy" :class="{ active: schedule.enabled }" @click="toggleSchedule(schedule)"><i></i></button></header>
            <p>{{ schedule.accountIds.map(accountLabel).join('、') || schedule.groupIds.map(groupLabel).join('、') || '未选择范围' }}</p>
            <dl><div><dt>下次运行</dt><dd>{{ formatDate(schedule.nextRunAt, true) }}</dd></div><div><dt>上次运行</dt><dd>{{ formatDate(schedule.lastRunAt, true) }}</dd></div><div><dt>连续失败</dt><dd>{{ schedule.consecutiveFailures }} 次</dd></div></dl>
            <div v-if="schedule.suspendedReason" class="schedule-warning">{{ schedule.suspendedReason }}</div>
            <footer><span>创建于 {{ formatDate(schedule.createdAt, true) }}</span><button type="button" :disabled="busy" @click="removeSchedule(schedule)">删除</button></footer>
          </article>
        </div>
        <div v-else class="compact-empty"><strong>还没有运行计划</strong><span>选择账号或分组并设置执行方式后创建。</span></div>

        <section class="schedule-create">
          <h3>创建计划</h3>
          <div class="scope-columns">
            <fieldset class="manager-fieldset scope-list"><legend>适用账号</legend><p v-if="visibleAccounts.length === 0">没有可用账号。</p><label v-for="account in visibleAccounts" :key="account.id" class="check-row"><input type="checkbox" :checked="scheduleDraft.accountIds.includes(account.id)" @change="toggleAccount(account.id, 'schedule')"><span><strong>{{ account.alias || account.remoteName || '未命名账号' }}</strong><small>{{ account.remoteName || account.platformId }}</small></span></label></fieldset>
            <fieldset class="manager-fieldset scope-list"><legend>适用分组</legend><p v-if="groups.length === 0">还没有账号分组。</p><label v-for="group in groups" :key="group.id" class="check-row"><input type="checkbox" :checked="scheduleDraft.groupIds.includes(group.id)" @change="toggleGroup(group.id, 'schedule')"><span><strong>{{ group.name }}</strong><small>{{ group.accountCount }} 个账号</small></span></label></fieldset>
          </div>
          <div class="schedule-controls">
            <fieldset class="cadence-config">
              <legend>执行方式</legend>
              <div class="cadence-segments" role="tablist" aria-label="计划执行方式">
                <button v-for="option in scheduleCadenceOptions" :key="option.type" type="button" role="tab" :aria-selected="scheduleDraft.cadenceType === option.type" :class="{ active: scheduleDraft.cadenceType === option.type }" @click="scheduleDraft.cadenceType = option.type">{{ option.label }}</button>
              </div>
              <label v-if="scheduleDraft.cadenceType === 'interval'" class="cadence-value">运行间隔（分钟）<input v-model.number="scheduleDraft.intervalMinutes" type="number" :min="minimumMinutes" step="1"><small>最短 {{ minimumMinutes }} 分钟</small></label>
              <label v-else class="cadence-value">执行时间<input v-model="scheduleDraft.time" type="time" step="60"><small>按当前系统时区执行</small></label>
              <fieldset v-if="scheduleDraft.cadenceType === 'weekly'" class="cadence-days weekday-grid">
                <legend>星期</legend>
                <label v-for="option in scheduleWeekdayOptions" :key="option.value"><input type="checkbox" :checked="scheduleDraft.weekdays.includes(option.value)" @change="toggleScheduleWeekday(option.value)"><span>{{ option.label }}</span></label>
              </fieldset>
              <fieldset v-if="scheduleDraft.cadenceType === 'monthly'" class="cadence-days month-day-grid">
                <legend>日期</legend>
                <label v-for="day in monthDayOptions" :key="day"><input type="checkbox" :checked="scheduleDraft.monthDays.includes(day)" @change="toggleScheduleMonthDay(day)"><span>{{ day }}</span></label>
              </fieldset>
            </fieldset>
            <label class="enable-on-create"><input v-model="scheduleDraft.enabled" type="checkbox"><span><strong>创建后立即启用</strong><small>{{ scheduleEnableHint }}</small></span></label>
          </div>
          <button class="button primary" type="button" :disabled="busy || !contribution.granted" @click="createSchedule">{{ busy ? '正在创建' : '创建运行计划' }}</button>
          <small v-if="!contribution.granted" class="schedule-grant-hint">创建前需要先保存包含“按计划运行”的授权。</small>
        </section>
        <footer class="manager-actions"><button class="button" type="button" :disabled="busy" @click="close">完成</button></footer>
      </div>
    </section>
  </div>
</template>

<style scoped>
.plugin-manager-backdrop { z-index: 800; }
.plugin-manager { width: min(760px, 100%); max-height: min(820px, calc(100vh - 48px)); grid-template-rows: auto auto auto minmax(0, 1fr); gap: 0; padding: 0; overflow: hidden; }
.plugin-manager-head { padding: 19px 20px 14px; }
.plugin-manager-head h2 { margin-top: 2px; }
.manager-tabs { display: flex; gap: 4px; padding: 0 20px 10px; border-bottom: 1px solid var(--border); }
.manager-tabs button { display: inline-flex; min-height: 34px; align-items: center; gap: 5px; padding: 6px 10px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 8px; cursor: pointer; font-size: var(--font-body); line-height: var(--line-body); }
.manager-tabs button:hover { color: var(--text); background: var(--surface-hover); }
.manager-tabs button.active { color: var(--brand); background: var(--brand-soft); }
.manager-tabs button span { display: grid; min-width: 18px; height: 18px; place-items: center; background: var(--surface); border-radius: 99px; font-size: 10px; }
.manager-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 20px 0; padding: 8px 10px; color: var(--danger); background: var(--danger-soft); border: 1px solid color-mix(in srgb, var(--danger) 25%, var(--border)); border-radius: 8px; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.manager-error button { padding: 2px 4px; color: inherit; background: transparent; border: 0; cursor: pointer; }
.manager-pane { min-height: 0; padding: 15px 20px 20px; overflow: auto; }
.manager-intro { display: grid; gap: 3px; margin-bottom: 13px; }
.manager-intro strong { font-size: var(--font-body); line-height: var(--line-body); }
.manager-intro p { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.manager-fieldset { display: grid; gap: 6px; margin: 0 0 11px; padding: 11px; border: 1px solid var(--border); border-radius: 10px; }
.manager-fieldset legend { padding: 0 5px; color: var(--text-secondary); font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 600; }
.manager-fieldset > p { padding: 9px; color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); text-align: center; }
.check-row { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 8px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
.check-row:hover { background: var(--surface-subtle); }
.check-row input { width: 16px; min-height: 16px; margin-top: 2px; accent-color: var(--brand); }
.check-row > span { display: grid; min-width: 0; gap: 1px; }
.check-row strong { font-size: var(--font-secondary); line-height: var(--line-secondary); font-weight: 600; }
.check-row small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.inline-options { display: flex; flex-wrap: wrap; gap: 7px; }
.inline-options legend { width: 100%; }
.inline-options label, .array-options label { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 7px; cursor: pointer; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.inline-options input, .array-options input, .boolean-field input, .enable-on-create input, .secret-field label input { min-height: auto; accent-color: var(--brand); }
.scope-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.scope-list { max-height: 210px; overflow: auto; }
.manager-label, .schedule-controls > label { display: grid; gap: 5px; margin-bottom: 11px; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.manager-label small, .schedule-controls small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.authorization-note { padding: 8px 10px; color: var(--warning); background: var(--warning-soft); border-radius: 8px; font-size: var(--font-caption); line-height: var(--line-caption); }
.manager-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--border); }
.config-pane { display: grid; gap: 12px; }
.config-pane .manager-intro { margin-bottom: 0; }
.config-field { display: grid; gap: 5px; }
.config-field > label { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); font-weight: 600; }
.config-field > label em { margin-left: 4px; color: var(--danger); font-size: var(--font-caption); font-style: normal; }
.config-field > p { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.secret-field { display: grid; gap: 6px; }
.secret-field > label { display: inline-flex; align-items: center; gap: 6px; color: var(--danger); font-size: var(--font-caption); line-height: var(--line-caption); }
.boolean-field { display: inline-flex !important; width: max-content; align-items: center; gap: 7px; padding: 7px 9px; background: var(--surface-subtle); border-radius: 8px; }
.array-options { display: flex; flex-wrap: wrap; gap: 6px; }
.schedule-list { display: grid; gap: 8px; }
.schedule-list > article { display: grid; gap: 8px; padding: 12px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 10px; }
.schedule-list > article.suspended { border-color: color-mix(in srgb, var(--warning) 30%, var(--border)); }
.schedule-list article > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.schedule-list article > header div { display: flex; min-width: 0; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.schedule-list article > header strong { min-width: 0; overflow-wrap: anywhere; }
.schedule-list article > header span, .schedule-list article > p, .schedule-list article > footer { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.schedule-list dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 0; }
.schedule-list dl div { display: grid; gap: 2px; padding: 7px 8px; background: var(--surface); border-radius: 7px; }
.schedule-list dt { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.schedule-list dd { margin: 0; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.schedule-warning { padding: 7px 8px; color: var(--warning); background: var(--warning-soft); border-radius: 7px; font-size: var(--font-caption); line-height: var(--line-caption); }
.schedule-list article > footer { display: flex; justify-content: space-between; gap: 10px; }
.schedule-list footer button { padding: 2px 4px; color: var(--danger); background: transparent; border: 0; cursor: pointer; font-size: var(--font-caption); line-height: var(--line-caption); }
.schedule-create { display: grid; gap: 10px; margin-top: 13px; padding-top: 13px; border-top: 1px solid var(--border); }
.schedule-create h3 { font-size: var(--font-body); line-height: var(--line-body); }
.schedule-controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 1fr); align-items: start; gap: 10px; }
.cadence-config { display: grid; min-width: 0; gap: 10px; margin: 0; padding: 11px; border: 1px solid var(--border); border-radius: 8px; }
.cadence-config > legend, .cadence-days > legend { padding: 0 5px; color: var(--text-secondary); font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 600; }
.cadence-segments { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; padding: 3px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 8px; }
.cadence-segments button { min-width: 0; min-height: 32px; padding: 5px 7px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 5px; cursor: pointer; font-size: var(--font-secondary); line-height: var(--line-secondary); }
.cadence-segments button:hover { color: var(--text); background: var(--surface-hover); }
.cadence-segments button.active { color: var(--text); background: var(--surface); box-shadow: var(--shadow-sm); font-weight: 620; }
.cadence-value { display: grid; min-width: 0; gap: 5px; color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.cadence-value small { color: var(--text-tertiary); font-size: var(--font-caption); line-height: var(--line-caption); }
.cadence-days { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; }
.cadence-days label { display: flex; min-width: 0; min-height: 30px; align-items: center; justify-content: center; gap: 4px; padding: 4px 5px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--text-secondary); font-size: var(--font-caption); line-height: var(--line-caption); }
.cadence-days label:hover { background: var(--surface-hover); border-color: var(--border-strong); }
.cadence-days label:has(input:checked) { color: var(--brand); background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 28%, var(--border)); }
.cadence-days input { width: 14px; height: 14px; min-height: 14px; margin: 0; padding: 0; accent-color: var(--brand); }
.weekday-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
.month-day-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); }
.enable-on-create { display: flex !important; min-height: 82px; align-items: center; gap: 10px; padding: 12px 14px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease; }
.enable-on-create:hover { background: var(--surface-hover); border-color: var(--border-strong); }
.enable-on-create:has(input:checked) { background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 28%, var(--border)); }
.enable-on-create:has(input:focus-visible) { border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 15%, transparent); }
.enable-on-create input { width: 18px; height: 18px; min-height: 18px; flex: 0 0 18px; margin: 0; padding: 0; cursor: pointer; }
.enable-on-create > span { display: grid; gap: 1px; }
.enable-on-create strong { color: var(--text); font-size: var(--font-secondary); line-height: var(--line-secondary); }
.schedule-create > .button { justify-self: start; }
.schedule-grant-hint { color: var(--warning); font-size: var(--font-caption); line-height: var(--line-caption); }
@media (max-width: 960px) {
  .scope-columns, .schedule-controls { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .weekday-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .month-day-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
}
</style>
