import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { bootstrapLibraryState } from './library-state'
import './style.css'

try { document.documentElement.dataset.theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light' }
catch { document.documentElement.dataset.theme = 'light' }

// 筛选/排序记忆在服务端：先取回再挂载，避免首屏用默认筛选渲染一次再跳变。
// 接口不可用时 bootstrap 内部降级为默认值，不阻塞应用启动。
await bootstrapLibraryState()

createApp(App).use(router).mount('#app')
