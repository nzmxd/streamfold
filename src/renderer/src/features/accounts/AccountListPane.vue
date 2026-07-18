<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Account, Group, PlatformDefinition } from '../../../../shared/contracts'
import AccountAvatar from './AccountAvatar.vue'
import { accountDisplayName, accountHealthPresentation } from './presentation'

const props = defineProps<{
  accounts: Account[]
  allAccounts: Account[]
  groups: Group[]
  platforms: PlatformDefinition[]
  selectedId: string | null
  selectedGroup: string
  search: string
  loading: boolean
  selectedAccountIds: string[]
  batchBusy: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  'update:selectedGroup': [value: string]
  'update:search': [value: string]
  createGroup: []
  editGroup: [group: Group]
  moveGroup: [value: { group: Group; direction: 'up' | 'down' }]
  removeGroup: [group: Group]
  toggleAccount: [id: string]
  toggleVisible: [ids: string[]]
  clearSelection: []
  bulkGroup: [value: { groupId: string; action: 'add' | 'remove' }]
  bulkSync: [enabled: boolean]
  syncNow: []
  syncGroup: [group: Group]
}>()

const batchGroupId = ref('')
const selectedGroupDefinition = computed(() => props.groups.find((group) => group.id === props.selectedGroup))
const selectedGroupIndex = computed(() => props.groups.findIndex((group) => group.id === props.selectedGroup))
const allVisibleSelected = computed(() => props.accounts.length > 0 &&
  props.accounts.every((account) => props.selectedAccountIds.includes(account.id)))

watch(() => [props.groups, props.selectedGroup] as const, () => {
  if (selectedGroupDefinition.value) batchGroupId.value = selectedGroupDefinition.value.id
  else if (!props.groups.some((group) => group.id === batchGroupId.value)) {
    batchGroupId.value = props.groups[0]?.id ?? ''
  }
}, { immediate: true })

function platformOf(account: Account): PlatformDefinition | undefined {
  return props.platforms.find((platform) => platform.id === account.platformId)
}

function displayNameOf(account: Account): string {
  return accountDisplayName(account, platformOf(account)?.name)
}

function countFor(value: string): number {
  if (value === 'all') return props.allAccounts.length
  if (value === 'ungrouped') return props.allAccounts.filter((item) => item.groupIds.length === 0).length
  if (value === 'problem') return props.allAccounts.filter((item) =>
    ['expired', 'mismatch'].includes(item.connectionStatus) ||
    ['partial', 'failed', 'cooldown', 'unsupported'].includes(item.syncStatus)
  ).length
  if (value === 'paused') return props.allAccounts.filter((item) => !item.syncEnabled).length
  return props.groups.find((group) => group.id === value)?.accountCount ?? 0
}
</script>

<template>
  <aside class="account-explorer">
    <div class="explorer-head">
      <div><strong>账号</strong><span>{{ allAccounts.length }} 个本地账号空间</span></div>
      <button class="icon-button" aria-label="创建分组" @click="emit('createGroup')">＋</button>
    </div>

    <label class="search-box">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="10.5" cy="10.5" r="5.5" />
        <path d="m15 15 4 4" />
      </svg>
      <input
        :value="search"
        type="search"
        aria-label="搜索账号"
        placeholder="搜索名称、账号 ID、备注或标签"
        @input="emit('update:search', ($event.target as HTMLInputElement).value)"
      />
    </label>

    <div class="group-filter-row">
      <select :value="selectedGroup" @change="emit('update:selectedGroup', ($event.target as HTMLSelectElement).value)">
        <option value="all">全部账号（{{ countFor('all') }}）</option>
        <option value="ungrouped">未分组（{{ countFor('ungrouped') }}）</option>
        <option value="problem">连接/同步提示（{{ countFor('problem') }}）</option>
        <option value="paused">同步已暂停（{{ countFor('paused') }}）</option>
        <option v-for="group in groups" :key="group.id" :value="group.id">
          {{ group.name }}（{{ group.accountCount }}）
        </option>
      </select>
    </div>

    <div v-if="selectedGroupDefinition" class="group-actions" aria-label="当前分组操作">
      <span><i :style="{ background: selectedGroupDefinition.color }"></i>{{ selectedGroupDefinition.name }}</span>
      <button :disabled="selectedGroupIndex <= 0 || batchBusy" title="上移" @click="emit('moveGroup', { group: selectedGroupDefinition, direction: 'up' })">↑</button>
      <button :disabled="selectedGroupIndex >= groups.length - 1 || batchBusy" title="下移" @click="emit('moveGroup', { group: selectedGroupDefinition, direction: 'down' })">↓</button>
      <button :disabled="batchBusy" title="编辑名称与颜色" @click="emit('editGroup', selectedGroupDefinition)">✎</button>
      <button class="danger" :disabled="batchBusy" title="删除当前分组" @click="emit('removeGroup', selectedGroupDefinition)">×</button>
    </div>
    <div v-if="selectedGroupDefinition" class="group-sync-strip">
      <span>同步此分组的 {{ selectedGroupDefinition.accountCount }} 个账号</span>
      <button :disabled="batchBusy || selectedGroupDefinition.accountCount === 0" @click="emit('syncGroup', selectedGroupDefinition)">立即同步</button>
    </div>

    <section v-if="selectedAccountIds.length > 0" class="batch-toolbar" aria-label="批量管理账号">
      <div class="batch-summary">
        <strong>已选 {{ selectedAccountIds.length }} 个</strong>
        <button :disabled="batchBusy" @click="emit('clearSelection')">取消选择</button>
      </div>
      <div class="batch-group-controls">
        <select v-model="batchGroupId" :disabled="batchBusy || groups.length === 0" aria-label="目标分组">
          <option value="" disabled>选择目标分组</option>
          <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
        </select>
        <button :disabled="batchBusy || !batchGroupId" @click="emit('bulkGroup', { groupId: batchGroupId, action: 'add' })">加入</button>
        <button :disabled="batchBusy || !batchGroupId" @click="emit('bulkGroup', { groupId: batchGroupId, action: 'remove' })">移出</button>
      </div>
      <div class="batch-sync-controls">
        <button class="sync-now-action" :disabled="batchBusy" @click="emit('syncNow')">立即同步已选账号</button>
        <button :disabled="batchBusy" @click="emit('bulkSync', false)">暂停同步</button>
        <button :disabled="batchBusy" @click="emit('bulkSync', true)">恢复同步</button>
      </div>
    </section>

    <label v-if="accounts.length > 0" class="select-visible-row">
      <input
        type="checkbox"
        :checked="allVisibleSelected"
        :disabled="batchBusy"
        @change="emit('toggleVisible', accounts.map((account) => account.id))"
      />
      <span>{{ allVisibleSelected ? '取消选择当前结果' : '选择当前结果' }}</span>
    </label>

    <div class="account-list" role="listbox" aria-label="账号列表">
      <div v-if="loading" class="empty-list">正在加载账号…</div>
      <div v-else-if="accounts.length === 0" class="empty-list">
        <strong>当前筛选下没有账号</strong>
        <span>可以调整分组或创建新的账号空间。</span>
      </div>
      <div
        v-for="account in accounts"
        :key="account.id"
        class="account-row"
        :class="{ active: selectedId === account.id }"
        role="option"
        :aria-selected="selectedId === account.id"
      >
        <input
          class="account-select"
          type="checkbox"
          :checked="selectedAccountIds.includes(account.id)"
          :disabled="batchBusy"
          :aria-label="`选择${displayNameOf(account)}`"
          @change="emit('toggleAccount', account.id)"
        />
        <button class="account-row-main" @click="emit('select', account.id)">
          <AccountAvatar
            :src="account.avatarUrl"
            :fallback="platformOf(account)?.shortName"
            :label="`${displayNameOf(account)}的头像`"
          />
          <span class="account-copy">
            <strong>{{ displayNameOf(account) }}</strong>
            <small>{{ platformOf(account)?.name }} · {{ account.remoteName || '待绑定身份' }}</small>
            <small v-if="account.remoteId" class="account-remote-id">账号 ID：{{ account.remoteId }}</small>
          </span>
          <span class="status-dot" :class="accountHealthPresentation(account).tone" :title="accountHealthPresentation(account).label"></span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.group-sync-strip { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: -3px 14px 10px; padding: 7px 8px 7px 10px; color: var(--text-secondary); background: color-mix(in srgb, var(--brand-soft) 50%, var(--surface)); border: 1px solid color-mix(in srgb, var(--brand) 18%, var(--border)); border-radius: 8px; }
.group-sync-strip span { overflow: hidden; font-size: var(--font-caption); line-height: var(--line-caption); text-overflow: ellipsis; white-space: nowrap; }
.group-sync-strip button { min-height: 30px; flex: 0 0 auto; padding: 4px 8px; color: var(--brand); background: var(--surface); border: 1px solid color-mix(in srgb, var(--brand) 28%, var(--border)); border-radius: 6px; cursor: pointer; font-size: var(--font-caption); line-height: var(--line-caption); font-weight: 620; }
.group-sync-strip button:hover:not(:disabled) { background: var(--brand-soft); }
.group-sync-strip button:disabled { opacity: .5; cursor: not-allowed; }
.batch-sync-controls { grid-template-columns: 1fr 1fr; }
.batch-sync-controls .sync-now-action { grid-column: 1 / -1; min-height: 34px; color: var(--brand-contrast); background: var(--brand); border-color: var(--brand); font-weight: 620; }
.batch-sync-controls .sync-now-action:hover:not(:disabled) { background: var(--brand-hover); border-color: var(--brand-hover); }
</style>
