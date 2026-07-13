import { describe, expect, it } from 'vitest'
import { confirmDialog, dialogState, settleDialog } from './dialog'

describe('application dialog queue', () => {
  it('normalizes options and resolves the selected result', async () => {
    const result = confirmDialog({
      title: '删除账号？',
      description: '此操作无法撤销。',
      tone: 'danger'
    })

    expect(dialogState.value).toMatchObject({
      title: '删除账号？',
      confirmLabel: '确认',
      cancelLabel: '取消',
      tone: 'danger'
    })

    settleDialog(true)
    await expect(result).resolves.toBe(true)
    expect(dialogState.value).toBeNull()
  })

  it('shows queued confirmations in request order', async () => {
    const first = confirmDialog({ title: '第一项', description: '一' })
    const second = confirmDialog({ title: '第二项', description: '二' })

    expect(dialogState.value?.title).toBe('第一项')
    settleDialog(false)
    expect(dialogState.value?.title).toBe('第二项')
    settleDialog(true)

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })
})
