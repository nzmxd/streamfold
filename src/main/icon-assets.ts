import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, nativeImage, nativeTheme, type NativeImage } from 'electron'

const currentDir = dirname(fileURLToPath(import.meta.url))

export function trayIconFilename(platform: NodeJS.Platform, darkSurface: boolean): string {
  if (platform === 'darwin') return 'trayTemplate.png'
  if (platform === 'win32') return darkSurface ? 'tray-on-dark.png' : 'tray-on-light.png'
  return 'tray-linux.png'
}

export function loadApplicationIcon(): NativeImage | null {
  return loadIcon('app-icon.png')
}

export function loadTrayIcon(): NativeImage | null {
  const image = loadIcon(trayIconFilename(process.platform, nativeTheme.shouldUseDarkColors))
  if (image && process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function loadIcon(filename: string): NativeImage | null {
  for (const path of iconCandidates(filename)) {
    if (!existsSync(path)) continue
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) return image
  }
  return null
}

function iconCandidates(filename: string): string[] {
  const bundled = resolve(currentDir, '../../resources/icons', filename)
  if (!app.isPackaged) return [bundled]
  return [join(process.resourcesPath, 'icons', filename), bundled]
}
