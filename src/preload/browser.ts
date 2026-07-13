import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserState, BrowserWorkspaceApi } from '../shared/contracts'

const api: BrowserWorkspaceApi = {
  getState: () => ipcRenderer.invoke('browser-workspace:get-state'),
  back: () => ipcRenderer.invoke('browser-workspace:back'),
  forward: () => ipcRenderer.invoke('browser-workspace:forward'),
  reload: () => ipcRenderer.invoke('browser-workspace:reload'),
  home: () => ipcRenderer.invoke('browser-workspace:home'),
  close: () => ipcRenderer.invoke('browser-workspace:close'),
  verifyIdentity: () => ipcRenderer.invoke('browser-workspace:verify-identity'),
  confirmIdentity: (input) => ipcRenderer.invoke('browser-workspace:confirm-identity', input),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => callback(state)
    ipcRenderer.on('browser:state', listener)
    return () => ipcRenderer.removeListener('browser:state', listener)
  }
}

contextBridge.exposeInMainWorld('browserWorkspace', api)
