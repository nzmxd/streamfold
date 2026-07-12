import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { BrowserManager } from './browser-manager'
import type { SocialDatabase } from './database'
import { listPlatforms } from './platforms'
import { isTrustedShellUrl } from './shell-security'
import {
  parseCreateAccount,
  parseCreateGroup,
  parseId,
  parseUpdateAccount
} from './validation'

export function registerIpc(
  window: BrowserWindow,
  database: SocialDatabase,
  browser: BrowserManager
): void {
  const disconnectingAccounts = new Set<string>()
  const trusted = <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) => {
    return (event: IpcMainInvokeEvent, ...args: unknown[]): T | Promise<T> => {
      assertTrustedSender(window, event)
      return handler(event, ...args)
    }
  }

  ipcMain.handle('platforms:list', trusted(() => listPlatforms()))
  ipcMain.handle('accounts:list', trusted(() => database.listAccounts()))
  ipcMain.handle('accounts:create', trusted((_event, value) => database.createAccount(parseCreateAccount(value))))
  ipcMain.handle('accounts:update', trusted((_event, value) => database.updateAccount(parseUpdateAccount(value))))
  ipcMain.handle('accounts:disconnect', trusted(async (_event, value) => {
    const id = parseId(value)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在断开')
    disconnectingAccounts.add(id)
    try {
      await browser.disconnect(id)
      database.removeAccount(id)
    } finally {
      disconnectingAccounts.delete(id)
    }
  }))
  ipcMain.handle('groups:list', trusted(() => database.listGroups()))
  ipcMain.handle('groups:create', trusted((_event, value) => database.createGroup(parseCreateGroup(value))))
  ipcMain.handle('groups:remove', trusted((_event, value) => database.removeGroup(parseId(value))))
  ipcMain.handle('browser:open', trusted((_event, accountId) => {
    const id = parseId(accountId)
    if (disconnectingAccounts.has(id)) throw new Error('账号正在断开，请稍候')
    return browser.open(id)
  }))

  ipcMain.handle('browser-workspace:get-state', (event) => browser.getStateForSender(event))
  ipcMain.handle('browser-workspace:back', (event) => browser.backForSender(event))
  ipcMain.handle('browser-workspace:forward', (event) => browser.forwardForSender(event))
  ipcMain.handle('browser-workspace:reload', (event) => browser.reloadForSender(event))
  ipcMain.handle('browser-workspace:home', (event) => browser.homeForSender(event))
  ipcMain.handle('browser-workspace:close', (event) => browser.closeForSender(event))
}

export function unregisterIpc(): void {
  for (const channel of [
    'platforms:list',
    'accounts:list',
    'accounts:create',
    'accounts:update',
    'accounts:disconnect',
    'groups:list',
    'groups:create',
    'groups:remove',
    'browser:open',
    'browser-workspace:get-state',
    'browser-workspace:back',
    'browser-workspace:forward',
    'browser-workspace:reload',
    'browser-workspace:home',
    'browser-workspace:close'
  ]) ipcMain.removeHandler(channel)
}

function assertTrustedSender(window: BrowserWindow, event: IpcMainInvokeEvent): void {
  if (event.sender.id !== window.webContents.id) throw new Error('拒绝来自远程页面的请求')
  if (event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝来自子框架的请求')

  if (!isTrustedShellUrl(event.senderFrame.url)) throw new Error('管理界面来源无效')
}
