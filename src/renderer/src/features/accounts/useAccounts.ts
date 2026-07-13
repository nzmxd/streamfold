import { computed, reactive, ref, watch } from 'vue'
import type {
  Account,
  BrowserState,
  BulkUpdateAccountsInput,
  ConfirmApiIdentityInput,
  CreateAccountInput,
  CreateGroupInput,
  Group,
  ApiIdentityCheckResult,
  XiaohongshuSyncResult,
  MoveGroupInput,
  PlatformDefinition,
  UpdateAccountInput,
  UpdateGroupInput
} from '../../../../shared/contracts'
import { messageOf } from '../shared/format'

export function useAccounts() {
  const platforms = ref<PlatformDefinition[]>([])
  const accounts = ref<Account[]>([])
  const groups = ref<Group[]>([])
  const selectedId = ref<string | null>(null)
  const selectedGroup = ref('all')
  const search = ref('')
  const loading = ref(true)
  const error = ref('')
  const browserStates = reactive(new Map<string, BrowserState>())
  let removeBrowserListener: (() => void) | null = null
  let removeAccountsListener: (() => void) | null = null

  const selectedAccount = computed(
    () => accounts.value.find((account) => account.id === selectedId.value) ?? null
  )
  const platformMap = computed(
    () => new Map(platforms.value.map((platform) => [platform.id, platform]))
  )
  const filteredAccounts = computed(() => {
    const keyword = search.value.trim().toLocaleLowerCase()
    return accounts.value.filter((account) => {
      if (selectedGroup.value === 'ungrouped' && account.groupIds.length > 0) return false
      if (
        selectedGroup.value === 'problem' &&
        !['expired', 'mismatch'].includes(account.connectionStatus) &&
        !['failed', 'cooldown', 'unsupported'].includes(account.syncStatus)
      ) return false
      if (selectedGroup.value === 'paused' && account.syncEnabled) return false
      if (
        !['all', 'ungrouped', 'problem', 'paused'].includes(selectedGroup.value) &&
        !account.groupIds.includes(selectedGroup.value)
      ) return false
      if (!keyword) return true
      return [account.alias, account.remoteName, account.remoteId, account.bio, account.note, ...account.tags]
        .join(' ')
        .toLocaleLowerCase()
        .includes(keyword)
    })
  })

  watch(filteredAccounts, (visible) => {
    if (selectedId.value && visible.some((account) => account.id === selectedId.value)) return
    selectedId.value = visible[0]?.id ?? null
  })

  async function initialize(): Promise<void> {
    removeBrowserListener = window.socialVault.browser.onState((state) => {
      if (state.accountId) browserStates.set(state.accountId, state)
    })
    removeAccountsListener = window.socialVault.accounts.onChanged(() => void reload())
    await reload()
  }

  function dispose(): void {
    removeBrowserListener?.()
    removeBrowserListener = null
    removeAccountsListener?.()
    removeAccountsListener = null
  }

  async function reload(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const [platformResult, accountResult, groupResult] = await Promise.all([
        window.socialVault.platforms.list(),
        window.socialVault.accounts.list(),
        window.socialVault.groups.list()
      ])
      platforms.value = platformResult
      accounts.value = accountResult
      groups.value = groupResult
      const visibleAccounts = filteredAccounts.value
      if (!selectedId.value || !visibleAccounts.some((item) => item.id === selectedId.value)) {
        selectedId.value = visibleAccounts[0]?.id ?? null
      }
    } catch (cause) {
      error.value = messageOf(cause)
    } finally {
      loading.value = false
    }
  }

  async function createAccount(input: CreateAccountInput): Promise<Account> {
    return run(async () => {
      const account = await window.socialVault.accounts.create(input)
      selectedGroup.value = 'all'
      search.value = ''
      await reload()
      selectedId.value = account.id
      return account
    })
  }

  async function updateAccount(input: UpdateAccountInput): Promise<Account> {
    return run(async () => {
      const account = await window.socialVault.accounts.update(input)
      await reload()
      return account
    })
  }

  async function bulkUpdateAccounts(input: BulkUpdateAccountsInput): Promise<Account[]> {
    return run(async () => {
      const updated = await window.socialVault.accounts.bulkUpdate(input)
      await reload()
      return updated
    })
  }

  async function disconnectAccount(id: string): Promise<void> {
    await run(async () => {
      await window.socialVault.accounts.disconnect(id)
      browserStates.delete(id)
      await reload()
    })
  }

  async function purgeAccount(id: string): Promise<void> {
    await run(async () => {
      await window.socialVault.accounts.purge(id)
      browserStates.delete(id)
      await reload()
    })
  }

  async function createGroup(input: CreateGroupInput): Promise<Group> {
    return run(async () => {
      const group = await window.socialVault.groups.create(input)
      await reload()
      return group
    })
  }

  async function updateGroup(input: UpdateGroupInput): Promise<Group> {
    return run(async () => {
      const group = await window.socialVault.groups.update(input)
      await reload()
      return group
    })
  }

  async function moveGroup(input: MoveGroupInput): Promise<void> {
    await run(async () => {
      await window.socialVault.groups.move(input)
      await reload()
    })
  }

  async function removeGroup(id: string): Promise<void> {
    await run(async () => {
      await window.socialVault.groups.remove(id)
      if (selectedGroup.value === id) selectedGroup.value = 'all'
      await reload()
    })
  }

  async function openBrowser(id: string): Promise<BrowserState> {
    return run(async () => {
      const state = await window.socialVault.browser.open(id)
      browserStates.set(id, state)
      await reload()
      return state
    })
  }

  async function verifyIdentity(id: string): Promise<ApiIdentityCheckResult> {
    return run(async () => {
      const result = await window.socialVault.accounts.verifyIdentity(id)
      await reload()
      return result
    })
  }

  async function confirmIdentity(input: ConfirmApiIdentityInput): Promise<ApiIdentityCheckResult> {
    return run(async () => {
      const result = await window.socialVault.accounts.confirmIdentity(input)
      await reload()
      return result
    })
  }

  async function syncAccount(id: string): Promise<XiaohongshuSyncResult> {
    return run(async () => {
      const result = await window.socialVault.accounts.sync(id)
      await reload()
      return result
    })
  }

  async function run<T>(action: () => Promise<T>): Promise<T> {
    error.value = ''
    try {
      return await action()
    } catch (cause) {
      error.value = messageOf(cause)
      throw cause
    }
  }

  return {
    platforms,
    accounts,
    groups,
    selectedId,
    selectedGroup,
    selectedAccount,
    search,
    loading,
    error,
    browserStates,
    platformMap,
    filteredAccounts,
    initialize,
    dispose,
    reload,
    createAccount,
    updateAccount,
    bulkUpdateAccounts,
    disconnectAccount,
    purgeAccount,
    createGroup,
    updateGroup,
    moveGroup,
    removeGroup,
    openBrowser,
    verifyIdentity,
    confirmIdentity,
    syncAccount
  }
}
