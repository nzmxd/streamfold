import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test.use({ screenshot: 'off', trace: 'off' })
test.skip(
  process.env.SOCIAL_VAULT_REAL_X_SYNC_TEST !== '1',
  '仅在显式要求使用本机 X 登录会话时运行'
)

test('真实 X 登录会话可完成本人内容同步', async () => {
  test.setTimeout(120_000)
  const application = await electron.launch({
    executablePath: resolve('release/win-unpacked/归页.exe'),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
  try {
    const userData = await application.evaluate(({ app }) => app.getPath('userData'))
    expect(resolve(userData).toLowerCase()).toBe(
      resolve(process.env.APPDATA ?? '', 'social-vault').toLowerCase()
    )
    const page = await application.firstWindow()
    await page.locator('#app').waitFor({ state: 'visible' })
    await page.locator('[data-section="accounts"]').click()
    await expect(page.locator('.account-page')).toBeVisible()

    const xAccount = page.locator('.account-row').filter({
      has: page.locator('.account-copy small').filter({ hasText: /^X · / })
    }).first()
    await expect(xAccount).toBeVisible()
    await xAccount.locator('.account-row-main').click()

    const syncCard = page.locator('.sync-action-card')
    const syncButton = syncCard.getByRole('button', { name: '立即同步', exact: true })
    await expect(syncButton).toBeEnabled()
    const syncStartedAt = Date.now()
    await syncButton.click()
    await expect(syncCard.getByRole('button', { name: '同步中…', exact: true })).toBeVisible()
    await expect(syncButton).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('.account-page > .alert.error')).toHaveCount(0)
    const completed = await page.evaluate(async (startedAt) => {
      const socialVault = (globalThis as unknown as {
        socialVault: {
          logs: {
            list(query: { scope: string; limit: number }): Promise<{
              items: Array<{
                timestamp: string
                level: string
                message: string
                context: Record<string, unknown>
              }>
            }>
          }
        }
      }).socialVault
      const result = await socialVault.logs.list({ scope: 'sync', limit: 50 })
      return result.items.some((entry) => (
        Date.parse(entry.timestamp) >= startedAt &&
        entry.level === 'info' &&
        entry.message === '只读同步完成' &&
        entry.context.pluginId === 'streamfold.x'
      ))
    }, syncStartedAt)
    expect(completed).toBe(true)
  } finally {
    await application.close().catch(() => undefined)
  }
})
