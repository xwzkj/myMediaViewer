<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import type { PixivStatus, PixivUserProfile, Work } from '../../shared/types'
import { api } from '../api'
import { appEvents, type PixivAuthChangedPayload, type PixivBookmarkSyncedPayload, type WorkReturnPayload } from '../events'
import { pushPage, replacePage, returnFromPage, trackPagePid } from '../navigation'
import { releaseLibrarySession, retainLibrarySession, setLibraryLoader, syncLibrarySession } from '../library-session'
import { usePageRoute } from '../use-page-route'
import { useNotice } from '../use-notice'
import Icon from '../components/Icon.vue'
import AppNotice from '../components/AppNotice.vue'
import WorkCard from '../components/WorkCard.vue'

defineOptions({ name: 'PixivUserPage' })

type CreatorType = 'illust' | 'manga'
interface CategoryState {
  items: Work[]
  cursor: string | null
  loading: boolean
  /** 首屏成功过（含空结果），切空分类不再重复 fetch。 */
  loaded: boolean
  page: number
  pages: number
  error: string
  moreFailed: boolean
  moreError: string
  visited: Set<string>
  /** 在途分页请求：sentinel/按钮/显式 loader 共享同一 Promise。 */
  pending: Promise<void> | null
}

function emptyCategory(): CategoryState {
  return { items: [], cursor: null, loading: false, loaded: false, page: 0, pages: 0, error: '', moreFailed: false, moreError: '', visited: new Set(), pending: null }
}

/** Pixiv 创作环境 raw key 中文映射，未知 key 原样保留。 */
const WORKSPACE_LABELS: Record<string, string> = {
  pc: '电脑', desktop: '台式机', monitor: '显示器', software: '软件',
  tablet: '数位板', mouse: '鼠标', keyboard: '键盘', printer: '打印机', scanner: '扫描仪',
}
function workspaceLabel(key: string): string {
  return WORKSPACE_LABELS[key.toLowerCase()] || key
}

const router = useRouter()
// 实例路由快照：失活期间只读自己的快照，不读别的页面的 mode/query。active 只读不赋值。
const { route, active: pageActive, pageKey } = usePageRoute()
const userId = computed(() => String(route.value.params.userId || ''))
const activeTab = computed<CreatorType>(() => (route.value.query.type === 'manga' ? 'manga' : 'illust'))
const instancePid = computed(() => (typeof route.value.query.pid === 'string' ? route.value.query.pid : ''))
const pixivStatus = ref<PixivStatus | null>(null)
const cloudEnabled = computed(() => Boolean(pixivStatus.value?.settings.configured && !pixivStatus.value.settings.localMode))
const profile = ref<PixivUserProfile | null>(null)
const profileLoading = ref(true)
const profileError = ref('')
const states: Record<CreatorType, CategoryState> = { illust: emptyCategory(), manga: emptyCategory() }
const illustState = ref(states.illust)
const mangaState = ref(states.manga)
const current = computed(() => (activeTab.value === 'manga' ? mangaState.value : illustState.value))
const sentinel = ref<HTMLElement>()
const destroyed = ref(false)
// auth 变化时失活页只标 dirty，激活后才重载。
const authDirty = ref(false)
let profileController: AbortController | undefined
let worksControllers = new Map<string, AbortController>()
let scrollMemory: Record<CreatorType, number> = { illust: 0, manga: 0 }
// 显式分页 loader 按分类独立 epoch：reset/auth-clear 只注销本分类 loader。
const loaderEpoch: Record<CreatorType, number> = { illust: 0, manga: 0 }
const { toast, notice, dismiss, runAction } = useNotice()
const favoriteRequests = new Set<string>()
const retainedSessions = new Set<string>()
const avatarImgFailed = ref(false)
const bgImgFailed = ref(false)
watch(() => profile.value?.avatarUrl, () => { avatarImgFailed.value = false })
watch(() => profile.value?.backgroundUrl, () => { bgImgFailed.value = false })

/**
 * 头像/背景直接绑定后端版本化代理地址（含 v=hash&a=account）。
 * profile 载入即完整（avatar 与 profile 同一 /users/:id 响应），不单独 await 图片；
 * 远端直链永远不进模板（unsafe 视为缺失占位），img @error 降级占位。
 */
function proxiedImageUrl(kind: 'avatar' | 'background'): string | undefined {
  const data = profile.value
  if (!data) return undefined
  const raw = kind === 'avatar' ? data.avatarUrl : data.backgroundUrl
  if (raw && raw.startsWith('/api/')) return raw
  return undefined
}

function refreshPixivStatus() {
  try {
    void api<PixivStatus>('/pixiv/status').then(value => { pixivStatus.value = value }).catch(() => { pixivStatus.value = null })
  } catch { pixivStatus.value = null }
}

async function loadProfile() {
  profileController?.abort()
  const controller = new AbortController()
  profileController = controller
  profileLoading.value = true
  profileError.value = ''
  try {
    const data = await api<PixivUserProfile>(`/pixiv/users/${encodeURIComponent(userId.value)}`, { signal: controller.signal })
    if (profileController !== controller || destroyed.value) return
    profile.value = data
  } catch (e) {
    if (profileController !== controller || (e as Error).name === 'AbortError') return
    profile.value = null
    profileError.value = (e as Error).message
  } finally {
    if (profileController === controller) profileLoading.value = false
  }
}

function sessionKey(type: CreatorType): string {
  return `creator:${pageKey}:${type}`
}

function retainSession(type: CreatorType): void {
  const key = sessionKey(type)
  if (retainedSessions.has(key)) return
  retainedSessions.add(key)
  retainLibrarySession(key)
}

function registerSessionLoader(type: CreatorType): void {
  const key = sessionKey(type)
  const epoch = loaderEpoch[type]
  setLibraryLoader(key, () => {
    // 显式分页：失活也必须工作，只认捕获的 type，不读实时路由。
    // moreFailed 由本闭包清零后直调续页（详情前后翻无需回主页重试）；
    // 页内 observer/按钮仍保持门禁，由用户手动点重试。
    if (epoch !== loaderEpoch[type] || destroyed.value) return Promise.resolve()
    const state = type === 'manga' ? mangaState.value : illustState.value
    if (!state.cursor) return Promise.resolve()
    if (state.pending) return state.pending
    state.moreFailed = false
    state.moreError = ''
    return loadWorksMore(type, userId.value)
  })
}

function loadWorksMore(type: CreatorType, capturedUid: string): Promise<void> {
  const state = type === 'manga' ? mangaState.value : illustState.value
  if (state.pending) return state.pending
  if (!state.cursor || state.loading || state.moreFailed) return Promise.resolve()
  const key = `${type}:more`
  const controller = new AbortController()
  worksControllers.set(key, controller)
  state.loading = true
  const task = (async (): Promise<void> => {
    try {
      const params = new URLSearchParams({ type })
      if (state.cursor) params.set('cursor', state.cursor)
      const response = await api<{ items: Work[]; nextCursor: string | null; elapsed: number }>(
        `/pixiv/users/${encodeURIComponent(capturedUid)}/works?${params}`,
        { signal: controller.signal },
      )
      if (worksControllers.get(key) !== controller || destroyed.value) return
      // 重复游标：本页作品仍合并（不丢弃当前 response），仅 cursor 置 null 终止，避免 A→B→A 循环。
      const repeated = Boolean(state.cursor && response.nextCursor && state.visited.has(response.nextCursor))
      if (response.nextCursor) state.visited.add(response.nextCursor)
      const merged = [...state.items, ...response.items]
      state.items = [...new Map(merged.map(item => [item.id, item])).values()]
      state.cursor = repeated ? null : response.nextCursor
      state.page += 1
      state.pages = state.cursor ? state.page + 1 : state.page
      state.moreFailed = false
      state.moreError = ''
      // 全量 items + append=false：会话侧直接替换，不复现旧重复 bug。
      syncLibrarySession(sessionKey(type), { items: [...state.items], total: state.items.length, page: state.page, pages: state.pages, elapsed: response.elapsed }, false)
      if (state.cursor) registerSessionLoader(type)
      else setLibraryLoader(sessionKey(type), null)
    } catch (e) {
      if (worksControllers.get(key) !== controller || (e as Error).name === 'AbortError') return
      // cursor 保留：loader 抛错给详情提示，页内手动点重试。
      state.moreFailed = true
      state.moreError = (e as Error).message
      notice(`加载更多失败：${(e as Error).message}`)
      throw e
    } finally {
      if (worksControllers.get(key) === controller) {
        worksControllers.delete(key)
        state.loading = false
      }
    }
  })()
  state.pending = task
  // 独立分支清 pending：不污染原 task 的 resolve/reject 语义。
  void task.catch(() => {}).finally(() => { if (state.pending === task) state.pending = null })
  return task
}

async function loadWorks(type: CreatorType, reset: boolean): Promise<void> {
  if (!reset) {
    // 页内 sentinel/按钮路径：失败已 notice，这里吞掉避免未处理 rejection。
    try { await loadWorksMore(type, userId.value) } catch { /* noop */ }
    return
  }
  const state = type === 'manga' ? mangaState.value : illustState.value
  const key = `${type}:reset`
  worksControllers.get(key)?.abort()
  worksControllers.get(`${type}:more`)?.abort()
  state.pending = null
  // 本分类 loader  epoch 递增：旧 loader 闭包失效，不碰另一分类。
  loaderEpoch[type]++
  const controller = new AbortController()
  worksControllers.set(key, controller)
  state.items = []
  state.cursor = null
  state.visited = new Set()
  state.loading = true
  state.loaded = false
  state.page = 0
  state.pages = 0
  state.error = ''
  state.moreFailed = false
  state.moreError = ''
  retainSession(type)
  try {
    const params = new URLSearchParams({ type })
    const capturedUid = userId.value
    const response = await api<{ items: Work[]; nextCursor: string | null; elapsed: number }>(
      `/pixiv/users/${encodeURIComponent(capturedUid)}/works?${params}`,
      { signal: controller.signal },
    )
    // stale 响应（tab 重置/auth 切换后到达）：直接丢弃，不碰本分类更不碰上级会话。
    if (worksControllers.get(key) !== controller || destroyed.value) return
    if (response.nextCursor) state.visited.add(response.nextCursor)
    state.items = [...new Map(response.items.map(item => [item.id, item])).values()]
    state.cursor = response.nextCursor
    state.page = 1
    state.pages = response.nextCursor ? 2 : 1
    state.loaded = true
    syncLibrarySession(sessionKey(type), { items: [...state.items], total: state.items.length, page: state.page, pages: state.pages, elapsed: response.elapsed }, false)
    if (state.cursor) registerSessionLoader(type)
    else setLibraryLoader(sessionKey(type), null)
  } catch (e) {
    if (worksControllers.get(key) !== controller || (e as Error).name === 'AbortError') return
    state.error = (e as Error).message
  } finally {
    if (worksControllers.get(key) === controller) {
      worksControllers.delete(key)
      state.loading = false
    }
  }
}

function retryMore() {
  const state = current.value
  if (state.loading) return
  state.moreFailed = false
  state.moreError = ''
  void loadWorks(activeTab.value, false)
}

function switchTab(type: CreatorType) {
  if (type === activeTab.value) return
  scrollMemory[activeTab.value] = window.scrollY
  // 同实例替换：tab 是同一画师页的视图状态，沿用当前 pid。
  void replacePage(router, { query: { ...route.value.query, type } }, route.value)
}

function openSettings() {
  void pushPage(router, { name: 'settings', query: { from: route.value.fullPath } })
}

function openCreator(userIdValue: string) {
  // 整卡应用内跳主页：新历史实例，from 指向当前页。
  void pushPage(router, { name: 'cloudUser', params: { userId: userIdValue }, query: { from: route.value.fullPath } })
}

function openWork(work: Work) {
  const name = work.hasLocal === false ? 'cloudWork' : 'work'
  const workId = name === 'cloudWork' ? (work.pixivId || work.externalId) : work.id
  // 详情前后翻的来源列表：新历史实例，业务 from/list 保留。
  void pushPage(router, { name, params: { workId }, query: { from: route.value.fullPath, list: sessionKey(activeTab.value) } })
}

function openAuthor(work: Work) {
  if (work.pixivUserId) openCreator(work.pixivUserId)
}

async function toggleFavorite(target: Work) {
  const key = `local:${target.id}`
  if (target.hasLocal === false || favoriteRequests.has(key)) return
  favoriteRequests.add(key)
  const next = !target.favorite
  try {
    await api(`/works/${encodeURIComponent(target.id)}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite: next }) })
    target.favorite = next
    notice(next ? '已加入我的收藏' : '已取消收藏')
  } catch (e) {
    notice((e as Error).message)
  } finally { favoriteRequests.delete(key) }
}

async function toggleCloudFavorite(target: Work) {
  const illustId = target.pixivId || target.externalId
  const key = `cloud:${illustId}`
  if (!illustId || favoriteRequests.has(key)) return
  favoriteRequests.add(key)
  const next = !(target.cloudBookmark?.bookmarked === true)
  try {
    const response = await api<{ bookmarked: boolean; restrict: 'public' | 'private'; warning?: string }>(
      `/pixiv/works/${illustId}/bookmark`, { method: 'PUT', body: JSON.stringify({ bookmarked: next }) },
    )
    target.cloudBookmark = { bookmarked: response.bookmarked, restrict: response.restrict }
    // 本页双分类就地同步 + 全局广播（B 列表/recs 跟随）；失活页 notice 免打扰。
    for (const item of illustState.value.items) {
      if ((item.pixivId || item.externalId) === illustId) item.cloudBookmark = { bookmarked: response.bookmarked, restrict: response.restrict }
    }
    for (const item of mangaState.value.items) {
      if ((item.pixivId || item.externalId) === illustId) item.cloudBookmark = { bookmarked: response.bookmarked, restrict: response.restrict }
    }
    appEvents.emit('pixiv:bookmark-synced', { illustId, bookmarked: response.bookmarked, restrict: response.restrict })
    if (pageActive.value) notice(response.warning || (response.bookmarked ? '已加入 Pixiv 云端收藏' : '已取消 Pixiv 云端收藏'))
    else if (response.warning) notice(response.warning)
  } catch (e) {
    notice((e as Error).message)
  } finally { favoriteRequests.delete(key) }
}

function goBack() {
  // 返回语义交给 navigation：pid 链一致则 back，否则 replace 回 from。
  const result = returnFromPage(router, route.value)
  if (result) void result
}

function handleAuthChanged(payload: PixivAuthChangedPayload) {
  const previous = pixivStatus.value
  const previousAccount = previous?.settings.account?.id || ''
  const nextAccount = payload.accountId || ''
  // 账号/登出/localMode 变化：取消在途请求、清空本页画师数据；active 才重载，否则标 dirty。
  if (previous && (previous.settings.configured !== payload.configured || previous.settings.localMode !== payload.localMode || previousAccount !== nextAccount)) {
    profileController?.abort()
    // 旧 controller 身份清零：迟到成功即使被 api 忽略也不写旧数据（generation 语义）。
    profileController = undefined
    for (const controller of worksControllers.values()) controller.abort()
    worksControllers.clear()
    profile.value = null
    profileError.value = ''
    profileLoading.value = false
    for (const type of ['illust', 'manga'] as const) {
      const state = type === 'manga' ? mangaState.value : illustState.value
      state.items = []
      state.cursor = null
      state.visited = new Set()
      state.loading = false
      state.loaded = false
      state.page = 0
      state.pages = 0
      state.error = ''
      state.moreFailed = false
      state.moreError = ''
      state.pending = null
      loaderEpoch[type]++
      setLibraryLoader(sessionKey(type), null)
    }
    pixivStatus.value = null
    if (pageActive.value) {
      authDirty.value = false
      refreshPixivStatus()
      void loadProfile()
      void loadWorks(activeTab.value, true)
      notice('Pixiv 账号状态已变化，已重新加载')
    } else {
      authDirty.value = true
    }
  }
}

function handleBookmarkSynced(payload: PixivBookmarkSyncedPayload) {
  const update = (item: Work) => {
    if ((item.pixivId || item.externalId) !== payload.illustId) return
    item.cloudBookmark = { bookmarked: payload.bookmarked, restrict: payload.restrict }
  }
  for (const item of illustState.value.items) update(item)
  for (const item of mangaState.value.items) update(item)
}

watch(activeTab, (type, previous) => {
  if (!pageActive.value) return
  const state = type === 'manga' ? mangaState.value : illustState.value
  // loaded 标记：空结果也算加载过，切空分类不重复 fetch；双分类返回无重载。
  if (!state.loaded && !state.loading && !state.error) {
    // 新分类从顶部开始：不清掉会停留在旧分类的深滚动处，看不到骨架屏。
    window.scrollTo(0, 0)
    scrollMemory[type] = 0
    void loadWorks(type, true)
  } else {
    const key = sessionKey(previous)
    // 切已加载分类：router.scrollBehavior 的同实例 replace 默认回顶会覆盖恢复，
    // 双 rAF 等导航滚动落定后再恢复本分类记忆（tab 守卫防切回竞态），再重绑 sentinel。
    const targetType = type
    const targetY = scrollMemory[type] || 0
    void nextTick(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!pageActive.value || activeTab.value !== targetType || destroyed.value) return
          window.scrollTo(0, targetY)
          // sentinel 随分类重建（v-if），切分类后重绑，否则旧节点 detached 致无限滚动失效。
          bindSentinel()
        })
      })
    })
    void key
  }
})

watch(() => route.value.fullPath, () => {
  if (!pageActive.value) return
  refreshPixivStatus()
}, { immediate: true })

let observer: IntersectionObserver | undefined
let sentinelBound: HTMLElement | undefined
function bindSentinel() {
  // 同节点已绑定则跳过：mounted/activated 双 bind 不重复建 observer。
  if (observer && sentinelBound && sentinelBound === sentinel.value && sentinel.value?.isConnected) return
  observer?.disconnect()
  observer = undefined
  sentinelBound = undefined
  if (!sentinel.value || !('IntersectionObserver' in window)) return
  observer = new IntersectionObserver(entries => {
    if (!pageActive.value || destroyed.value) return
    if (entries.some(entry => entry.isIntersecting)) {
      const state = current.value
      if (!state.loading && !state.moreFailed && state.cursor) void loadWorks(activeTab.value, false)
    }
  }, { rootMargin: '600px 0px' })
  observer.observe(sentinel.value)
  sentinelBound = sentinel.value
}

// sentinel 随作品区 v-if 创建/销毁：初挂 loading 无节点，首屏成功后经此 watcher 绑定。
watch(sentinel, () => {
  if (!pageActive.value || destroyed.value) return
  bindSentinel()
}, { flush: 'post' })

onMounted(() => {
  if (instancePid.value) trackPagePid(instancePid.value)
  void loadProfile()
  void loadWorks(activeTab.value, true)
  void nextTick(bindSentinel)
  appEvents.on('work:return', handleWorkReturn)
  appEvents.on('pixiv:auth-changed', handleAuthChanged)
  appEvents.on('pixiv:bookmark-synced', handleBookmarkSynced)
})
onActivated(() => {
  if (instancePid.value) trackPagePid(instancePid.value)
  bindSentinel()
  if (authDirty.value) {
    authDirty.value = false
    refreshPixivStatus()
    void loadProfile()
    void loadWorks(activeTab.value, true)
  } else if (pendingWorkId.value) {
    void restorePendingWork()
  } else {
    // 普通激活恢复：同样双 rAF，防 KeepAlive 切回时的浏览器滚动覆盖。
    const targetType = activeTab.value
    const targetY = scrollMemory[targetType] || 0
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!pageActive.value || activeTab.value !== targetType || destroyed.value) return
        window.scrollTo(0, targetY)
      })
    })
  }
})
onDeactivated(() => {
  // 不采集 scroll：详情页 body 锁定（overflow hidden + scrollY 归零）后才触发，
  // 此时读到的是 0，会覆盖 onBeforeRouteLeave 存的真实离开位置。只断 observer。
  observer?.disconnect()
  observer = undefined
  sentinelBound = undefined
})
onBeforeUnmount(() => {
  destroyed.value = true
  observer?.disconnect()
  profileController?.abort()
  for (const controller of worksControllers.values()) controller.abort()
  worksControllers.clear()
  appEvents.off('work:return', handleWorkReturn)
  appEvents.off('pixiv:auth-changed', handleAuthChanged)
  appEvents.off('pixiv:bookmark-synced', handleBookmarkSynced)
})
onUnmounted(() => {
  for (const key of retainedSessions) releaseLibrarySession(key)
  retainedSessions.clear()
  setLibraryLoader(sessionKey('illust'), null)
  setLibraryLoader(sessionKey('manga'), null)
})

const pendingWorkId = ref('')
function handleWorkReturn(payload: WorkReturnPayload) {
  // 只有 changed 且 from 回到本页全路径、sourcePid 对上本实例时才锚点；普通返回走原 scroll。
  if (!payload.changed) return
  if (payload.sourcePid !== instancePid.value) return
  if (payload.returnPath !== route.value.fullPath) return
  pendingWorkId.value = payload.workId
  void restorePendingWork()
}

async function restorePendingWork() {
  const id = pendingWorkId.value
  if (!id || !pageActive.value) return
  if (!current.value.items.some(work => work.id === id)) {
    // 作品不在当前分类已加载项中：不重置列表，直接放弃定位。
    pendingWorkId.value = ''
    return
  }
  await nextTick()
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  if (!pageActive.value || pendingWorkId.value !== id) return
  const target = Array.from(document.querySelectorAll<HTMLElement>('.work-card[data-work-id]'))
    .find(card => card.dataset.workId === id)
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: 'auto' })
    pendingWorkId.value = ''
  }
}

onBeforeRouteLeave(() => {
  // 离开即记录滚动（含去详情），返回时 restore/scroll 二选一恢复。
  scrollMemory[activeTab.value] = window.scrollY
})
</script>

<template>
  <div class="creator-page">
    <header class="creator-topbar">
      <button class="icon-button" aria-label="返回" @click="goBack"><Icon name="left" :size="20" /></button>
      <h1>画师主页</h1>
    </header>
    <!-- 档案 hero：loading / 失败 / 成功三态，仅管自己。 -->
    <section v-if="profileLoading" class="creator-loading" role="status"><span class="spinner" />正在加载画师信息…</section>
    <section v-else-if="profileError || !profile" class="creator-error" role="alert">
      <Icon name="warning" :size="32" />
      <p>{{ profileError || '画师信息不可用' }}</p>
      <div class="creator-error-actions">
        <button class="button tonal" @click="loadProfile">重试</button>
        <button class="button tonal" @click="openSettings">设置</button>
      </div>
    </section>
    <section v-else class="creator-hero" aria-label="画师信息">
      <div v-if="proxiedImageUrl('background') && !bgImgFailed" class="creator-background"><img :src="proxiedImageUrl('background')" :alt="`${profile.name} 的背景`" loading="lazy" decoding="async" @error="bgImgFailed = true" /></div>
      <div class="creator-identity">
        <div class="creator-avatar">
          <img v-if="proxiedImageUrl('avatar') && !avatarImgFailed" :src="proxiedImageUrl('avatar')" :alt="`${profile.name} 的头像`" loading="lazy" decoding="async" @error="avatarImgFailed = true" />
          <div v-else class="creator-avatar-placeholder" aria-hidden="true"><Icon name="gallery" :size="32" /></div>
        </div>
        <div class="creator-copy">
          <h2>{{ profile.name }}</h2>
          <p class="creator-account">{{ profile.account ? `@${profile.account} · UID ${profile.id}` : `UID ${userId}` }}</p>
          <p v-if="profile.isFollowed" class="creator-followed">已关注</p>
          <p v-if="profile.comment" class="creator-comment">{{ profile.comment }}</p>
          <div class="creator-stats">
            <span v-if="profile.totalIllusts !== undefined">插画 {{ profile.totalIllusts }}</span>
            <span v-if="profile.totalManga !== undefined">漫画 {{ profile.totalManga }}</span>
            <span v-if="profile.totalNovels !== undefined">小说 {{ profile.totalNovels }}</span>
            <span v-if="profile.totalFollows !== undefined">关注 {{ profile.totalFollows }}</span>
          </div>
          <div v-if="profile.location || profile.job || profile.gender" class="creator-meta">
            <span v-if="profile.location">{{ profile.location }}</span>
            <span v-if="profile.job">{{ profile.job }}</span>
            <span v-if="profile.gender">{{ profile.gender }}</span>
          </div>
          <div class="creator-links">
            <a v-if="profile.webpage" :href="profile.webpage" target="_blank" rel="noopener noreferrer">个人网站</a>
            <a v-if="profile.twitterUrl" :href="profile.twitterUrl" target="_blank" rel="noopener noreferrer">X / Twitter</a>
            <a :href="`https://www.pixiv.net/users/${encodeURIComponent(profile.id)}`" target="_blank" rel="noopener noreferrer">在 Pixiv 打开</a>
          </div>
          <details v-if="profile.workspace?.length" class="creator-workspace">
            <summary>创作环境</summary>
            <dl><div v-for="item in profile.workspace" :key="item.label"><dt>{{ workspaceLabel(item.label) }}</dt><dd>{{ item.value }}</dd></div></dl>
          </details>
        </div>
      </div>
    </section>
    <!-- 作品区始终渲染：档案 404 不隐藏作品；auth 未就绪时作品接口 403 会显示清晰错误。 -->
    <nav class="creator-tabs" role="tablist" aria-label="作品类型">
      <button type="button" role="tab" :aria-selected="activeTab === 'illust'" :class="{ active: activeTab === 'illust' }" @click="switchTab('illust')">插画／动图</button>
      <button type="button" role="tab" :aria-selected="activeTab === 'manga'" :class="{ active: activeTab === 'manga' }" @click="switchTab('manga')">漫画</button>
    </nav>
    <section class="creator-works" aria-label="画师作品">
      <div v-if="current.loading && !current.items.length" class="work-grid" aria-label="正在加载"><div v-for="n in 8" :key="n" class="skeleton-card"><div /><span /><small /></div></div>
      <div v-else-if="current.error && !current.items.length" class="creator-error" role="alert">
        <Icon name="warning" :size="32" />
        <p>{{ current.error }}</p>
        <button class="button tonal" @click="loadWorks(activeTab, true)">重试</button>
      </div>
      <div v-else-if="!current.items.length" class="creator-empty"><Icon name="images" :size="40" /><p>这位画师还没有{{ activeTab === 'manga' ? '漫画' : '插画' }}作品。</p></div>
      <div v-else class="work-grid">
        <WorkCard v-for="work in current.items" :key="work.id" :work="work" :cloud-enabled="cloudEnabled" @open="openWork" @open-author="openAuthor" @favorite="toggleFavorite" @cloud-favorite="toggleCloudFavorite" />
      </div>
      <div v-if="current.items.length" class="load-more">
        <button v-if="current.cursor" class="button text small" :disabled="current.loading" @click="retryMore"><Icon name="refresh" :class="{ spinning: current.loading }" :size="18" />{{ current.loading ? '正在加载更多…' : current.moreFailed ? '加载失败，点击重试' : '继续向下滚动，自动加载更多' }}</button>
        <span v-else class="load-status">已加载全部 {{ current.items.length }} 组作品</span>
        <div ref="sentinel" class="scroll-sentinel" aria-hidden="true"></div>
      </div>
    </section>
    <AppNotice :notice="toast" @dismiss="dismiss" @action="runAction" />
  </div>
</template>

<style scoped>
.creator-page { min-height: 100vh; padding: 0 24px 48px; }
.creator-topbar { display: flex; align-items: center; gap: 12px; padding: 16px 0; }
.creator-topbar h1 { margin: 0; font-size: 17px; }
.creator-loading, .creator-error, .creator-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 16px; color: var(--muted); text-align: center; }
.creator-error-actions { display: flex; gap: 8px; }
.creator-hero { overflow: hidden; border: 1px solid var(--outline); border-radius: 16px; background: var(--card); }
.creator-background img { display: block; width: 100%; max-height: 200px; object-fit: cover; }
.creator-identity { display: flex; gap: 16px; padding: 16px; }
.creator-avatar { flex-shrink: 0; width: 84px; height: 84px; overflow: hidden; border-radius: 50%; background: var(--surface-high); }
.creator-avatar img { width: 100%; height: 100%; object-fit: cover; }
.creator-avatar-placeholder { display: grid; width: 100%; height: 100%; place-items: center; color: var(--muted); }
.creator-copy { min-width: 0; flex: 1; overflow-wrap: break-word; }
.creator-copy h2 { margin: 0; font-size: 18px; overflow-wrap: break-word; }
.creator-account { margin: 4px 0 0; color: var(--muted); font-size: 12px; overflow-wrap: break-word; }
.creator-followed { margin: 6px 0 0; color: var(--primary); font-size: 12px; }
.creator-comment { margin: 8px 0 0; font-size: 12px; white-space: pre-line; overflow-wrap: break-word; }
.creator-stats, .creator-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: 12px; }
.creator-links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: 12px; }
.creator-links a { overflow-wrap: anywhere; }
.creator-workspace { margin-top: 8px; font-size: 12px; }
.creator-workspace dl { margin: 8px 0 0; }
.creator-workspace dl div { display: flex; gap: 8px; padding: 2px 0; }
.creator-workspace dt { flex-shrink: 0; color: var(--muted); }
.creator-workspace dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.creator-tabs { display: flex; gap: 8px; margin: 16px 0; }
.creator-tabs button { padding: 8px 16px; border-radius: 10px; background: var(--surface-high); color: var(--muted); font-size: 13px; }
.creator-tabs button.active { background: var(--primary-container); color: var(--on-container); }
.creator-works .work-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.load-more { margin-top: 16px; text-align: center; }
.load-status { color: var(--muted); font-size: 12px; }
.scroll-sentinel { height: 1px; }
@media (max-width: 700px) {
  .creator-page { padding: 0 12px 40px; }
  .creator-identity { flex-direction: column; }
  .creator-works .work-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px 12px; }
}
</style>
