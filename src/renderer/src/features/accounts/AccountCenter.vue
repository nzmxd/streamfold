<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Group, PlatformId, PluginContributionState, SyncMode } from '../../../../shared/contracts'
import AccountDetailPane from './AccountDetailPane.vue'
import AccountListPane from './AccountListPane.vue'
import { useAccounts } from './useAccounts'
import { confirmDialog } from '../../ui/dialog'

const store = useAccounts()
const addDialog = ref(false)
const groupDialog = ref(false)
const editGroupDialog = ref(false)
const toast = ref('')
const addBusy = ref(false)
const groupBusy = ref(false)
const batchBusy = ref(false)
const selectedAccountIds = ref<string[]>([])
const addForm = reactive<{ platformId: PlatformId; adapterContributionId: string; alias: string; syncMode: SyncMode }>({
  platformId: 'xiaohongshu',
  adapterContributionId: '',
  alias: '',
  syncMode: 'profile_only'
})
const platformAdapters = ref<PluginContributionState[]>([])
const addAdapterOptions = computed(() => platformAdapters.value.filter((item) => (
  item.contribution.kind === 'platform.adapter' && item.contribution.platform.id === addForm.platformId
)))
const groupForm = reactive({ name: '', color: '#339cff' })
const editGroupForm = reactive({ id: '', name: '', color: '#339cff' })

const selectedPlatform = computed(() => {
  const account = store.selectedAccount.value
  return account ? store.platformMap.value.get(account.platformId) : undefined
})
const selectedBrowserState = computed(() => {
  const id = store.selectedId.value
  return id ? store.browserStates.get(id) : undefined
})

onMounted(() => store.initialize())
onBeforeUnmount(() => store.dispose())
watch(store.selectedId, () => {
  toast.value = ''
})
watch(store.accounts, (accounts) => {
  const existingIds = new Set(accounts.map((account) => account.id))
  selectedAccountIds.value = selectedAccountIds.value.filter((id) => existingIds.has(id))
})

async function createAccount(): Promise<void> {
  if (addBusy.value) return
  addBusy.value = true
  try {
    await store.createAccount({
      platformId: addForm.platformId,
      syncMode: addForm.syncMode,
      alias: addForm.alias,
      ...(addForm.adapterContributionId ? { adapterContributionId: addForm.adapterContributionId } : {})
    })
    addDialog.value = false
    addForm.alias = ''
    showToast('账号已创建，可以打开浏览器登录。')
  } catch {
    // Store exposes the sanitized error in the page alert.
  } finally {
    addBusy.value = false
  }
}

async function openAddDialog(): Promise<void> {
  platformAdapters.value = await window.socialVault.plugins.listContributions().catch(() => [])
  const options = platformAdapters.value.filter((item) => item.contribution.kind === 'platform.adapter' &&
    item.contribution.platform.id === addForm.platformId)
  addForm.adapterContributionId = options.length === 1 ? options[0]!.contribution.id : ''
  addDialog.value = true
}

watch(() => addForm.platformId, () => {
  addForm.adapterContributionId = addAdapterOptions.value.length === 1
    ? addAdapterOptions.value[0]!.contribution.id
    : ''
})

async function createGroup(): Promise<void> {
  if (groupBusy.value) return
  groupBusy.value = true
  try {
    await store.createGroup({ ...groupForm })
    groupDialog.value = false
    groupForm.name = ''
    showToast('分组已创建。')
  } catch {
    // Store exposes the sanitized error in the page alert.
  } finally {
    groupBusy.value = false
  }
}

async function removeGroup(id: string, name: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: `删除分组“${name}”？`,
    description: '账号会从这个分组中移出，其他资料不会变化。',
    details: ['账号与登录状态会保留', '备注、内容和历史统计会保留'],
    confirmLabel: '删除分组',
    tone: 'warning'
  })
  if (!confirmed) return
  try {
    await store.removeGroup(id)
    showToast('分组已删除，账号与历史数据均已保留。')
  } catch {
    // Store exposes the sanitized error in the page alert.
  }
}

function openEditGroup(group: Group): void {
  editGroupForm.id = group.id
  editGroupForm.name = group.name
  editGroupForm.color = group.color
  editGroupDialog.value = true
}

async function updateGroup(): Promise<void> {
  if (groupBusy.value) return
  groupBusy.value = true
  try {
    await store.updateGroup({ ...editGroupForm })
    editGroupDialog.value = false
    showToast('分组名称和颜色已更新。')
  } catch {
    // Store exposes the sanitized error in the page alert.
  } finally {
    groupBusy.value = false
  }
}

async function moveGroup(value: { group: Group; direction: 'up' | 'down' }): Promise<void> {
  if (batchBusy.value) return
  batchBusy.value = true
  try {
    await store.moveGroup({ id: value.group.id, direction: value.direction })
  } catch {
    // Store exposes the sanitized error in the page alert.
  } finally {
    batchBusy.value = false
  }
}

function toggleAccountSelection(id: string): void {
  selectedAccountIds.value = selectedAccountIds.value.includes(id)
    ? selectedAccountIds.value.filter((selectedId) => selectedId !== id)
    : [...selectedAccountIds.value, id]
}

function toggleVisibleSelection(ids: string[]): void {
  const selected = new Set(selectedAccountIds.value)
  if (ids.every((id) => selected.has(id))) ids.forEach((id) => selected.delete(id))
  else ids.forEach((id) => selected.add(id))
  selectedAccountIds.value = [...selected]
}

async function bulkGroup(value: { groupId: string; action: 'add' | 'remove' }): Promise<void> {
  if (batchBusy.value || selectedAccountIds.value.length === 0) return
  batchBusy.value = true
  try {
    const count = selectedAccountIds.value.length
    await store.bulkUpdateAccounts({
      accountIds: selectedAccountIds.value,
      groupChange: value
    })
    showToast(`已将 ${count} 个账号${value.action === 'add' ? '加入' : '移出'}分组。`)
  } catch {
    // Store exposes the sanitized error in the page alert.
  } finally {
    batchBusy.value = false
  }
}

async function bulkSync(enabled: boolean): Promise<void> {
  if (batchBusy.value || selectedAccountIds.value.length === 0) return
  batchBusy.value = true
  try {
    const selected = store.accounts.value.filter((account) => selectedAccountIds.value.includes(account.id))
    await store.bulkUpdateAccounts({ accountIds: selectedAccountIds.value, syncEnabled: enabled })
    const ineligible = enabled
      ? selected.filter((account) => account.connectionStatus !== 'ready' || account.syncMode === 'disabled').length
      : 0
    showToast(enabled && ineligible > 0
      ? `已恢复符合条件的账号；${ineligible} 个未通过身份核验或禁用的账号仍保持暂停。`
      : `已${enabled ? '恢复' : '暂停'} ${selected.length} 个账号的同步。`)
  } catch {
    // Store exposes the sanitized error in the page alert.
  } finally {
    batchBusy.value = false
  }
}

function showToast(value: string): void {
  toast.value = value
  window.setTimeout(() => {
    if (toast.value === value) toast.value = ''
  }, 2800)
}

function closeAddDialog(): void {
  if (!addBusy.value) addDialog.value = false
}

function closeGroupDialog(): void {
  if (!groupBusy.value) groupDialog.value = false
}

function closeEditGroupDialog(): void {
  if (!groupBusy.value) editGroupDialog.value = false
}
</script>

<template>
  <div class="account-page">
    <header class="page-header">
      <div>
        <span class="page-eyebrow">账号工作区</span>
        <h1>账号中心</h1>
        <p>管理账号、分组、备注和数据同步</p>
      </div>
      <button class="button primary add-account" @click="openAddDialog">＋ 添加账号</button>
    </header>

    <div v-if="store.error.value" class="alert error">
      <span>{{ store.error.value }}</span>
      <button @click="store.error.value = ''">关闭</button>
    </div>

    <section class="account-workspace">
      <AccountListPane
        :accounts="store.filteredAccounts.value"
        :all-accounts="store.accounts.value"
        :groups="store.groups.value"
        :platforms="store.platforms.value"
        :selected-id="store.selectedId.value"
        :selected-group="store.selectedGroup.value"
        :search="store.search.value"
        :loading="store.loading.value"
        :selected-account-ids="selectedAccountIds"
        :batch-busy="batchBusy"
        @select="store.selectedId.value = $event"
        @update:selected-group="store.selectedGroup.value = $event"
        @update:search="store.search.value = $event"
        @create-group="groupDialog = true"
        @edit-group="openEditGroup"
        @move-group="moveGroup"
        @remove-group="removeGroup($event.id, $event.name)"
        @toggle-account="toggleAccountSelection"
        @toggle-visible="toggleVisibleSelection"
        @clear-selection="selectedAccountIds = []"
        @bulk-group="bulkGroup"
        @bulk-sync="bulkSync"
      />
      <AccountDetailPane
        :account="store.selectedAccount.value"
        :platform="selectedPlatform"
        :groups="store.groups.value"
        :browser-state="selectedBrowserState"
        :save="store.updateAccount"
        :open-browser="store.openBrowser"
        :verify-identity="store.verifyIdentity"
        :confirm-identity="store.confirmIdentity"
        :sync-account="store.syncAccount"
        :disconnect="store.disconnectAccount"
        :purge="store.purgeAccount"
      />
    </section>

    <div v-if="addDialog" class="modal-backdrop" @click.self="closeAddDialog">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title" @keydown.esc="closeAddDialog" @submit.prevent="createAccount">
        <div class="modal-head">
          <div><span class="page-eyebrow">新账号</span><h2 id="add-account-title">添加账号</h2><p>创建后打开账号浏览器完成登录。</p></div>
          <button type="button" aria-label="关闭添加账号窗口" :disabled="addBusy" @click="closeAddDialog">×</button>
        </div>
        <label>平台<select v-model="addForm.platformId"><option v-for="platform in store.platforms.value" :key="platform.id" :value="platform.id">{{ platform.name }}</option></select></label>
        <label v-if="addAdapterOptions.length > 1">数据适配器<select v-model="addForm.adapterContributionId" required><option value="" disabled>请选择适配器</option><option v-for="adapter in addAdapterOptions" :key="adapter.contribution.id" :value="adapter.contribution.id" :disabled="!adapter.enabled || !adapter.granted">{{ adapter.contribution.name }}{{ adapter.enabled && adapter.granted ? '' : '（需先启用并授权）' }}</option></select></label>
        <label>本地备注名（可选）<input v-model="addForm.alias" maxlength="40" placeholder="留空后，绑定成功时将使用平台昵称" /></label>
        <label>默认同步范围<select v-model="addForm.syncMode"><option value="profile_only">仅账号资料与指标（推荐）</option><option value="recent_20">最近 20 条作品</option><option value="recent_100">最近 100 条作品</option><option value="disabled">不启用同步</option></select></label>
        <div class="modal-actions"><button class="button" :disabled="addBusy" type="button" @click="closeAddDialog">取消</button><button class="button primary" :disabled="addBusy" type="submit">{{ addBusy ? '创建中…' : '创建账号' }}</button></div>
      </form>
    </div>

    <div v-if="groupDialog" class="modal-backdrop" @click.self="closeGroupDialog">
      <form class="modal compact" role="dialog" aria-modal="true" aria-labelledby="create-group-title" @keydown.esc="closeGroupDialog" @submit.prevent="createGroup">
        <div class="modal-head"><div><span class="page-eyebrow">新分组</span><h2 id="create-group-title">新建分组</h2><p>用分组整理不同用途的账号。</p></div><button type="button" aria-label="关闭新建分组窗口" :disabled="groupBusy" @click="closeGroupDialog">×</button></div>
        <label>分组名称<input v-model="groupForm.name" autofocus maxlength="30" required /></label>
        <label>标识颜色<input v-model="groupForm.color" type="color" /></label>
        <div class="modal-actions"><button class="button" :disabled="groupBusy" type="button" @click="closeGroupDialog">取消</button><button class="button primary" :disabled="groupBusy" type="submit">{{ groupBusy ? '创建中…' : '创建' }}</button></div>
      </form>
    </div>

    <div v-if="editGroupDialog" class="modal-backdrop" @click.self="closeEditGroupDialog">
      <form class="modal compact" role="dialog" aria-modal="true" aria-labelledby="edit-group-title" @keydown.esc="closeEditGroupDialog" @submit.prevent="updateGroup">
        <div class="modal-head"><div><span class="page-eyebrow">分组设置</span><h2 id="edit-group-title">编辑分组</h2><p>修改分组名称和标识颜色。</p></div><button type="button" aria-label="关闭编辑分组窗口" :disabled="groupBusy" @click="closeEditGroupDialog">×</button></div>
        <label>分组名称<input v-model="editGroupForm.name" autofocus maxlength="30" required /></label>
        <label>标识颜色<input v-model="editGroupForm.color" type="color" /></label>
        <div class="modal-actions"><button class="button" :disabled="groupBusy" type="button" @click="closeEditGroupDialog">取消</button><button class="button primary" :disabled="groupBusy" type="submit">{{ groupBusy ? '保存中…' : '保存分组' }}</button></div>
      </form>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
