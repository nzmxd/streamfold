import { safeStorage } from 'electron'

export interface PluginSecretStore {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

export class ElectronPluginSecretStore implements PluginSecretStore {
  available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'system'
    return backend !== 'basic_text'
  }

  encrypt(value: string): string {
    if (!this.available()) throw new Error('当前系统安全存储不可用，不能保存插件密钥')
    return safeStorage.encryptString(value).toString('base64')
  }

  decrypt(value: string): string {
    if (!this.available()) throw new Error('当前系统安全存储不可用，不能读取插件密钥')
    const bytes = Buffer.from(value, 'base64')
    try {
      return safeStorage.decryptString(bytes)
    } finally {
      bytes.fill(0)
    }
  }
}
