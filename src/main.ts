import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './style.css'

try { document.documentElement.dataset.theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light' }
catch { document.documentElement.dataset.theme = 'light' }

createApp(App).use(router).mount('#app')
