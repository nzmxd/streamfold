import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppearanceState,
  BrowserState,
  SocialVaultApi
} from '../shared/contracts'

const api: SocialVaultApi = {
  runtime: { platform: process.platform as SocialVaultApi['runtime']['platform'] },
  appearance: {
    get: () => ipcRenderer.invoke('appearance:get'),
    set: (preference) => ipcRenderer.invoke('appearance:set', preference),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: AppearanceState): void => callback(state)
      ipcRenderer.on('appearance:changed', listener)
      return () => ipcRenderer.removeListener('appearance:changed', listener)
    }
  },
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
    openOriginal: (id) => ipcRenderer.invoke('content:open-original', id),
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
