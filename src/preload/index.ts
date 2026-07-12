import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserState, SocialVaultApi } from '../shared/contracts'

const api: SocialVaultApi = {
  platforms: {
    list: () => ipcRenderer.invoke('platforms:list')
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    create: (input) => ipcRenderer.invoke('accounts:create', input),
    update: (input) => ipcRenderer.invoke('accounts:update', input),
    disconnect: (id) => ipcRenderer.invoke('accounts:disconnect', id)
  },
  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    create: (input) => ipcRenderer.invoke('groups:create', input),
    remove: (id) => ipcRenderer.invoke('groups:remove', id)
  },
  browser: {
    open: (accountId) => ipcRenderer.invoke('browser:open', accountId),
    onState: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => callback(state)
      ipcRenderer.on('browser:state', listener)
      return () => ipcRenderer.removeListener('browser:state', listener)
    }
  }
}

contextBridge.exposeInMainWorld('socialVault', api)
