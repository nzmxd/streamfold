import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { SocialDatabase } from '../../src/main/database'
import {
  XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
  xiaohongshuPluginManifestV2
} from '../../src/main/plugins/builtin-manifests'
import type { StandardDataset } from '../../src/main/plugins/types'

const electronExecutable = createRequire(import.meta.url)('electron') as string

test.describe.configure({ mode: 'serial' })

let application: ElectronApplication
let page: Page
let reviewUserData: string | null = null
let analyticsSeeded = false

test.beforeAll(async () => {
  application = await electron.launch({
    executablePath: electronExecutable,
    args: [resolve('out/main/index.js')],
    env: {
      ...process.env,
      SOCIAL_VAULT_REVIEW: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
  reviewUserData = await application.evaluate(({ app }) => app.getPath('userData'))
  const temporaryRelativePath = relative(tmpdir(), reviewUserData)
  expect(temporaryRelativePath).toMatch(/^social-vault-review-\d+$/)

  page = await application.firstWindow()
  await page.locator('#app').waitFor({ state: 'visible' })
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(920, 640)
  })
  await page.waitForTimeout(100)
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(viewport.width).toBeLessThan(1_000)
  expect(viewport.height).toBeLessThan(700)
})

test.afterAll(async () => {
  await application?.close().catch(() => undefined)
  if (reviewUserData) await rm(reviewUserData, { recursive: true, force: true })
})

async function openSection(
  section: 'accounts' | 'content' | 'analytics' | 'tasks' | 'settings' | 'plugins' | 'logs'
): Promise<void> {
  const navigation = page.locator(`[data-section="${section}"]`)
  await navigation.click()
  await expect(navigation).toHaveAttribute('aria-current', 'page')
}

async function waitForPluginCenter(): Promise<void> {
  await openSection('plugins')
  await expect(page.locator('.plugin-center-v2')).toBeVisible()
  await expect(page.locator('.plugin-loading')).toHaveCount(0, { timeout: 10_000 })
}

function contributionCard(name: string) {
  return page.locator('.contribution-card').filter({
    has: page.getByRole('heading', { name, exact: true })
  }).first()
}

async function seedAnalyticsData(): Promise<void> {
  if (analyticsSeeded) return
  if (!reviewUserData) throw new Error('Electron review userData is unavailable')
  const now = new Date()
  const currentWeekStart = new Date(now)
  currentWeekStart.setHours(0, 0, 0, 0)
  currentWeekStart.setDate(currentWeekStart.getDate() - ((currentWeekStart.getDay() + 6) % 7))
  const currentPublishedAt = new Date(
    currentWeekStart.getTime() + Math.max(1_000, (now.getTime() - currentWeekStart.getTime()) / 2)
  )
  const previousPublishedAt = new Date(currentWeekStart)
  previousPublishedAt.setDate(previousPublishedAt.getDate() - 2)
  const captureSpan = Math.max(3_000, now.getTime() - currentPublishedAt.getTime())
  const capturedAt = [1, 2, 3].map((step) => new Date(
    currentPublishedAt.getTime() + (captureSpan * step) / 3
  ).toISOString())
  const database = new SocialDatabase(join(reviewUserData, 'social-vault.sqlite'))
  try {
    const account = database.createAccount({
      platformId: 'xiaohongshu',
      alias: '分析实测账号',
      syncMode: 'recent_20'
    })
    database.applyManagedIdentity(account.id, {
      remoteId: 'analytics-review-owner',
      remoteName: '分析实测账号'
    }, capturedAt[0]!)
    database.updateAccount({ id: account.id, syncEnabled: true })
    database.upsertPluginPackage(xiaohongshuPluginManifestV2, {
      source: 'builtin',
      status: 'active',
      enabled: true,
      packageHash: `builtin:${xiaohongshuPluginManifestV2.id}@${xiaohongshuPluginManifestV2.version}`,
      publisherKeyId: xiaohongshuPluginManifestV2.publisher.keyId
    })
    database.setPluginContributionEnabled(
      xiaohongshuPluginManifestV2.id,
      XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
      true
    )
    capturedAt.forEach((captureTime, index) => {
      const payload = analyticsDataset(
        captureTime,
        currentPublishedAt.toISOString(),
        previousPublishedAt.toISOString(),
        index
      )
      database.markManagedSyncStarted(
        account.id,
        new Date(Date.parse(captureTime) - 1_000).toISOString()
      )
      const job = database.createJob({
        kind: 'managed_sync',
        accountId: account.id,
        pluginId: xiaohongshuPluginManifestV2.id,
        contributionId: XIAOHONGSHU_PLATFORM_CONTRIBUTION_ID,
        status: 'committing',
        progress: 80,
        stage: '写入 Electron 分析实测数据'
      })
      database.commitManagedSync(payload, {
        accountId: account.id,
        pluginId: xiaohongshuPluginManifestV2.id,
        jobId: job.id,
        authorizedMode: 'recent_20',
        payloadMode: 'recent_20',
        finishedAt: new Date(Date.parse(captureTime) + 1_000).toISOString()
      })
    })
    analyticsSeeded = true
  } finally {
    database.close()
  }
  await page.reload()
  await page.locator('#app').waitFor({ state: 'visible' })
}

function analyticsDataset(
  capturedAt: string,
  currentPublishedAt: string,
  previousPublishedAt: string,
  index: number
): StandardDataset {
  const snapshot = (base: number) => ({
    views: base + index * 40,
    likes: Math.floor(base / 10) + index * 4,
    comments: Math.floor(base / 25) + index * 2,
    shares: Math.floor(base / 50) + index,
    favorites: Math.floor(base / 20) + index * 3,
    metrics: {},
    capturedAt
  })
  return {
    capturedAt,
    profile: {
      remoteId: 'analytics-review-owner',
      remoteName: '分析实测账号',
      followers: null,
      following: 100,
      contentCount: null,
      viewsTotal: null
    },
    contents: [
      {
        remoteId: 'analytics-current',
        type: 'article',
        title: '内容 analytics-current',
        bodyExcerpt: '用于验证真实内容指标变化趋势',
        url: 'https://example.test/analytics-current',
        publishedAt: currentPublishedAt,
        snapshots: [snapshot(200)]
      },
      {
        remoteId: 'analytics-previous',
        type: 'article',
        title: '内容 analytics-previous',
        bodyExcerpt: '用于验证按发布周汇总',
        url: 'https://example.test/analytics-previous',
        publishedAt: previousPublishedAt,
        snapshots: [snapshot(100)]
      }
    ],
    warnings: []
  }
}

test('设置页在最小高度下不会裁切或重叠软件更新卡片', async () => {
  await openSection('settings')
  await expect(page.locator('.settings-page .feature-loading')).toHaveCount(0)
  const updateCard = page.locator('.settings-page .update-card')
  await expect(updateCard).toBeVisible()

  const layout = await page.locator('.settings-page').evaluate((settingsPage) => {
    const update = settingsPage.querySelector<HTMLElement>('.update-card')
    const following = settingsPage.querySelector<HTMLElement>('.settings-columns')
    if (!update || !following) return null
    const updateBounds = update.getBoundingClientRect()
    const followingBounds = following.getBoundingClientRect()
    return {
      updateHeight: updateBounds.height,
      contentFits: update.scrollHeight <= update.clientHeight + 1,
      gap: followingBounds.top - updateBounds.bottom,
      pageScrollable: settingsPage.scrollHeight > settingsPage.clientHeight
    }
  })

  expect(layout).not.toBeNull()
  expect(layout?.updateHeight).toBeGreaterThan(180)
  expect(layout?.contentFits).toBe(true)
  expect(layout?.gap).toBeGreaterThanOrEqual(-1)
  expect(layout?.pageScrollable).toBe(true)
})

test('任务中心在最小窗口下完整展示摘要与筛选', async () => {
  await openSection('settings')
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('navigation:requested', 'tasks')
  })
  await expect(page.locator('[data-section="tasks"]')).toHaveAttribute('aria-current', 'page')
  const taskPage = page.locator('.task-page')
  await expect(taskPage).toBeVisible()
  await expect(taskPage.locator('.task-summary-grid article')).toHaveCount(4)
  await expect(taskPage.locator('.task-filter-card')).toBeVisible()
  await expect(taskPage.getByText('没有符合条件的任务')).toBeVisible()

  const layout = await taskPage.evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    pageScrollable: element.scrollHeight >= element.clientHeight
  }))
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(layout.pageScrollable).toBe(true)
})

test('内容中心在最小窗口下提供分页筛选且没有横向溢出', async () => {
  await openSection('content')
  const contentPage = page.locator('.content-page')
  await expect(contentPage).toBeVisible()
  await expect(contentPage.locator('.feature-loading')).toHaveCount(0)
  await expect(contentPage.getByPlaceholder('搜索标题、摘要、标签或备注')).toBeVisible()
  await expect(contentPage.getByText('没有匹配的内容')).toBeVisible()
  await contentPage.getByRole('button', { name: '更多筛选' }).click()
  await expect(contentPage.locator('.content-filter-advanced')).toBeVisible()
  await expect(contentPage.getByText('第 1 / 1 页')).toBeVisible()

  const layout = await contentPage.evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    pageScrollable: element.scrollHeight >= element.clientHeight,
    workspaceWidth: element.querySelector<HTMLElement>('.content-workspace')?.getBoundingClientRect().width ?? 0
  }))
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(layout.pageScrollable).toBe(true)
  expect(layout.workspaceWidth).toBeGreaterThan(500)
})

test('紧凑桌面布局在 900px 与 1280px 窗口保留主要内容空间', async () => {
  for (const [width, height] of [[900, 800], [1280, 820]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    }, { width, height })
    await page.waitForTimeout(100)

    await openSection('content')
    await expect(page.locator('.content-page .feature-loading')).toHaveCount(0)
    const contentLayout = await page.locator('.content-page').evaluate((element) => {
      const filter = element.querySelector<HTMLElement>('.content-filter-bar')
      const workspace = element.querySelector<HTMLElement>('.content-workspace')
      return {
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        filterHeight: filter?.getBoundingClientRect().height ?? 0,
        workspaceHeight: workspace?.getBoundingClientRect().height ?? 0
      }
    })
    expect(contentLayout.horizontalOverflow).toBeLessThanOrEqual(1)
    expect(contentLayout.filterHeight).toBeLessThan(130)
    expect(contentLayout.workspaceHeight).toBeGreaterThan(360)

    await openSection('accounts')
    const accountLayout = await page.locator('.account-workspace').evaluate((element) => {
      const explorer = element.querySelector<HTMLElement>('.account-explorer')
      const detail = element.querySelector<HTMLElement>('.account-detail')
      return {
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        explorerWidth: explorer?.getBoundingClientRect().width ?? 0,
        detailWidth: detail?.getBoundingClientRect().width ?? 0
      }
    })
    expect(accountLayout.horizontalOverflow).toBeLessThanOrEqual(1)
    expect(accountLayout.explorerWidth).toBeLessThan(290)
    expect(accountLayout.detailWidth).toBeGreaterThan(400)
  }

  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(920, 640)
  })
})

test('可靠分析四个视图在最小窗口下可切换且明确显示缺失数据', async () => {
  await seedAnalyticsData()
  await openSection('analytics')
  const analysisPage = page.locator('.analysis-page')
  await expect(analysisPage).toBeVisible()
  await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
  const tabs = analysisPage.locator('.analysis-tabs')
  for (const label of ['概览', '对比', '内容统计', '数据质量']) {
    await expect(tabs.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  await expect(analysisPage.locator('.summary-grid .metric-card')).toHaveCount(7)
  await expect(analysisPage.getByText('无可靠当前值').first()).toBeVisible()
  await tabs.getByRole('button', { name: '数据质量', exact: true }).click()
  await expect(analysisPage.getByRole('heading', { name: '账号覆盖' })).toBeVisible()

  const layout = await analysisPage.evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    pageScrollable: element.scrollHeight >= element.clientHeight
  }))
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(layout.pageScrollable).toBe(true)
})

test('分析支持发帖快捷范围、发布周对比、周统计和内容趋势窗口', async ({}, testInfo) => {
  await seedAnalyticsData()
  await openSection('analytics')
  const analysisPage = page.locator('.analysis-page')
  await analysisPage.locator('.analysis-tabs').getByRole('button', { name: '概览', exact: true }).click()
  await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
  const rangeGroup = analysisPage.getByRole('group', { name: '按发帖时间筛选' })
  for (const label of ['全部', '本周', '近一周', '本月', '近一月', '近三月', '今年']) {
    await expect(rangeGroup.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  await rangeGroup.getByRole('button', { name: '本周', exact: true }).click()
  await expect(rangeGroup.getByRole('button', { name: '本周', exact: true }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
  await expect(analysisPage.locator('.summary-grid .metric-card')).toHaveCount(5)
  await rangeGroup.getByRole('button', { name: '全部', exact: true }).click()
  await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
  await expect(analysisPage.locator('.summary-grid .metric-card')).toHaveCount(7)

  await analysisPage.locator('.analysis-tabs').getByRole('button', { name: '对比', exact: true }).click()
  await analysisPage.getByRole('group', { name: '对比维度' })
    .getByRole('button', { name: '发布周', exact: true }).click()
  await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
  await expect(analysisPage.locator('.comparison-card tbody tr')).toHaveCount(2)
  await expect(analysisPage.getByText('周一为每周第一天')).toBeVisible()

  await analysisPage.locator('.analysis-tabs')
    .getByRole('button', { name: '内容统计', exact: true }).click()
  const statisticsMode = analysisPage.getByRole('group', { name: '内容统计方式' })
  await statisticsMode.getByRole('button', { name: '按周', exact: true }).click()
  await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
  await expect(analysisPage.getByRole('heading', { name: '每周内容表现' })).toBeVisible()
  await expect(analysisPage.locator('.weekly-statistics-card tbody tr')).toHaveCount(2)
  const weeklyLayout = await analysisPage.locator('.weekly-statistics-card').evaluate((card) => {
    const table = card.querySelector<HTMLElement>('.analysis-table-wrap')
    const firstRow = card.querySelector<HTMLElement>('tbody tr')
    return {
      cardHeight: card.getBoundingClientRect().height,
      tableHeight: table?.getBoundingClientRect().height ?? 0,
      rowHeight: firstRow?.getBoundingClientRect().height ?? 0
    }
  })
  expect(weeklyLayout.cardHeight).toBeGreaterThan(170)
  expect(weeklyLayout.tableHeight).toBeGreaterThan(100)
  expect(weeklyLayout.rowHeight).toBeGreaterThan(30)
  await page.screenshot({
    path: testInfo.outputPath('analytics-weekly-statistics.png'),
    animations: 'disabled'
  })

  await statisticsMode.getByRole('button', { name: '按内容', exact: true }).click()
  await expect(analysisPage.locator('.analysis-state.loading')).toHaveCount(0)
  const lifecycleScrollState = await analysisPage.locator('.lifecycle-table-wrap').evaluate((table) => ({
    nestedScrollRange: table.scrollHeight - table.clientHeight,
    pageScrollRange: (table.closest<HTMLElement>('.analysis-page')?.scrollHeight ?? 0) -
      (table.closest<HTMLElement>('.analysis-page')?.clientHeight ?? 0)
  }))
  expect(lifecycleScrollState.nestedScrollRange).toBeLessThanOrEqual(1)
  expect(lifecycleScrollState.pageScrollRange).toBeGreaterThan(0)
  await analysisPage.locator('.lifecycle-table-wrap').hover()
  const pageScrollBeforeWheel = await analysisPage.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 420)
  await expect.poll(() => analysisPage.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(pageScrollBeforeWheel)
  await analysisPage.evaluate((element) => { element.scrollTop = 0 })
  const trendTrigger = analysisPage.locator('.content-trend-trigger').first()
  await expect(trendTrigger).toBeVisible()
  await trendTrigger.click()
  const dialog = page.getByRole('dialog', { name: /内容 analytics-/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/3 个指标变化快照/)).toBeVisible()
  await expect(dialog.getByText('指标未变化的同步不会重复保存快照')).toBeVisible()
  await expect(dialog.locator('.content-trend-grid article')).toHaveCount(5)
  await expect(dialog.locator('.content-trend-line').first()).toBeVisible()
  const layout = await dialog.evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    height: element.getBoundingClientRect().height,
    viewportHeight: innerHeight
  }))
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(layout.height).toBeLessThanOrEqual(layout.viewportHeight - 20)
  await page.screenshot({
    path: testInfo.outputPath('analytics-content-trend.png'),
    animations: 'disabled'
  })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('账号批量同步会在入队前预览并跳过未登录账号', async () => {
  await openSection('accounts')
  await page.getByRole('button', { name: '＋ 添加账号' }).click()
  const addDialog = page.getByRole('dialog', { name: '添加账号' })
  await expect(addDialog).toBeVisible()
  await addDialog.getByLabel('本地备注名（可选）').fill('待同步测试号')
  await addDialog.getByRole('button', { name: '创建账号' }).click()
  await expect(addDialog).toBeHidden()

  await page.getByRole('checkbox', { name: '选择待同步测试号' }).check()
  await page.getByRole('button', { name: '立即同步已选账号' }).click()
  const batchDialog = page.getByRole('dialog', { name: '创建同步批次' })
  await expect(batchDialog).toBeVisible()
  await expect(batchDialog.getByText('0 个可同步，1 个将跳过')).toBeVisible()
  await expect(batchDialog.getByText('请先通过官方入口完成登录并重新核验')).toBeVisible()
  await expect(batchDialog.getByRole('button', { name: '同步 0 个账号' })).toBeDisabled()

  const bounds = await batchDialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds?.height).toBeLessThanOrEqual(590)
  await page.keyboard.press('Escape')
  await expect(batchDialog).toBeHidden()
})

test('知乎账号详情在最小窗口下完整展示周期指标入口', async () => {
  await openSection('accounts')
  await page.getByRole('button', { name: '＋ 添加账号' }).click()
  const addDialog = page.getByRole('dialog', { name: '添加账号' })
  await addDialog.getByLabel('平台').selectOption('zhihu')
  await addDialog.getByLabel('本地备注名（可选）').fill('知乎指标测试号')
  await addDialog.getByRole('button', { name: '创建账号' }).click()
  await expect(addDialog).toBeHidden()

  const panel = page.locator('.account-metrics-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('暂无创作指标')).toBeVisible()
  const periods = panel.getByRole('group', { name: '创作指标周期' })
  await expect(periods.getByRole('button')).toHaveCount(4)
  for (const label of ['近 7 天', '近 14 天', '近 30 天', '累计']) {
    await expect(periods.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  await periods.getByRole('button', { name: '累计', exact: true }).click()
  await expect(periods.getByRole('button', { name: '累计', exact: true })).toHaveAttribute('aria-pressed', 'true')

  const layout = await panel.evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    periodOverflow: (() => {
      const periods = element.querySelector<HTMLElement>('.account-metric-periods')
      return periods ? periods.scrollWidth - periods.clientWidth : 0
    })(),
    width: element.getBoundingClientRect().width
  }))
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(layout.periodOverflow).toBeLessThanOrEqual(1)
  expect(layout.width).toBeGreaterThan(300)
})

test('Webhook 权限与配置弹窗可打开且不再出现克隆错误', async () => {
  await waitForPluginCenter()
  const card = contributionCard('测试 Webhook')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '权限与范围' }).click()

  const dialog = page.getByRole('dialog', { name: '测试 Webhook' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.feature-loading')).toHaveCount(0)
  await expect(dialog.locator('.permission-pane')).toBeVisible()
  await expect(dialog.locator('.manager-error')).toHaveCount(0)

  await dialog.getByRole('button', { name: '配置', exact: true }).click()
  await expect(dialog.locator('.config-pane')).toBeVisible()
  await expect(dialog.locator('.config-field')).not.toHaveCount(0)
  await expect(dialog.locator('.manager-error')).toHaveCount(0)
  await expect(dialog.getByText(/structuredClone|could not be cloned/i)).toHaveCount(0)

  const eventOptions = dialog.locator('.array-options input[type="checkbox"]')
  await expect(eventOptions).toHaveCount(3)
  const firstOption = eventOptions.first()
  const initiallyChecked = await firstOption.isChecked()
  await firstOption.click()
  expect(await firstOption.isChecked()).toBe(!initiallyChecked)
  await firstOption.click()
  expect(await firstOption.isChecked()).toBe(initiallyChecked)

  const scrollState = await dialog.locator('.config-pane').evaluate((pane) => {
    const maximum = pane.scrollHeight - pane.clientHeight
    pane.scrollTop = maximum
    return { maximum, actual: pane.scrollTop }
  })
  expect(scrollState.maximum).toBeGreaterThan(0)
  expect(scrollState.actual).toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('自动计划支持间隔、每天、每周和每月并保持控件对齐', async () => {
  await waitForPluginCenter()
  const card = contributionCard('知乎账号适配器')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '运行计划', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '知乎账号适配器' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.feature-loading')).toHaveCount(0)
  const cadenceTabs = dialog.getByRole('tablist', { name: '计划执行方式' })
  await expect(cadenceTabs.getByRole('tab')).toHaveCount(4)
  await expect(cadenceTabs.getByRole('tab', { name: '间隔' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByLabel('运行间隔（分钟）')).toBeVisible()

  await cadenceTabs.getByRole('tab', { name: '每天' }).click()
  await expect(dialog.getByLabel('执行时间')).toBeVisible()
  await expect(dialog.getByText('启用后等待下一个设定时间，不会立即执行')).toBeVisible()

  await cadenceTabs.getByRole('tab', { name: '每周' }).click()
  const weekdayGroup = dialog.getByRole('group', { name: '星期' })
  await expect(weekdayGroup.getByRole('checkbox')).toHaveCount(7)

  await cadenceTabs.getByRole('tab', { name: '每月' }).click()
  const monthDayGroup = dialog.getByRole('group', { name: '日期' })
  await expect(monthDayGroup.getByRole('checkbox')).toHaveCount(31)

  const cadenceLayout = await dialog.locator('.cadence-config').evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    width: element.getBoundingClientRect().width
  }))
  expect(cadenceLayout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(cadenceLayout.width).toBeGreaterThan(260)

  await cadenceTabs.getByRole('tab', { name: '间隔' }).click()
  const option = dialog.locator('.enable-on-create')
  const checkbox = option.locator('input[type="checkbox"]')
  const copy = option.locator(':scope > span')
  await expect(option).toBeVisible()
  await expect(checkbox).not.toBeChecked()

  const [optionBox, checkboxBox, copyBox] = await Promise.all([
    option.boundingBox(),
    checkbox.boundingBox(),
    copy.boundingBox()
  ])
  expect(optionBox).not.toBeNull()
  expect(checkboxBox).not.toBeNull()
  expect(copyBox).not.toBeNull()
  expect(checkboxBox?.width).toBeLessThanOrEqual(20)
  expect(checkboxBox?.height).toBeLessThanOrEqual(20)
  expect((copyBox?.x ?? 0) - ((checkboxBox?.x ?? 0) + (checkboxBox?.width ?? 0))).toBeGreaterThan(4)
  expect(Math.abs(
    (checkboxBox?.y ?? 0) + (checkboxBox?.height ?? 0) / 2
      - ((copyBox?.y ?? 0) + (copyBox?.height ?? 0) / 2)
  )).toBeLessThanOrEqual(4)

  await option.click()
  await expect(checkbox).toBeChecked()
  expect(await option.evaluate((element) => element.matches(':has(input:checked)'))).toBe(true)
  await option.click()
  await expect(checkbox).not.toBeChecked()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('可信内置平台插件首次启动即启用授权且采集间隔可持久化', async () => {
  await waitForPluginCenter()
  for (const name of ['小红书账号适配器', '知乎账号适配器']) {
    const card = contributionCard(name)
    await expect(card).toBeVisible()
    await expect(card.locator('.contribution-switch')).toHaveAttribute('aria-checked', 'true')
    await expect(card.getByText('权限已确认')).toBeVisible()
  }

  const card = contributionCard('知乎账号适配器')
  await card.getByRole('button', { name: '配置', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '知乎账号适配器' })
  const interval = dialog.getByLabel('手动采集间隔（分钟）')
  await expect(interval).toHaveValue('5')
  await interval.fill('17')
  await dialog.getByRole('button', { name: '保存配置' }).click()
  await expect(interval).toHaveValue('17')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await card.getByRole('button', { name: '配置', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '知乎账号适配器' })
  await expect(dialog.getByLabel('手动采集间隔（分钟）')).toHaveValue('17')
  await page.keyboard.press('Escape')
})

test('日志中心持久记录渲染错误和 IPC 校验错误', async () => {
  await page.evaluate(async () => {
    const error = new Error('E2E_RENDER_DIAGNOSTIC')
    window.dispatchEvent(new ErrorEvent('error', { message: error.message, error }))
    try {
      await (globalThis as unknown as {
        socialVault: { logs: { list(query: { limit: number }): Promise<unknown> } }
      }).socialVault.logs.list({ limit: 2_001 })
    } catch {}
  })

  await openSection('logs')
  const rendererRow = page.locator('.log-row').filter({ hasText: 'E2E_RENDER_DIAGNOSTIC' })
  await expect(rendererRow).toBeVisible()
  await rendererRow.click()
  await expect(page.locator('.log-detail')).toContainText('RENDERER_ERROR')
  await expect(page.locator('.log-row').filter({ hasText: '日志数量无效' })).toBeVisible()

  await page.reload()
  await page.locator('#app').waitFor({ state: 'visible' })
  await openSection('logs')
  await expect(page.locator('.log-row').filter({ hasText: 'E2E_RENDER_DIAGNOSTIC' })).toBeVisible()
  const layout = await page.locator('.log-page').evaluate((element) => ({
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    workspaceHeight: element.querySelector<HTMLElement>('.log-workspace')?.getBoundingClientRect().height ?? 0
  }))
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(layout.workspaceHeight).toBeGreaterThan(300)
})

test('六个主要工作区在 900 与 1280 宽度下完成真实截图且无横向溢出', async ({}, testInfo) => {
  const sections = ['accounts', 'content', 'analytics', 'plugins', 'logs', 'settings'] as const
  for (const [width, height] of [[900, 700], [1280, 820]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    }, { width, height })
    await page.waitForTimeout(120)

    for (const section of sections) {
      await openSection(section)
      await expect(page.locator('.main-content > *').first()).toBeVisible()
      await page.waitForTimeout(120)
      const overflow = await page.locator('.main-content').evaluate((element) => ({
        main: element.scrollWidth - element.clientWidth,
        page: element.firstElementChild instanceof HTMLElement
          ? element.firstElementChild.scrollWidth - element.firstElementChild.clientWidth
          : 0
      }))
      expect(overflow.main).toBeLessThanOrEqual(1)
      expect(overflow.page).toBeLessThanOrEqual(1)
      if (width === 900 && (section === 'accounts' || section === 'content')) {
        const selector = section === 'accounts' ? '.search-box' : '.filter-search-control'
        const searchGeometry = await page.locator(selector).evaluate((element) => {
          const control = element.getBoundingClientRect()
          const input = element.querySelector('input')
          const icon = element.querySelector('svg')
          if (!input || !icon) return null
          const inputBounds = input.getBoundingClientRect()
          const iconBounds = icon.getBoundingClientRect()
          return {
            controlHeight: control.height,
            inputBorderWidth: Number.parseFloat(getComputedStyle(input).borderTopWidth),
            inputCenterDelta: Math.abs(
              inputBounds.top + inputBounds.height / 2 - (control.top + control.height / 2)
            ),
            iconCenterDelta: Math.abs(
              iconBounds.top + iconBounds.height / 2 - (control.top + control.height / 2)
            )
          }
        })
        expect(searchGeometry).not.toBeNull()
        expect(searchGeometry?.controlHeight).toBeGreaterThanOrEqual(34)
        expect(searchGeometry?.controlHeight).toBeLessThanOrEqual(42)
        expect(searchGeometry?.inputBorderWidth).toBe(0)
        expect(searchGeometry?.inputCenterDelta).toBeLessThanOrEqual(1)
        expect(searchGeometry?.iconCenterDelta).toBeLessThanOrEqual(1)
      }
      await page.screenshot({
        path: testInfo.outputPath(`ui-${width}x${height}-${section}.png`),
        animations: 'disabled'
      })
      if (section === 'content' && width === 900) {
        const workspace = page.locator('.content-workspace')
        const before = await workspace.boundingBox()
        await page.getByRole('button', { name: '更多筛选' }).click()
        await expect(page.locator('.content-filter-advanced')).toBeVisible()
        const after = await workspace.boundingBox()
        expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1)
        await page.screenshot({
          path: testInfo.outputPath('ui-900x700-content-advanced-filters.png'),
          animations: 'disabled'
        })
        await page.getByRole('button', { name: '收起筛选' }).click()
      }
    }
  }

  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(920, 640)
  })
})

test('浅色与深色主题都能在真实窗口中应用', async () => {
  const trigger = page.getByRole('button', { name: /切换主题/ })
  await trigger.click()
  await page.getByRole('menuitemradio', { name: '浅色' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const lightBackground = await page.locator('html').evaluate((element) => (
    getComputedStyle(element).getPropertyValue('--bg').trim()
  ))

  await trigger.click()
  await page.getByRole('menuitemradio', { name: '深色' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const darkBackground = await page.locator('html').evaluate((element) => (
    getComputedStyle(element).getPropertyValue('--bg').trim()
  ))
  expect(darkBackground).not.toBe(lightBackground)

  await trigger.click()
  const themeMenu = page.locator('.theme-menu')
  await themeMenu.getByRole('group', { name: '界面字号' }).getByRole('button', { name: '大', exact: true }).click()
  await themeMenu.getByRole('group', { name: '界面密度' }).getByRole('button', { name: '舒适', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'large')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable')

  await page.reload()
  await page.locator('#app').waitFor({ state: 'visible' })
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'large')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable')
})

test('最小窗口在大字号与舒适密度下保持六个工作区可用', async ({}, testInfo) => {
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'large')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable')
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(760, 640)
  })
  await page.waitForTimeout(150)

  const sections = ['accounts', 'content', 'analytics', 'plugins', 'logs', 'settings'] as const
  for (const section of sections) {
    await openSection(section)
    await expect(page.locator('.main-content > *').first()).toBeVisible()
    await page.waitForTimeout(120)
    const layout = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('.main-content')
      const sidebar = document.querySelector<HTMLElement>('.app-sidebar')
      const pageElement = main?.firstElementChild instanceof HTMLElement ? main.firstElementChild : null
      const mainBounds = main?.getBoundingClientRect()
      const sidebarBounds = sidebar?.getBoundingClientRect()
      return {
        viewportWidth: innerWidth,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        mainOverflow: main ? main.scrollWidth - main.clientWidth : Number.POSITIVE_INFINITY,
        pageOverflow: pageElement ? pageElement.scrollWidth - pageElement.clientWidth : Number.POSITIVE_INFINITY,
        mainWidth: mainBounds?.width ?? 0,
        mainLeft: mainBounds?.left ?? 0,
        sidebarRight: sidebarBounds?.right ?? 0
      }
    })
    expect(layout.viewportWidth).toBeLessThanOrEqual(760)
    expect(layout.viewportWidth).toBeGreaterThan(700)
    expect(layout.documentOverflow).toBeLessThanOrEqual(1)
    expect(layout.mainOverflow).toBeLessThanOrEqual(1)
    expect(layout.pageOverflow).toBeLessThanOrEqual(1)
    expect(layout.mainWidth).toBeGreaterThan(440)
    expect(layout.mainLeft).toBeGreaterThanOrEqual(layout.sidebarRight - 1)
    await page.screenshot({
      path: testInfo.outputPath(`ui-760x640-large-comfortable-${section}.png`),
      animations: 'disabled'
    })
  }
})
