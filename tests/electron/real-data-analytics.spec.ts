import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test.skip(
  process.env.SOCIAL_VAULT_REAL_DATA_TEST !== '1',
  '仅在显式要求检查本机真实数据时运行'
)

test('真实用户数据可完成周统计和内容趋势查看', async ({}, testInfo) => {
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
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 820)
    })

    await page.locator('[data-section="analytics"]').click()
    const analysisPage = page.locator('.analysis-page')
    await expect(analysisPage).toBeVisible()
    await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
    const rangeGroup = analysisPage.getByRole('group', { name: '按发帖时间筛选' })
    await expect(rangeGroup.getByRole('button', { name: '本周', exact: true })).toBeVisible()
    await expect(rangeGroup.getByRole('button', { name: '近一周', exact: true })).toBeVisible()
    await expect(rangeGroup.getByRole('button', { name: '本月', exact: true })).toBeVisible()
    await expect(rangeGroup.getByRole('button', { name: '近一月', exact: true })).toBeVisible()

    await analysisPage.locator('.analysis-tabs')
      .getByRole('button', { name: '内容统计', exact: true }).click()
    await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
    const triggers = analysisPage.locator('.content-trend-trigger')
    expect(await triggers.count()).toBeGreaterThan(0)
    const lifecycleGeometry = await analysisPage.locator('.lifecycle-table-wrap').evaluate((table) => {
      const bounds = table.getBoundingClientRect()
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        height: bounds.height,
        clientHeight: table.clientHeight,
        scrollHeight: table.scrollHeight,
        scrollTop: table.scrollTop,
        pageClientHeight: document.documentElement.clientHeight,
        pageScrollTop: table.closest<HTMLElement>('.analysis-page')?.scrollTop ?? 0,
        pageScrollHeight: table.closest<HTMLElement>('.analysis-page')?.scrollHeight ?? 0,
        pageViewportHeight: table.closest<HTMLElement>('.analysis-page')?.clientHeight ?? 0,
        overflowY: getComputedStyle(table).overflowY
      }
    })
    expect(lifecycleGeometry.top).toBeLessThan(560)
    expect(lifecycleGeometry.pageClientHeight - lifecycleGeometry.top).toBeGreaterThan(260)
    expect(lifecycleGeometry.scrollHeight - lifecycleGeometry.clientHeight).toBeLessThanOrEqual(1)
    expect(lifecycleGeometry.pageScrollHeight).toBeGreaterThan(lifecycleGeometry.pageViewportHeight)
    const lifecycleTable = analysisPage.locator('.lifecycle-table-wrap')
    await lifecycleTable.hover()
    const pageScrollBeforeWheel = await analysisPage.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 600)
    await expect.poll(() => analysisPage.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(pageScrollBeforeWheel)
    await analysisPage.evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({
      path: testInfo.outputPath('real-content-milestones.png'),
      animations: 'disabled'
    })

    let selectedSnapshotCount = 0
    const candidates = Math.min(await triggers.count(), 20)
    for (let index = 0; index < candidates; index += 1) {
      await triggers.nth(index).click()
      const dialog = page.locator('.content-trend-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('.content-trend-state')).toHaveCount(0)
      const summary = await dialog.locator('.content-trend-summary').innerText()
      selectedSnapshotCount = Number(summary.match(/(\d+)\s*个指标变化快照/)?.[1] ?? 0)
      if (selectedSnapshotCount > 1) break
      await dialog.getByRole('button', { name: '关闭内容指标趋势' }).click()
      await expect(dialog).toBeHidden()
    }

    expect(selectedSnapshotCount).toBeGreaterThan(1)
    const trendDialog = page.locator('.content-trend-dialog')
    expect(await trendDialog.locator('.content-trend-grid article').count()).toBeGreaterThan(0)
    expect(await trendDialog.locator('.content-trend-dot').count()).toBeGreaterThan(1)
    expect(await trendDialog.locator('.content-trend-meta .semantics').count()).toBeGreaterThan(0)
    await page.screenshot({
      path: testInfo.outputPath('real-content-trend.png'),
      animations: 'disabled'
    })
    await page.keyboard.press('Escape')
    await expect(trendDialog).toBeHidden()

    const statisticsMode = analysisPage.getByRole('group', { name: '内容统计方式' })
    await statisticsMode.getByRole('button', { name: '按周', exact: true }).click()
    await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
    await expect(analysisPage.locator('.weekly-statistics-card tbody tr').first()).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('real-weekly-statistics.png'),
      animations: 'disabled'
    })

    await analysisPage.locator('.analysis-tabs')
      .getByRole('button', { name: '对比', exact: true }).click()
    await analysisPage.getByRole('group', { name: '对比维度' })
      .getByRole('button', { name: '发布周', exact: true }).click()
    await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
    await expect(analysisPage.locator('.comparison-card tbody tr').first()).toBeVisible()
  } finally {
    await application.close().catch(() => undefined)
  }
})
