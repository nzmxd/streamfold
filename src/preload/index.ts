import { contextBridge, ipcRenderer } from 'electron'
import type { RuntimePlatform } from '../shared/contracts'
import { createSocialVaultBridge } from './social-vault-bridge'

contextBridge.exposeInMainWorld(
  'socialVaultBridge',
  createSocialVaultBridge(ipcRenderer, process.platform as RuntimePlatform)
)
