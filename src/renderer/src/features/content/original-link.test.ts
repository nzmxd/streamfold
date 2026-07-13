/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const contentCenter = readFileSync(new URL('./ContentCenter.vue', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../../../preload/index.ts', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../../../../main/ipc.ts', import.meta.url), 'utf8')
const browserManager = readFileSync(new URL('../../../../main/browser-manager.ts', import.meta.url), 'utf8')

describe('content original-link workflow', () => {
  it('opens a selected content id through the trusted main-process workflow', () => {
    expect(preload).toContain("openOriginal: (id) => ipcRenderer.invoke('content:open-original', id)")
    expect(ipc).toContain("ipcMain.handle('content:open-original'")
    expect(ipc).toContain('database.getContentDetail(parseId(value))')
    expect(ipc).toContain('isOfficialContentUrl(content.platformId, content.url, content.remoteId)')
    expect(ipc).toContain('browser.openAt(content.accountId, content.url)')
  })

  it('reuses the account browser guard and blocks navigation during API work', () => {
    expect(browserManager).toContain('async openAt(accountId: string, targetUrl: string)')
    expect(browserManager).toContain('managed.apiLeaseCount > 0 || this.activeApiCaptures.has(accountId)')
    expect(browserManager).toContain('await this.safeLoad(managed, targetUrl)')
  })

  it('provides an accessible detail action without using a system-browser link', () => {
    expect(contentCenter).toContain('window.socialVault.content.openOriginal(targetId)')
    expect(contentCenter).toContain('class="button content-original-button"')
    expect(contentCenter).toContain('type="button"')
    expect(contentCenter).toContain(':aria-busy="openingOriginalId === detail.id"')
    expect(contentCenter).toContain('暂无原帖链接')
    expect(contentCenter).not.toContain('target="_blank"')
    expect(contentCenter).not.toContain('window.open(')
  })
})
