import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import 'viewerjs/dist/viewer.css'
import './style.css'

document.documentElement.dataset.theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'

createApp(App).use(router).mount('#app')
