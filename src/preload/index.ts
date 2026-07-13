import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserState, SocialVaultApi } from '../shared/contracts'

const api: SocialVaultApi = {
  platforms: {
    list: () => ipcRenderer.invoke('platforms:list')
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    onChanged: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('accounts:changed', listener)
      return () => ipcRenderer.removeListener('accounts:changed', listener)
    },
    create: (input) => ipcRenderer.invoke('accounts:create', input),
    update: (input) => ipcRenderer.invoke('accounts:update', input),
    bulkUpdate: (input) => ipcRenderer.invoke('accounts:bulk-update', input),
    disconnect: (id) => ipcRenderer.invoke('accounts:disconnect', id),
    purge: (id) => ipcRenderer.invoke('accounts:purge', id),
    verifyIdentity: (id) => ipcRenderer.invoke('accounts:verify-identity', id),
    confirmIdentity: (input) => ipcRenderer.invoke('accounts:confirm-identity', input),
    sync: (id) => ipcRenderer.invoke('accounts:sync', id)
  },
  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    create: (input) => ipcRenderer.invoke('groups:create', input),
    update: (input) => ipcRenderer.invoke('groups:update', input),
    move: (input) => ipcRenderer.invoke('groups:move', input),
    remove: (id) => ipcRenderer.invoke('groups:remove', id)
  },
  browser: {
    open: (accountId) => ipcRenderer.invoke('browser:open', accountId),
    onState: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => callback(state)
      ipcRenderer.on('browser:state', listener)
      return () => ipcRenderer.removeListener('browser:state', listener)
    }
  },
  content: {
    list: (query) => ipcRenderer.invoke('content:list', query),
    detail: (id) => ipcRenderer.invoke('content:detail', id),
    update: (input) => ipcRenderer.invoke('content:update', input),
    clearAccount: (accountId) => ipcRenderer.invoke('content:clear-account', accountId)
  },
  analytics: {
    overview: (query) => ipcRenderer.invoke('analytics:overview', query),
    dashboard: () => ipcRenderer.invoke('analytics:dashboard')
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:set-enabled', id, enabled)
  },
  settings: {
    overview: () => ipcRenderer.invoke('settings:overview'),
    update: (input) => ipcRenderer.invoke('settings:update', input),
    exportData: (input) => ipcRenderer.invoke('settings:export', input),
    createBackup: (input) => ipcRenderer.invoke('settings:backup-create', input),
    restoreBackup: (input) => ipcRenderer.invoke('settings:backup-restore', input)
  }
}

contextBridge.exposeInMainWorld('socialVault', api)
