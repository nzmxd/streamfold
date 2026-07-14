import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import type {
  UpdateClient,
  UpdateClientHandlers,
  UpdateDescriptor
} from './update-service'

export class ElectronUpdateClient implements UpdateClient {
  constructor(private readonly updater: AppUpdater, currentVersion: string) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = true
    updater.allowPrerelease = currentVersion.includes('-')
    updater.allowDowngrade = false
    updater.fullChangelog = false
    updater.disableWebInstaller = true
  }

  subscribe(handlers: UpdateClientHandlers): () => void {
    const onChecking = (): void => handlers.checking()
    const onAvailable = (info: UpdateInfo): void => handlers.available(descriptor(info))
    const onNotAvailable = (info: UpdateInfo): void => handlers.notAvailable(descriptor(info))
    const onProgress = (info: ProgressInfo): void => handlers.progress({
      percent: info.percent,
      transferred: info.transferred,
      total: info.total,
      bytesPerSecond: info.bytesPerSecond
    })
    const onDownloaded = (info: UpdateInfo): void => handlers.downloaded(descriptor(info))
    const onError = (error: Error): void => handlers.error(error)

    this.updater.on('checking-for-update', onChecking)
    this.updater.on('update-available', onAvailable)
    this.updater.on('update-not-available', onNotAvailable)
    this.updater.on('download-progress', onProgress)
    this.updater.on('update-downloaded', onDownloaded)
    this.updater.on('error', onError)

    return () => {
      this.updater.removeListener('checking-for-update', onChecking)
      this.updater.removeListener('update-available', onAvailable)
      this.updater.removeListener('update-not-available', onNotAvailable)
      this.updater.removeListener('download-progress', onProgress)
      this.updater.removeListener('update-downloaded', onDownloaded)
      this.updater.removeListener('error', onError)
    }
  }

  async check(): Promise<void> {
    await this.updater.checkForUpdates()
  }

  async download(): Promise<void> {
    await this.updater.downloadUpdate()
  }

  restartAndInstall(): void {
    this.updater.quitAndInstall(false, true)
  }
}

function descriptor(info: UpdateInfo): UpdateDescriptor {
  return {
    version: info.version,
    ...(info.releaseDate ? { releaseDate: info.releaseDate } : {})
  }
}
