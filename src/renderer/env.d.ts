import type { BrowserWorkspaceApi, SocialVaultApi } from '../shared/contracts'

declare global {
  interface Window {
    socialVault: SocialVaultApi
    browserWorkspace: BrowserWorkspaceApi
  }
}

export {}
