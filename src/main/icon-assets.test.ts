/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const browserManager = readFileSync(new URL('./browser-manager.ts', import.meta.url), 'utf8')
const iconLoader = readFileSync(new URL('./icon-assets.ts', import.meta.url), 'utf8')

describe('desktop and tray icon assets', () => {
  it('ships the app icon and scale-aware tray PNGs at their intended dimensions', () => {
    expect(pngSize('../../resources/icons/app-icon.png')).toEqual([1024, 1024])
    expect(pngSize('../../resources/icons/tray-on-light.png')).toEqual([16, 16])
    expect(pngSize('../../resources/icons/tray-on-light@2x.png')).toEqual([32, 32])
    expect(pngSize('../../resources/icons/tray-on-dark.png')).toEqual([16, 16])
    expect(pngSize('../../resources/icons/tray-on-dark@2x.png')).toEqual([32, 32])
    expect(pngSize('../../resources/icons/tray-linux.png')).toEqual([24, 24])
    expect(pngSize('../../resources/icons/trayTemplate.png')).toEqual([16, 16])
    expect(pngSize('../../resources/icons/trayTemplate@2x.png')).toEqual([32, 32])
  })

  it('ships multi-size Windows application and tray icons', () => {
    expect(icoImageCount('../../build/icon.ico')).toBe(9)
    expect(icoImageCount('../../build/tray.ico')).toBe(4)
    expect(readFileSync(new URL('../../build/icon.icns', import.meta.url)).subarray(0, 4).toString('ascii'))
      .toBe('icns')
  })

  it('connects the icon family to both windows and the native tray lifecycle', () => {
    expect(main).toContain("app.setAppUserModelId('com.streamfold.app')")
    expect(main).toContain('applicationIcon = loadApplicationIcon()')
    expect(main).toContain('tray = new Tray(icon)')
    expect(main).toContain("tray.setToolTip('归页 · Streamfold')")
    expect(main).toContain("{ label: '显示归页', click: showMainWindow }")
    expect(main).toContain("{ label: '退出', click: () => app.quit() }")
    expect(browserManager).toContain('private readonly windowIcon: NativeImage | null = null')
    expect(browserManager).toContain('...(this.windowIcon ? { icon: this.windowIcon } : {})')
    expect(iconLoader).toContain("return darkSurface ? 'tray-on-dark.png' : 'tray-on-light.png'")
    expect(iconLoader).toContain('image.setTemplateImage(true)')
  })
})

function pngSize(relativePath: string): [number, number] {
  const data = readFileSync(new URL(relativePath, import.meta.url))
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return [data.readUInt32BE(16), data.readUInt32BE(20)]
}

function icoImageCount(relativePath: string): number {
  const data = readFileSync(new URL(relativePath, import.meta.url))
  expect(data.readUInt16LE(0)).toBe(0)
  expect(data.readUInt16LE(2)).toBe(1)
  return data.readUInt16LE(4)
}
