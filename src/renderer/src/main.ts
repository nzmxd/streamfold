import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './features.css'
import './theme.css'
import { initializeTheme } from './ui/theme'

initializeTheme()
createApp(App).mount('#app')
