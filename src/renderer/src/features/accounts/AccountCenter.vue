<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Group, PlatformId, SyncMode } from '../../../../shared/contracts'
import AccountDetailPane from './AccountDetailPane.vue'
import AccountListPane from './AccountListPane.vue'
import { useAccounts } from './useAccounts'

const store = useAccounts()
const addDialog = ref(false)
const groupDialog = ref(false)
const editGroupDialog = ref(false)
const toast = ref('')
const addBusy = ref(false)
const groupBusy = ref(false)
const batchBusy = ref(false)
const selectedAccountIds = ref<string[]>([])
const addForm = reactive<{ platformId: PlatformId; alias: string; syncMode: SyncMode }>({
  platformId: 'xiaohongshu',
  alias: '',
  syncMode: 'profile_only'
})
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
    await store.createAccount({ ...addForm })
    addDialog.value = false
    addForm.alias = ''
    showToast('账号空间已创建，可以在独立浏览器窗口登录。')
  } catch {
    // Store exposes the sanitized error in the page alert.
  } finally {
    addBusy.value = false
  }
}

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
  if (!window.confirm(`删除分组“${name}”？\n\n只会解除账号与该分组的关联；账号、登录会话、备注、内容和历史统计都会保留。`)) return
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
        <span class="page-eyebrow">ACCOUNT WORKSPACE</span>
        <h1>账号中心</h1>
        <p>管理本人账号、独立登录会话和本地备注</p>
      </div>
      <button class="button primary add-account" @click="addDialog = true">＋ 添加账号</button>
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
        :disconnect="store.disconnectAccount"
        :purge="store.purgeAccount"
      />
    </section>

    <div v-if="addDialog" class="modal-backdrop" @click.self="closeAddDialog">
      <form class="modal" @submit.prevent="createAccount">
        <div class="modal-head">
          <div><span class="page-eyebrow">NEW ACCOUNT SPACE</span><h2>添加本人账号</h2><p>创建独立会话后，在大窗口中手动登录官方页面。</p></div>
          <button type="button" :disabled="addBusy" @click="closeAddDialog">×</button>
        </div>
        <label>平台<select v-model="addForm.platformId"><option v-for="platform in store.platforms.value" :key="platform.id" :value="platform.id">{{ platform.name }}</option></select></label>
        <label>本地别名<input v-model="addForm.alias" maxlength="40" required placeholder="例如：个人品牌号" /></label>
        <label>未来平台插件的默认同步范围<select v-model="addForm.syncMode"><option value="profile_only">仅账号资料（推荐）</option><option value="recent_20">最近 20 条</option><option value="recent_100">最近 100 条</option><option value="disabled">不允许平台同步</option></select></label>
        <div class="modal-warning"><strong>登录安全说明</strong><span>只打开预置官方 HTTPS 地址；不读取密码，不导入外部浏览器 Cookie。</span></div>
        <div class="modal-actions"><button class="button" :disabled="addBusy" type="button" @click="closeAddDialog">取消</button><button class="button primary" :disabled="addBusy" type="submit">{{ addBusy ? '创建中…' : '创建账号空间' }}</button></div>
      </form>
    </div>

    <div v-if="groupDialog" class="modal-backdrop" @click.self="closeGroupDialog">
      <form class="modal compact" @submit.prevent="createGroup">
        <div class="modal-head"><div><span class="page-eyebrow">LOCAL GROUP</span><h2>新建分组</h2><p>分组信息只保存在本机。</p></div><button type="button" :disabled="groupBusy" @click="closeGroupDialog">×</button></div>
        <label>分组名称<input v-model="groupForm.name" maxlength="30" required /></label>
        <label>标识颜色<input v-model="groupForm.color" type="color" /></label>
        <div class="modal-actions"><button class="button" :disabled="groupBusy" type="button" @click="closeGroupDialog">取消</button><button class="button primary" :disabled="groupBusy" type="submit">{{ groupBusy ? '创建中…' : '创建' }}</button></div>
      </form>
    </div>

    <div v-if="editGroupDialog" class="modal-backdrop" @click.self="closeEditGroupDialog">
      <form class="modal compact" @submit.prevent="updateGroup">
        <div class="modal-head"><div><span class="page-eyebrow">EDIT LOCAL GROUP</span><h2>编辑分组</h2><p>名称、颜色和排序仅影响本地管理视图。</p></div><button type="button" :disabled="groupBusy" @click="closeEditGroupDialog">×</button></div>
        <label>分组名称<input v-model="editGroupForm.name" maxlength="30" required /></label>
        <label>标识颜色<input v-model="editGroupForm.color" type="color" /></label>
        <div class="modal-actions"><button class="button" :disabled="groupBusy" type="button" @click="closeEditGroupDialog">取消</button><button class="button primary" :disabled="groupBusy" type="submit">{{ groupBusy ? '保存中…' : '保存分组' }}</button></div>
      </form>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
