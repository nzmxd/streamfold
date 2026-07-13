import { createApp } from 'vue'
import BrowserWorkspace from './BrowserWorkspace.vue'
import './browser.css'
import { initializeTheme } from './ui/theme'

initializeTheme()
createApp(BrowserWorkspace).mount('#browser-app')
