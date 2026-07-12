<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { PlatformId, SyncMode } from '../../../../shared/contracts'
import AccountDetailPane from './AccountDetailPane.vue'
import AccountListPane from './AccountListPane.vue'
import { useAccounts } from './useAccounts'

const store = useAccounts()
const addDialog = ref(false)
const groupDialog = ref(false)
const toast = ref('')
const addForm = reactive<{ platformId: PlatformId; alias: string; syncMode: SyncMode }>({
  platformId: 'xiaohongshu',
  alias: '',
  syncMode: 'profile_only'
})
const groupForm = reactive({ name: '', color: '#339cff' })

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

async function createAccount(): Promise<void> {
  try {
    await store.createAccount({ ...addForm })
    addDialog.value = false
    addForm.alias = ''
    showToast('账号空间已创建，可以在独立浏览器窗口登录。')
  } catch {
    // Store exposes the sanitized error in the page alert.
  }
}

async function createGroup(): Promise<void> {
  try {
    await store.createGroup({ ...groupForm })
    groupDialog.value = false
    groupForm.name = ''
    showToast('分组已创建。')
  } catch {
    // Store exposes the sanitized error in the page alert.
  }
}

async function removeGroup(id: string, name: string): Promise<void> {
  if (!window.confirm(`删除分组“${name}”？账号和会话不会被删除。`)) return
  try {
    await store.removeGroup(id)
  } catch {
    // Store exposes the sanitized error in the page alert.
  }
}

function showToast(value: string): void {
  toast.value = value
  window.setTimeout(() => {
    if (toast.value === value) toast.value = ''
  }, 2800)
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
        @select="store.selectedId.value = $event"
        @update:selected-group="store.selectedGroup.value = $event"
        @update:search="store.search.value = $event"
        @create-group="groupDialog = true"
        @remove-group="removeGroup($event.id, $event.name)"
      />
      <AccountDetailPane
        :account="store.selectedAccount.value"
        :platform="selectedPlatform"
        :groups="store.groups.value"
        :browser-state="selectedBrowserState"
        :save="store.updateAccount"
        :open-browser="store.openBrowser"
        :disconnect="store.disconnectAccount"
      />
    </section>

    <div v-if="addDialog" class="modal-backdrop" @click.self="addDialog = false">
      <form class="modal" @submit.prevent="createAccount">
        <div class="modal-head">
          <div><span class="page-eyebrow">NEW ACCOUNT SPACE</span><h2>添加本人账号</h2><p>创建独立会话后，在大窗口中手动登录官方页面。</p></div>
          <button type="button" @click="addDialog = false">×</button>
        </div>
        <label>平台<select v-model="addForm.platformId"><option v-for="platform in store.platforms.value" :key="platform.id" :value="platform.id">{{ platform.name }}</option></select></label>
        <label>本地别名<input v-model="addForm.alias" maxlength="40" required placeholder="例如：个人品牌号" /></label>
        <label>首次同步范围<select v-model="addForm.syncMode"><option value="profile_only">仅账号资料（推荐）</option><option value="recent_20">最近 20 条</option><option value="recent_100">最近 100 条</option><option value="disabled">暂不同步</option></select></label>
        <div class="modal-warning"><strong>登录安全说明</strong><span>只打开预置官方 HTTPS 地址；不读取密码，不导入外部浏览器 Cookie。</span></div>
        <div class="modal-actions"><button class="button" type="button" @click="addDialog = false">取消</button><button class="button primary" type="submit">创建账号空间</button></div>
      </form>
    </div>

    <div v-if="groupDialog" class="modal-backdrop" @click.self="groupDialog = false">
      <form class="modal compact" @submit.prevent="createGroup">
        <div class="modal-head"><div><span class="page-eyebrow">LOCAL GROUP</span><h2>新建分组</h2><p>分组信息只保存在本机。</p></div><button type="button" @click="groupDialog = false">×</button></div>
        <label>分组名称<input v-model="groupForm.name" maxlength="30" required /></label>
        <label>标识颜色<input v-model="groupForm.color" type="color" /></label>
        <div class="modal-actions"><button class="button" type="button" @click="groupDialog = false">取消</button><button class="button primary" type="submit">创建</button></div>
      </form>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
