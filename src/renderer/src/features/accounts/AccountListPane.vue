<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Account, Group, PlatformDefinition } from '../../../../shared/contracts'
import { accountHealthPresentation } from './presentation'

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

function countFor(value: string): number {
  if (value === 'all') return props.allAccounts.length
  if (value === 'ungrouped') return props.allAccounts.filter((item) => item.groupIds.length === 0).length
  if (value === 'problem') return props.allAccounts.filter((item) =>
    ['expired', 'mismatch'].includes(item.connectionStatus) ||
    ['failed', 'cooldown', 'unsupported'].includes(item.syncStatus)
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
      <span>⌕</span>
      <input
        :value="search"
        type="search"
        placeholder="搜索别名、备注或标签"
        @input="emit('update:search', ($event.target as HTMLInputElement).value)"
      />
    </label>

    <div class="group-filter-row">
      <select :value="selectedGroup" @change="emit('update:selectedGroup', ($event.target as HTMLSelectElement).value)">
        <option value="all">全部账号（{{ countFor('all') }}）</option>
        <option value="ungrouped">未分组（{{ countFor('ungrouped') }}）</option>
        <option value="problem">连接/同步异常（{{ countFor('problem') }}）</option>
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
      <div v-if="loading" class="empty-list">正在读取本地数据库…</div>
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
          :aria-label="`选择${account.alias}`"
          @change="emit('toggleAccount', account.id)"
        />
        <button class="account-row-main" @click="emit('select', account.id)">
          <span class="avatar">{{ platformOf(account)?.shortName }}</span>
          <span class="account-copy">
            <strong>{{ account.alias }}</strong>
            <small>{{ platformOf(account)?.name }} · {{ account.remoteName || '待绑定身份' }}</small>
          </span>
          <span class="status-dot" :class="accountHealthPresentation(account).tone" :title="accountHealthPresentation(account).label"></span>
        </button>
      </div>
    </div>
  </aside>
</template>
