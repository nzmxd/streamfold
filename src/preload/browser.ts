import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppearanceState,
  BrowserState,
  BrowserWorkspaceApi
} from '../shared/contracts'

const api: BrowserWorkspaceApi = {
  runtime: { platform: process.platform as BrowserWorkspaceApi['runtime']['platform'] },
  appearance: {
    get: () => ipcRenderer.invoke('browser-workspace:get-appearance'),
    set: (preference) => ipcRenderer.invoke('browser-workspace:set-appearance', preference),
    setThemeColor: (themeColor) => ipcRenderer.invoke('browser-workspace:set-theme-color', themeColor),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: AppearanceState): void => callback(state)
      ipcRenderer.on('appearance:changed', listener)
      return () => ipcRenderer.removeListener('appearance:changed', listener)
    }
  },
  getState: () => ipcRenderer.invoke('browser-workspace:get-state'),
  back: () => ipcRenderer.invoke('browser-workspace:back'),
  forward: () => ipcRenderer.invoke('browser-workspace:forward'),
  reload: () => ipcRenderer.invoke('browser-workspace:reload'),
  home: () => ipcRenderer.invoke('browser-workspace:home'),
  close: () => ipcRenderer.invoke('browser-workspace:close'),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => callback(state)
    ipcRenderer.on('browser:state', listener)
    return () => ipcRenderer.removeListener('browser:state', listener)
  }
}

contextBridge.exposeInMainWorld('browserWorkspace', api)
