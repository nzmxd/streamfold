import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { VerifiedPluginPackage } from './plugin-package'
import { MAX_SANDBOX_ENTRY_BYTES } from './sandbox-protocol'

/** Private package storage. Paths are never returned through IPC. */
export class PluginEntryStore {
  constructor(private readonly rootDirectory: string) {}

  async stageAndActivate(plugin: VerifiedPluginPackage): Promise<void> {
    const target = this.versionDirectory(plugin.manifest.id, plugin.manifest.version)
    if (await exists(target)) {
      await this.assertInstalledPackage(target, plugin)
      return
    }
    await mkdir(this.rootDirectory, { recursive: true })
    const staging = join(this.rootDirectory, `.staging-${plugin.manifest.id}-${randomUUID()}`)
    await rm(staging, { recursive: true, force: true })
    try {
      for (const [name, value] of plugin.entries) {
        const file = resolve(staging, ...name.split('/'))
        assertInside(staging, file)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, value, { flag: 'wx', mode: 0o600 })
      }
      await writeFile(join(staging, '.content-hash'), plugin.contentHash, { flag: 'wx', mode: 0o600 })
      await mkdir(dirname(target), { recursive: true })
      try {
        await renameWithRetry(staging, target)
      } catch (error) {
        if (!await exists(target)) throw error
        await this.assertInstalledPackage(target, plugin)
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async readEntry(pluginId: string, version: string, entry: string): Promise<string> {
    assertIdentifier(pluginId)
    assertVersion(version)
    if (!/^(?:entries\/)?[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\.js$/.test(entry) || entry.includes('..')) {
      throw new Error('插件入口路径无效')
    }
    const root = this.versionDirectory(pluginId, version)
    const file = resolve(root, ...entry.split('/'))
    assertInside(root, file)
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('插件入口文件无效')
    const bytes = await readFile(file)
    try {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_SANDBOX_ENTRY_BYTES) {
        throw new Error('插件入口超过大小限制')
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } finally {
      bytes.fill(0)
    }
  }

  async removePlugin(pluginId: string): Promise<void> {
    assertIdentifier(pluginId)
    const directory = resolve(this.rootDirectory, pluginId)
    assertInside(this.rootDirectory, directory)
    await rm(directory, { recursive: true, force: true })
  }

  private versionDirectory(pluginId: string, version: string): string {
    assertIdentifier(pluginId)
    assertVersion(version)
    const directory = resolve(this.rootDirectory, pluginId, version)
    assertInside(this.rootDirectory, directory)
    return directory
  }

  private async assertInstalledPackage(target: string, plugin: VerifiedPluginPackage): Promise<void> {
    const existing = await readFile(join(target, '.content-hash'), 'utf8').catch(() => '')
    if (existing.trim() !== plugin.contentHash) throw new Error('相同插件版本的内容摘要不一致')
    for (const [name, expected] of plugin.entries) {
      const file = resolve(target, ...name.split('/'))
      assertInside(target, file)
      const metadata = await lstat(file).catch(() => null)
      if (!metadata?.isFile() || metadata.isSymbolicLink()) {
        throw new Error('已安装插件文件与验证包不一致')
      }
      const actual = await readFile(file)
      try {
        if (!actual.equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))) {
          throw new Error('已安装插件文件与验证包不一致')
        }
      } finally {
        actual.fill(0)
      }
    }
  }
}

export class PluginEntryResolver {
  constructor(private readonly installed: PluginEntryStore) {}

  async readEntry(pluginId: string, version: string, entry: string): Promise<string> {
    return await this.installed.readEntry(pluginId, version, entry)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const renameRetryDelays = [25, 50, 100, 200, 400, 800] as const

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= renameRetryDelays.length) throw error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, renameRetryDelays[attempt]))
    }
  }
}

function isRetryableRenameError(value: unknown): boolean {
  const code = value && typeof value === 'object' && 'code' in value
    ? String((value as { code?: unknown }).code)
    : ''
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function assertInside(root: string, target: string): void {
  const base = resolve(root)
  const candidate = resolve(target)
  if (candidate === base || !candidate.startsWith(`${base}${sep}`)) throw new Error('插件存储路径无效')
}

function assertIdentifier(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/.test(value)) throw new Error('插件 ID 无效')
}

function assertVersion(value: string): void {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error('插件版本无效')
  }
}
