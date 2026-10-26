import { createRouter, createWebHistory, START_LOCATION } from 'vue-router'
import { createSearchSessionId } from './route-cache-key'
import { readLibraryState } from './library-state'

const LibraryView = () => import('./views/LibraryView.vue')
const SettingsPage = () => import('./views/SettingsPage.vue')
const WorkPage = () => import('./views/WorkPage.vue')
const PixivUserPage = () => import('./views/PixivUserPage.vue')

function restoreLastPage() {
  // 上次浏览的媒体库/收藏/来源由服务端记忆。
  const state = readLibraryState('works')
  if (state.view === 'favorites') return { name: 'favorites', query: state.source ? { source: state.source } : {} }
  if (state.source) return { name: 'source', params: { sourceId: state.source } }
  return { name: 'library' }
}

const browseNames = new Set(['library', 'favorites', 'source', 'search', 'cloudSearch', 'cloudFavorites', 'settings', 'work', 'cloudWork', 'cloudUser'])

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', redirect: restoreLastPage },
    { path: '/library', name: 'library', component: LibraryView },
    { path: '/favorites', name: 'favorites', component: LibraryView },
    { path: '/source/:sourceId', name: 'source', component: LibraryView },
    { path: '/search', name: 'search', component: LibraryView },
    { path: '/cloud/search', name: 'cloudSearch', component: LibraryView },
    { path: '/cloud/favorites', name: 'cloudFavorites', component: LibraryView },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/works/:workId', name: 'work', component: WorkPage },
    { path: '/cloud/works/:workId', name: 'cloudWork', component: WorkPage },
    { path: '/cloud/users/:userId', name: 'cloudUser', component: PixivUserPage },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(to, from, savedPosition) {
    // 刷新或首次进入时回到顶部，避免恢复旧坐标时被第一页高度截断。
    if (from === START_LOCATION) return { top: 0 }
    // 从作品页回列表时由列表页收到返回作品消息后统一滚动，避免这里恢复旧位置覆盖。
    if (from.name === 'work' || from.name === 'cloudWork') return false
    // B owned：同名同 pid 的 replace（分类/筛选同实例切换）不碰滚动，
    // 由页面自己的 watch+nextTick 恢复；跨 pid 新实例必须回顶部。
    if (to.name && to.name === from.name) {
      const toPid = typeof to.query.pid === 'string' ? to.query.pid : ''
      const fromPid = typeof from.query.pid === 'string' ? from.query.pid : ''
      if (toPid && toPid === fromPid) return false
    }
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})

// 直达/旧链接缺 pid 时补一次 replace，保证每个浏览实例都有独立身份。
// 不区分 push/replace/pop：已有 pid 原样放行，只有缺失才补。
router.beforeEach(to => {
  if (typeof to.name !== 'string' || !browseNames.has(to.name)) return
  if (typeof to.query.pid === 'string' && to.query.pid) return
  return { name: to.name, params: { ...to.params }, query: { ...to.query, pid: createSearchSessionId() }, hash: to.hash || undefined }
})
