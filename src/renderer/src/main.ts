import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './features.css'
import './theme.css'
import { initializeTheme } from './ui/theme'
import { installSocialVaultApi } from './ipc/social-vault'

installSocialVaultApi()
initializeTheme()
createApp(App).mount('#app')
