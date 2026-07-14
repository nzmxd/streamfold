import type { BrowserWorkspaceApi, SocialVaultApi, SocialVaultBridge } from '../shared/contracts'

declare global {
  interface Window {
    socialVault: SocialVaultApi
    socialVaultBridge: SocialVaultBridge
    browserWorkspace: BrowserWorkspaceApi
  }
}

export {}
