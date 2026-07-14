import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const electronExecutable = createRequire(import.meta.url)('electron') as string

test.describe.configure({ mode: 'serial' })

let application: ElectronApplication
let page: Page
let reviewUserData: string | null = null

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

async function openSection(section: 'settings' | 'plugins'): Promise<void> {
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

test('创建后立即启用控件正确对齐并可切换', async () => {
  await waitForPluginCenter()
  const card = contributionCard('知乎账号适配器')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '运行计划', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '知乎账号适配器' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.feature-loading')).toHaveCount(0)
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
})
