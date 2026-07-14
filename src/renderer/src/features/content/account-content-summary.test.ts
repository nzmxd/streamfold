/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const widget = readFileSync(new URL('./AccountContentWidget.vue', import.meta.url), 'utf8')
const contentCenter = readFileSync(new URL('./ContentCenter.vue', import.meta.url), 'utf8')
const contracts = readFileSync(new URL('../../../../shared/contracts.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../../../preload/index.ts', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../../../../main/ipc.ts', import.meta.url), 'utf8')

describe('content excerpt visibility and refresh', () => {
  it('renders excerpt text and an explicit official-empty state in the account content tab', () => {
    expect(widget).toContain('{{ item.bodyExcerpt }}')
    expect(widget).toContain('平台未提供正文摘要')
    expect(widget).toContain('{{ excerptCount }}/{{ items.length }} 条包含摘要')
  })

  it('invalidates mounted content views after main-process content changes', () => {
    expect(contracts).toContain('onChanged(callback: () => void): () => void')
    expect(preload).toContain("ipcRenderer.on('content:changed', listener)")
    expect(ipc).toContain("window.webContents.send('content:changed')")
    expect(widget).toContain('window.socialVault.content.onChanged')
    expect(contentCenter).toContain('window.socialVault.content.onChanged')
  })
})
