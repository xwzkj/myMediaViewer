import { createRouter, createWebHistory } from 'vue-router'

const LibraryView = () => import('./views/LibraryView.vue')
const SettingsPage = () => import('./views/SettingsPage.vue')
const WorkPage = () => import('./views/WorkPage.vue')

function restoreLastPage() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('libraryState') || '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { name: 'library' }
    const state = saved as Record<string, unknown>
    const source = typeof state.source === 'string' ? state.source : ''
    if (state.view === 'favorites') return { name: 'favorites', query: source ? { source } : {} }
    if (source) return { name: 'source', params: { sourceId: source } }
  } catch { /* 状态损坏时回到全部作品 */ }
  return { name: 'library' }
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', redirect: restoreLastPage },
    { path: '/library', name: 'library', component: LibraryView },
    { path: '/favorites', name: 'favorites', component: LibraryView },
    { path: '/source/:sourceId', name: 'source', component: LibraryView },
    { path: '/search', name: 'search', component: LibraryView },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/works/:workId', name: 'work', component: WorkPage },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(to, from, savedPosition) {
    // 从作品页回列表时由列表页收到返回作品消息后统一滚动，避免这里恢复旧位置覆盖。
    if (from.name === 'work') return false
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})
