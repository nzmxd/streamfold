import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './features.css'
import './theme.css'
import { initializeTheme } from './ui/theme'
import { installSocialVaultApi } from './ipc/social-vault'
import { normalizeRendererError } from './renderer-error'

installSocialVaultApi()
initializeTheme()

function reportRendererError(
  value: unknown,
  source: 'vue' | 'window' | 'unhandled-rejection',
  metadata: { file?: string; line?: number; column?: number; componentInfo?: string } = {}
): void {
  const error = normalizeRendererError(value)
  void window.socialVault.logs.recordRendererError({
    ...error,
    ...metadata,
    source
  }).catch(() => undefined)
}

window.addEventListener('error', (event) => {
  reportRendererError(event.error ?? event.message, 'window', {
    file: event.filename || undefined,
    line: event.lineno || undefined,
    column: event.colno || undefined
  })
})
window.addEventListener('unhandledrejection', (event) => {
  reportRendererError(event.reason, 'unhandled-rejection')
})

const application = createApp(App)
application.config.errorHandler = (error, _instance, info) => {
  reportRendererError(error, 'vue', { componentInfo: info })
  console.error(error)
}
application.mount('#app')
