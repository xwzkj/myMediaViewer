<script setup lang="ts">
import { ref, computed, onActivated, onDeactivated, onMounted, onUnmounted, watch, watchEffect, nextTick } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import type { LibraryStatus, PixivSearchResponse, PixivSearchSuggestionsResponse, PixivStatus, PixivUserSearchResponse, PixivUserSummary, TagSuggestionsResponse, Work, WorksResponse } from '../../shared/types'
import { activeSearchToken, replaceWithTag, replaceTrailingSearchToken, trailingSearchToken } from '../../shared/search-query'
import { isPixivSearchTarget, pixivSearchTargets } from '../../shared/pixiv-search'
import { api, formatNumber } from '../api'
import { appEvents, type PixivAuthChangedPayload, type PixivBookmarkSyncedPayload, type WorkReturnPayload } from '../events'
import { createSearchSessionId } from '../route-cache-key'
import { pushPage, replacePage } from '../navigation'
import { usePageRoute } from '../use-page-route'
import { createMirrorUpdateTracker } from '../mirror-update-tracker'
import { watchLibraryMemory } from '../library-memory'
import { releaseLibrarySession, retainLibrarySession, setLibraryLoader, syncLibrarySession, getLibrarySession } from '../library-session'
import { asCloudSearchEntity, migrateLegacyLibraryState, readLibraryState, writeLibraryState, type CloudSearchEntity, type LibraryWorksState, type LocalSearchState, type SearchSource } from '../library-state'
import Icon from '../components/Icon.vue'
import AppNotice from '../components/AppNotice.vue'
import { useNotice } from '../use-notice'
import WorkCard from '../components/WorkCard.vue'
import PixivUserCard from '../components/PixivUserCard.vue'

defineOptions({ name: 'LibraryView' })

const router = useRouter()
// helper 自身快照：失活后只读自己的快照，不读别的页面的 mode/query。
const { route: pageRoute, active: pageActive, pageKey } = usePageRoute()
const route = pageRoute
// 每个列表路由由独立的 KeepAlive 实例负责，搜索页按 pid 独立缓存。
const pagePath = ref(route.value.fullPath)
const pendingWorkId = ref('')
let pendingScrollToken = 0
// 普通返回滚动记忆：离开列表前记 scrollY，回来无 changed 锚时恢复；
// changed 锚定位成功即同步更新，避免普通恢复覆盖锚点。
const savedScrollY = ref(0)
const status = ref<LibraryStatus | null>(null)
// 媒体库、本地搜索、云搜索分别记忆；搜索排序不得再覆盖媒体库排序。
migrateLegacyLibraryState()
const initialWorks = readLibraryState('works')
const view = ref<'library' | 'favorites'>(initialWorks.view)
const source = ref(initialWorks.source.startsWith('pixiv:') ? '' : initialWorks.source)
const kind = ref(initialWorks.kind)
const query = ref('')
const submittedQuery = ref('')
const sort = ref<'newest' | 'oldest' | 'title' | 'random' | 'relevance'>(initialWorks.sort)
// 随机顺序用 seed 固定这一次的乱序结果，翻页不会重复或漏作品；换一批就换一个 seed。
const seed = ref(initialWorks.seed || String(Date.now()))
// 排序依据：收藏时间（文件名开头的 bmk_id）或发布时间，默认按收藏顺序。
const order = ref(initialWorks.order)
const fuzzy = ref(initialWorks.fuzzy)
const searchSource = ref<SearchSource>('local')
const cloudSort = ref(readLibraryState('cloudSearch').sort)
const cloudTarget = ref(readLibraryState('cloudSearch').target)
const cloudTargetLabel = computed(() => pixivSearchTargets.find(target => target.value === cloudTarget.value)!.label)
const cloudFavoritesRestrict = ref(readLibraryState('cloudFavorites').restrict)
const cloudEntity = ref<CloudSearchEntity>(readLibraryState('cloudSearch').entity)
// users 结果独立分页：不用 Work session、不进 result，避免污染前后作品翻页。
const cloudUsers = ref<PixivUserSummary[]>([])
const cloudUserCursor = ref<string | null>(null)
const cloudUserLoading = ref(false)
const cloudUserMoreFailed = ref(false)
const cloudUserError = ref('')
const cloudUserElapsed = ref(0)
const isUserEntity = computed(() => cloudSearchMode.value && cloudEntity.value === 'users')
const cloudNextCursor = ref<string | null>(null)
const cloudResult = ref<PixivSearchResponse>({ items: [], nextCursor: null, elapsed: 0 })
const pixivStatus = ref<PixivStatus | null>(null)
// auth 变化只标 dirty 手动刷新，不自动重置返回结果。
const cloudDataDirty = ref(false)
const cloudDirtyReason = ref<'auth' | 'mirror' | 'library'>('auth')
const cloudDirtyMessage = computed(() => cloudDirtyReason.value === 'mirror'
  ? '云端收藏镜像有更新，当前列表可能已过期。'
  : cloudDirtyReason.value === 'library' ? '媒体库有更新，当前列表可能已过期。'
    : 'Pixiv 账号状态已变化，当前云端结果可能已过期。')
const mirrorUpdates = createMirrorUpdateTracker()
const cloudEnabled = computed(() => Boolean(pixivStatus.value?.settings.configured && !pixivStatus.value.settings.localMode))
const mirrorRefreshing = ref(false)
const mirrorRefreshMode = ref<'incremental' | 'full' | null>(null)
const currentMirror = computed(() => pixivStatus.value?.mirrors[cloudFavoritesRestrict.value])
const mirrorBusy = computed(() => currentMirror.value?.phase === 'backfilling' || currentMirror.value?.phase === 'maintaining')
const incrementalUpdating = computed(() => mirrorRefreshMode.value === 'incremental' || currentMirror.value?.phase === 'maintaining')
const fullUpdating = computed(() => mirrorRefreshMode.value === 'full' || currentMirror.value?.phase === 'backfilling')
const mirrorStatusText = computed(() => {
  const mirror = currentMirror.value
  if (!mirror || mirror.phase === 'idle') return '尚未同步，可增量更新或全量刷新'
  if (mirror.phase === 'ready') return '镜像已同步'
  if (mirror.phase === 'error') return mirror.error ? `同步失败：${mirror.error}` : '同步失败'
  if (mirror.phase === 'maintaining') return '正在增量更新…'
  return '正在全量刷新…'
})
const cloudSearchMode = computed(() => route.value.name === 'cloudSearch')
const localSearchMode = computed(() => route.value.name === 'search')
const cloudFavoritesMode = computed(() => route.value.name === 'cloudFavorites')
const result = ref<WorksResponse>({ items: [], total: 0, page: 1, pages: 1, elapsed: 0 })
const loading = ref(true)
// 滚动到底部时逐页追加，不再分页浏览。
const loadingMore = ref(false)
const moreFailed = ref(false)
const sentinel = ref<HTMLElement>()
const error = ref('')
const { toast, notice, dismiss, runAction } = useNotice()
const busyFavorites = new Set<string>()
const suggestions = ref<Array<{ name: string; count?: number; translatedName?: string }>>([])
const suggestionTotal = ref(0)
const suggestionOpen = ref(false)
const suggestionIndex = ref(-1)
const searchInput = ref<HTMLInputElement>()
let poll: ReturnType<typeof setInterval>
let controller: AbortController | undefined
let destroyed = false
let refreshInProgress = false
let caret = 0
let suggestionTimer: ReturnType<typeof setTimeout>
let blurTimer: ReturnType<typeof setTimeout>
let suggestionController: AbortController | undefined
let loadQueued = false
let routeInitialized = false
// 实例初次是否已应用 draft：同实例返回不再重置正在编辑的输入。
let draftApplied = false
// 云端在途请求版本：auth 变化时推进，迟到旧响应丢弃不写回。
let cloudRequestVersion = 0
// users 去重：已见作者 id 跨页累积（翻页追加只加新 id）。
// 契约：users 绝不进任何 Work library session——只有组件内 state + in-flight pending，
// 没有作者 prev/next 需求，不做任何 retain/release/setLibraryLoader/sync。
let seenUserIds = new Set<string>()
// repeat-cursor 防御：同一查询串内已见过的游标（服务端坏游标回吐重复页时 sentinel
// auto 会无穷追加）。只记当前查询串，reset/新 q/auth 清空时一并清空。
let seenUserCursors = new Set<string>()
// 作品 visited：同一查询串内已见作品 id（坏游标回吐重复 items 时 merge 去重）。
// 只记当前查询串，reset/新 q/auth 清空时一并清空。不碰 sync 语义与 loader。
let seenWorkIds = new Set<string>()
// 本实例是否持有 pageKey 会话：users 实例从不 retain，unmount 也不 release。
let sessionRetained = false
const pageCache = new Map<string, WorksResponse>()

// 路由变化会同时触发 route、筛选和来源监听。合并同一轮更新，避免切换来源时
// 先发起旧查询、再被新查询中止，造成明显的等待和闪烁。
function queueLoadWorks(): void {
  if (!pageActive.value || loadQueued) return
  loadQueued = true
  queueMicrotask(() => {
    loadQueued = false
    if (!destroyed && pageActive.value) loadWorks()
  })
}

const suggestionsVisible = computed(() => suggestionOpen.value && suggestions.value.length > 0)
const currentSource = computed(() => status.value?.sources.find(s => s.id === source.value))
const sourceOptions = computed(() => status.value?.sources || [])
// 顶部工具条吸顶后才显示分隔线，滚动时和内容区分开。
const scrolled = ref(false)
function trackScroll() { scrolled.value = window.scrollY > 4 }
// 筛选与排序收进二级菜单，只让搜索行常驻顶部。
const menuOpen = ref(false)
const menu = ref<HTMLElement>()
const menuButton = ref<HTMLElement>()
const filtersActive = computed(() => cloudSearchMode.value ? cloudTarget.value !== 'partial_match_for_tags' : Boolean(kind.value || source.value || fuzzy.value))
function closeMenu(event: PointerEvent | KeyboardEvent) {
  if (event instanceof KeyboardEvent) { if (event.key === 'Escape') menuOpen.value = false; return }
  if (!menuOpen.value) return
  if (event.target instanceof Node && (menu.value?.contains(event.target) || menuButton.value?.contains(event.target))) return
  menuOpen.value = false
}
// 收藏编号只在单个媒体目录内部可比：混合显示时开关停用，自动按发布时间排序。
const mixedSources = computed(() => !source.value && (status.value?.sources.length || 0) > 1)
const effectiveOrder = computed(() => mixedSources.value ? 'published' : order.value)
const timeSortDisabled = computed(() => mixedSources.value || sort.value === 'title' || sort.value === 'relevance' || sort.value === 'random')
const title = computed(() => submittedQuery.value ? '发现你心中的那一张' : view.value === 'favorites' ? '把喜欢，留在身边。' : currentSource.value ? currentSource.value.name : '每一份喜欢，都值得珍藏。')
const caption = computed(() => submittedQuery.value ? cloudSearchMode.value ? (isUserEntity.value ? `正在 Pixiv 作者中寻找「${submittedQuery.value}」` : `按${cloudTargetLabel.value}寻找「${submittedQuery.value}」`) : `正在整个描述、标题、作者与标签中寻找「${submittedQuery.value}」` : view.value === 'favorites' ? '那些让你停下来的瞬间，都在这里。' : '让散落在文件夹里的灵感，在这里重新相遇。')
const hasLibrary = computed(() => Boolean(cloudSearchMode.value || cloudFavoritesMode.value || status.value?.sources.length || (cloudEnabled.value && ((pixivStatus.value?.mirrors.public.items || 0) > 0 || (pixivStatus.value?.mirrors.private.items || 0) > 0))))
// 视频与动图合并成一个筛选，动图在后端按 animation 归类，这里用逗号列表一起取。
const filters = computed<Array<{ id: '' | 'image' | 'video'; label: string; icon: string; count: number }>>(() => [{ id: '', label: '全部', icon: 'gallery', count: status.value?.works || 0 }, { id: 'image', label: '图片', icon: 'image', count: status.value?.images || 0 }, { id: 'video', label: '视频', icon: 'video', count: (status.value?.videos || 0) + (status.value?.animations || 0) }])

// 后台刷新只替换第一页，其余已加载的作品按 id 合并保留，避免打断滚动位置。
function mergeFirstPage(fresh: WorksResponse) {
  const current = result.value
  if (!current.items.length || current.page <= 1) { result.value = fresh; return }
  const freshIds = new Set(fresh.items.map(work => work.id))
  result.value = { ...fresh, page: current.page, items: [...fresh.items, ...current.items.filter(work => !freshIds.has(work.id))] }
}
async function loadPage(target: number, silent = false) {
  controller?.abort()
  const active = new AbortController()
  controller = active
  // 让被中断的请求不会把加载状态留在原地。
  loadingMore.value = false
  moreFailed.value = false
  if (target <= 1) { if (!silent) loading.value = true; error.value = '' } else loadingMore.value = true
  const params = new URLSearchParams({ q: submittedQuery.value, source: source.value, kind: kind.value === 'video' ? 'video,animation' : kind.value, favorites: String(view.value === 'favorites'), page: String(target), sort: sort.value, fuzzy: String(fuzzy.value), by: effectiveOrder.value, seed: seed.value })
  const cacheKey = params.toString()
  if (target === 1 && !silent) {
    const cached = pageCache.get(cacheKey)
    if (cached) {
      result.value = cached
      loading.value = false
      // 后台静默校验，来源切换先显示已有结果，不再被骨架屏阻塞。
      void loadPage(1, true)
      return
    }
  }
  try {
    const response = await api<WorksResponse>(`/works?${params}`, { signal: active.signal })
    if (controller !== active) return
    if (target <= 1) { pageCache.set(cacheKey, response); if (silent) mergeFirstPage(response); else result.value = response }
    else result.value = { ...response, items: [...result.value.items, ...response.items] }
    syncLibrarySession(pageKey, target <= 1 ? result.value : response, target > 1)
  } catch (e) {
    if (active.signal.aborted) return
    if (target <= 1) error.value = (e as Error).message
    else { moreFailed.value = true; notice('加载更多失败，请稍后重试') }
  } finally {
    if (controller === active) { loading.value = false; loadingMore.value = false }
  }
}
async function loadCloudPage(reset = false) {
  controller?.abort()
  const active = new AbortController()
  controller = active
  const version = cloudRequestVersion
  if (reset) { loading.value = true; loadingMore.value = false; cloudNextCursor.value = null; seenWorkIds = new Set<string>(); result.value = { items: [], total: 0, page: 1, pages: 1, elapsed: 0 } }
  else loadingMore.value = true
  error.value = ''
  moreFailed.value = false
  const params = new URLSearchParams({ q: submittedQuery.value, sort: cloudSort.value, target: cloudTarget.value })
  if (!reset && cloudNextCursor.value) params.set('cursor', cloudNextCursor.value)
  try {
    const response = await api<PixivSearchResponse>(`/pixiv/search?${params}`, { signal: active.signal })
    // 迟到旧响应丢弃：auth 变化已推进版本，不写回当前列表。
    if (controller !== active || version !== cloudRequestVersion) return
    const nextPage = reset ? 1 : result.value.page + 1
    cloudResult.value = response
    cloudNextCursor.value = response.nextCursor
    // repeat-cursor 坏游标：回吐已见游标时当作无更多（不再 auto 无穷追加）。
    if (cloudNextCursor.value && seenWorkIds.size && seenUserCursors.has(cloudNextCursor.value)) {
      cloudNextCursor.value = null
    } else if (cloudNextCursor.value) {
      seenUserCursors.add(cloudNextCursor.value)
    }
    // 作品 visited merge 去重：坏游标回吐重复 items 时只加新 id。
    // 单 response 内重复 id 也要去重：filter 回调里即 add，同一批第二次出现即过滤。
    const fresh = response.items.filter(item => {
      if (seenWorkIds.has(item.id)) return false
      seenWorkIds.add(item.id)
      return true
    })
    result.value = {
      items: reset ? fresh : [...result.value.items, ...fresh],
      total: (reset ? 0 : result.value.total) + fresh.length,
      page: nextPage,
      pages: cloudNextCursor.value ? nextPage + 1 : nextPage,
      elapsed: response.elapsed,
    }
    syncLibrarySession(pageKey, result.value, false)
  } catch (e) {
    if (active.signal.aborted) return
    if (version !== cloudRequestVersion) return
    const message = (e as Error).message
    if (reset || !result.value.items.length) error.value = message
    else { moreFailed.value = true; if (pageActive.value) notice(`加载更多失败：${message}`) }
  } finally {
    if (controller === active) { loading.value = false; loadingMore.value = false }
  }
}
function switchEntity(entity: CloudSearchEntity) {
  if (entity === cloudEntity.value) return
  if (route.value.name !== 'cloudSearch') return
  // 实体切换 = 新历史实例：保留 q 与输入草稿（query 截 500），不带 sort/target；
  // 敏感参数白名单：只带 q/entity/sid/draft，其余 query 一律不透传。
  // 不 mutate 本实例 cloudEntity：旧实例快照仍是旧 entity，back 回来 watch 无 fullPath
  // 变化不会复原；新页完全从 URL entity 读。记忆可先 write，供下次新搜索用。
  writeLibraryState('cloudSearch', { sort: cloudSort.value, target: cloudTarget.value, entity })
  closeSuggestions()
  void pushPage(router, { name: 'cloudSearch', query: { q: submittedQuery.value, entity, sid: createSearchSessionId(), draft: query.value.slice(0, 500) } })
}

async function loadCloudUsers(reset = false) {
  if (reset) {
    controller?.abort()
    const active = new AbortController()
    controller = active
    cloudRequestVersion++
    const version = cloudRequestVersion
    // 契约：users 只有组件 state + in-flight pending，不进任何 Work session。
    cloudUsers.value = []
    cloudUserCursor.value = null
    cloudUserError.value = ''
    cloudUserElapsed.value = 0
    seenUserIds = new Set<string>()
    seenUserCursors = new Set<string>()
    loading.value = true
    cloudUserLoading.value = true
    cloudUserMoreFailed.value = false
    error.value = ''
    void version
  } else {
    if (cloudUserLoading.value || cloudUserMoreFailed.value || !cloudUserCursor.value) return
    if (loading.value) return
    cloudUserLoading.value = true
    loadingMore.value = true
  }
  const active = controller
  const version = cloudRequestVersion
  const params = new URLSearchParams({ q: submittedQuery.value })
  if (!reset && cloudUserCursor.value) params.set('cursor', cloudUserCursor.value)
  try {
    const response = await api<PixivUserSearchResponse>(`/pixiv/users/search?${params}`, { signal: active?.signal })
    // 迟到旧响应丢弃：auth 变化/新搜索已推进版本，不写回当前列表。
    if (controller !== active || version !== cloudRequestVersion) return
    // users 不进 Work 会话/pageCache：独立作者结果，按 id 去重追加。
    // repeat-cursor 坏游标：回吐已见游标时当作无更多，不再 auto 无穷追加。
    // 单 response 内重复 id 也要去重：filter 回调里即 add。
    const fresh = response.items.filter(user => {
      if (seenUserIds.has(user.id)) return false
      seenUserIds.add(user.id)
      return true
    })
    cloudUsers.value = reset ? fresh : [...cloudUsers.value, ...fresh]
    if (response.nextCursor && seenUserCursors.has(response.nextCursor)) {
      cloudUserCursor.value = null
    } else {
      if (response.nextCursor) seenUserCursors.add(response.nextCursor)
      cloudUserCursor.value = response.nextCursor
    }
    cloudUserElapsed.value = response.elapsed
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    if (controller !== active || version !== cloudRequestVersion) return
    if (reset || !cloudUsers.value.length) {
      cloudUserError.value = (e as Error).message
      error.value = cloudUserError.value
    } else {
      cloudUserMoreFailed.value = true
      moreFailed.value = true
      if (pageActive.value) notice(`加载更多失败：${(e as Error).message}`)
    }
  } finally {
    if (controller === active) {
      cloudUserLoading.value = false
      loading.value = false
      loadingMore.value = false
    }
  }
}

function loadWorks() {
  if (route.value.name === 'cloudSearch') {
    if (isUserEntity.value) void loadCloudUsers(true)
    else void loadCloudPage(true)
    return
  }
  void loadPage(1)
}
async function loadMore(force = false) {
  if (force) {
    moreFailed.value = false
    cloudUserMoreFailed.value = false
  }
  // 在途共享：loading 中再次调用（sentinel/按钮/详情 loader 并发）等待同一轮，
  // 不 early-return 发“最后一组”误报；就绪后再由调用方判断。
  if (loadingMore.value || cloudUserLoading.value) {
    await waitForLoading()
    return
  }
  if (route.value.name === 'cloudSearch' && isUserEntity.value) {
    // users 重试走同一入口：moreFailed 时 force 清标记后放行，永不卡死。
    if (cloudUserMoreFailed.value && !force) return
    if (!cloudUserCursor.value) return
    await loadCloudUsers(false)
    // 用户手势明确：失败必须 throw（保 cursor 可重试），不 silent 吞掉。
    if (cloudUserMoreFailed.value) throw new Error(cloudUserError.value || error.value || '加载更多失败')
    return
  }
  if (loading.value || moreFailed.value) return
  if (route.value.name === 'cloudSearch') {
    if (!cloudNextCursor.value) return
    await loadCloudPage(false)
    if (moreFailed.value) throw new Error(error.value || '加载更多失败')
    return
  }
  if (result.value.page >= result.value.pages) return
  await loadPage(result.value.page + 1)
  if (moreFailed.value) throw new Error(error.value || '加载更多失败')
}
async function refreshStatus() {
  if (refreshInProgress) return
  refreshInProgress = true
  try {
    const previous = status.value?.scan.finishedAt
    const [next, nextPixiv] = await Promise.all([
      api<LibraryStatus>('/status'),
      cloudFavoritesMode.value ? api<PixivStatus>('/pixiv/status').catch(() => null) : Promise.resolve(null),
    ])
    if (destroyed) return
    const mirrorChanged = nextPixiv ? mirrorUpdates.observe(nextPixiv, cloudFavoritesRestrict.value) : false
    status.value = next
    if (nextPixiv) pixivStatus.value = nextPixiv
    if (source.value && !source.value.startsWith('pixiv:') && !next.sources.some(s => s.id === source.value)) {
    source.value = ''
    if (route.value.name === 'source') void replacePage(router, { name: 'library' }, route.value)
  }
    // scan/mirror 变化：只标 dirty 横幅 + active 手动提示，不自动 loadWorks 重置返回数据。
    if (previous !== undefined && previous !== next.scan.finishedAt && !cloudSearchMode.value) {
      cloudDataDirty.value = true
      cloudDirtyReason.value = 'library'
      if (pageActive.value) notice('媒体库有更新，当前列表可能已过期', { label: '重新加载', handler: reloadCloudResults })
    }
    if (mirrorChanged && cloudFavoritesMode.value) {
      cloudDataDirty.value = true
      cloudDirtyReason.value = 'mirror'
      if (pageActive.value) notice('云端收藏镜像有更新，当前列表可能已过期', { label: '重新加载', handler: reloadCloudResults })
    }
  } catch (e) { if (!status.value) error.value = (e as Error).message }
  finally { refreshInProgress = false }
}
async function scan() {
  try { await api('/scan', { method: 'POST' }); await refreshStatus(); notice('正在检查目录中的新增和修改') }
  catch (e) { notice((e as Error).message) }
}
async function refreshPixivStatus() {
  try {
    const next = await api<PixivStatus>('/pixiv/status')
    if (destroyed) return
    pixivStatus.value = next
    // Do not consume update observations here: the polling path owns notifications.
    // Its first successful observation establishes the baseline independently.
  } catch { pixivStatus.value = null }
}
async function refreshCloudMirror(mode: 'incremental' | 'full') {
  if (!cloudEnabled.value || !cloudFavoritesMode.value || mirrorRefreshing.value || mirrorBusy.value) return
  mirrorRefreshing.value = true
  mirrorRefreshMode.value = mode
  try {
    await api(`/pixiv/mirror/${cloudFavoritesRestrict.value}?mode=${mode}`, { method: 'POST' })
    await refreshPixivStatus()
    notice(mode === 'incremental' ? '已开始增量更新 Pixiv 收藏镜像' : '已开始全量刷新 Pixiv 收藏镜像')
  } catch (e) { notice((e as Error).message) }
  finally {
    mirrorRefreshing.value = false
    if (mirrorRefreshMode.value === mode) mirrorRefreshMode.value = null
  }
}
async function toggleFavorite(work: Work) {
  if (busyFavorites.has(work.id)) return
  busyFavorites.add(work.id)
  const next = !work.favorite
  try {
    await api(`/works/${encodeURIComponent(work.id)}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite: next }) })
    work.favorite = next
    for (const item of result.value.items) if (item.id === work.id) item.favorite = next
    void refreshStatus()
    if (view.value === 'favorites') void loadWorks()
    notice(next ? '已加入我的收藏' : '已取消收藏')
  } catch (e) { notice((e as Error).message) }
  finally { busyFavorites.delete(work.id) }
}
async function toggleCloudFavorite(work: Work) {
  const illustId = work.pixivId || work.externalId
  if (!illustId || !cloudEnabled.value) return
  const busyKey = `cloud:${illustId}`
  if (busyFavorites.has(busyKey)) return
  busyFavorites.add(busyKey)
  const next = !(work.cloudBookmark?.bookmarked === true)
  try {
    const response = await api<import('../../shared/types').PixivBookmarkUpdateResult>(`/pixiv/works/${illustId}/bookmark`, { method: 'PUT', body: JSON.stringify({ bookmarked: next }) })
    const update = (item: Work) => {
      if ((item.pixivId || item.externalId) !== illustId) return
      item.cloudBookmark = { bookmarked: response.bookmarked, restrict: response.restrict }
    }
    update(work)
    for (const item of result.value.items) update(item)
    // 广播：详情页/推荐区各自监听同步，不在本页猜别的实例。
    appEvents.emit('pixiv:bookmark-synced', { illustId, bookmarked: response.bookmarked, restrict: response.restrict })
    notice(response.warning || (response.bookmarked ? '已加入 Pixiv 云端收藏' : '已取消 Pixiv 云端收藏'))
  } catch (e) { notice((e as Error).message) }
  finally { busyFavorites.delete(busyKey) }
}
function closeSuggestions() { clearTimeout(suggestionTimer); suggestionController?.abort(); suggestionController = undefined; suggestionOpen.value = false; suggestionIndex.value = -1 }
function blurSuggestions() { clearTimeout(blurTimer); blurTimer = setTimeout(closeSuggestions, 160) }
function queueSuggestions() { closeSuggestions(); suggestions.value = []; suggestionTimer = setTimeout(loadSuggestions, 140) }
async function loadSuggestions() {
  if (isUserEntity.value) return
  suggestionController?.abort()
  const active = new AbortController()
  suggestionController = active
  const target = searchSource.value
  const term = (target === 'cloud' ? trailingSearchToken(query.value) : activeSearchToken(query.value, caret)).value.trim().slice(0, 100)
  const draft = query.value
  if (target === 'cloud' && (!term || !cloudEnabled.value)) return
  try {
    const response = target === 'cloud'
      ? await api<PixivSearchSuggestionsResponse>(`/pixiv/suggestions?q=${encodeURIComponent(term)}`, { signal: active.signal })
      : await api<TagSuggestionsResponse>(`/tags?q=${encodeURIComponent(term)}`, { signal: active.signal })
    if (suggestionController !== active || destroyed || query.value !== draft || searchSource.value !== target || document.activeElement !== searchInput.value) return
    suggestions.value = response.items
    suggestionTotal.value = 'total' in response ? response.total : response.items.length
    suggestionIndex.value = -1
    suggestionOpen.value = response.items.length > 0
  } catch { /* 建议列表不可用时不影响正常搜索 */ }
}
function focusSearch() { clearTimeout(blurTimer); caret = searchInput.value?.selectionStart ?? query.value.length; queueSuggestions() }
function updateCaret(event: Event) {
  const input = event.target as HTMLInputElement
  caret = input.selectionStart ?? input.value.length
  if ((event as InputEvent).isComposing) { closeSuggestions(); return }
  queueSuggestions()
}
function searchKeyup(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape') return
  const input = event.target as HTMLInputElement
  caret = input.selectionStart ?? input.value.length
  queueSuggestions()
}
function moveSuggestion(direction: number) {
  const count = suggestions.value.length
  if (!count) { queueSuggestions(); return }
  const next = suggestionIndex.value + direction
  suggestionIndex.value = next < 0 ? count - 1 : next >= count ? 0 : next
}
function commitSuggestion(position = suggestionIndex.value) {
  const item = suggestions.value[position]
  if (!item) return
  const next = searchSource.value === 'cloud' ? replaceTrailingSearchToken(query.value, item.name) : replaceWithTag(query.value, caret, item.name)
  query.value = next.query
  caret = next.caret
  closeSuggestions()
  void nextTick(() => { searchInput.value?.focus(); searchInput.value?.setSelectionRange(caret, caret); clearTimeout(suggestionTimer) })
}
function clearSearch() { query.value = ''; caret = 0; closeSuggestions(); searchInput.value?.focus() }
function openSettings() {
  void pushPage(router, { name: 'settings', query: { from: route.value.fullPath } })
}
function openWork(work: Work) {
  const name = work.hasLocal === false ? 'cloudWork' : 'work'
  const workId = name === 'cloudWork' ? (work.pixivId || work.externalId) : work.id
  void pushPage(router, { name, params: { workId }, query: { from: route.value.fullPath, list: pageKey } })
}

function openAuthor(work: Work) {
  const userId = work.pixivUserId
  if (!userId) {
    notice('该作品暂无可用的创作者主页')
    return
  }
  void pushPage(router, { name: 'cloudUser', params: { userId }, query: { from: route.value.fullPath } })
}
function routeFilters(extra: Record<string, string> = {}) {
  const next: Record<string, string> = { ...extra }
  if (source.value && !source.value.startsWith('pixiv:')) next.source = source.value
  if (kind.value) next.kind = kind.value
  if (fuzzy.value) next.fuzzy = 'true'
  if (sort.value && sort.value !== 'newest') next.sort = sort.value
  if (order.value === 'published') next.by = 'published'
  if (seed.value) next.seed = seed.value
  return next
}
function searchTarget(value: string, target: SearchSource = 'local') {
  const currentSid = typeof route.value.query.sid === 'string' ? route.value.query.sid : ''
  const sid = (route.value.name === 'search' || route.value.name === 'cloudSearch') && currentSid ? currentSid : createSearchSessionId()
  if (target === 'cloud') {
    // 记忆 entity 只在新提交时用（tab 切换已单独 write）：URL 缺 entity 的旧链接由
    // applyRoute 归一为 works，这里新搜索沿用记忆 entity，保证 tab 与记忆一致。
    const entity = cloudEntity.value
    writeLibraryState('cloudSearch', { sort: cloudSort.value, target: cloudTarget.value, entity })
    return { name: 'cloudSearch' as const, query: { q: value, sort: cloudSort.value, target: cloudTarget.value, entity, sid } }
  }
  const next = routeFilters({ q: value })
  if (route.value.name !== 'search') next.sort = readLibraryState('localSearch').sort
  next.sid = sid
  if (view.value === 'favorites') next.favorites = 'true'
  return { name: 'search' as const, query: next }
}
function submitSearch(event?: KeyboardEvent) {
  if (event?.isComposing || event?.keyCode === 229) return
  event?.preventDefault()
  if (event && suggestionsVisible.value && suggestionIndex.value >= 0) { commitSuggestion(); return }
  const value = query.value.trim()
  closeSuggestions()
  if (!value) {
    if (localSearchMode.value || cloudSearchMode.value) void replacePage(router, listTarget(), route.value)
    return
  }
  if (searchSource.value === 'cloud') {
    if (!cloudEnabled.value) { notice('请先在设置中配置 Pixiv 账号并关闭本地模式'); return }
  }
  const target = searchTarget(value, searchSource.value)
  if (router.resolve(target).fullPath === route.value.fullPath) queueLoadWorks()
  else void pushPage(router, target)
}
function switchSearchMode() {
  const next: SearchSource = searchSource.value === 'local' ? 'cloud' : 'local'
  if (next === 'cloud' && !cloudEnabled.value) { notice('请先在设置中配置 Pixiv 账号并关闭本地模式'); return }
  searchSource.value = next
  closeSuggestions()
  searchInput.value?.focus()
  queueSuggestions()
}
function listTarget() {
  if (view.value === 'favorites') return { name: 'favorites' as const, query: source.value ? { source: source.value } : {} }
  if (source.value.startsWith('pixiv:')) return { name: 'library' as const, query: { source: source.value } }
  if (source.value) return { name: 'source' as const, params: { sourceId: source.value } }
  return { name: 'library' as const }
}
// 路由是页面身份的唯一来源；筛选和排序仍可沿用本地记忆，搜索词由 URL 保存。
function applySubmittedQuery(value: string) {
  if (submittedQuery.value !== value) query.value = value
  submittedQuery.value = value
}
// 云搜索 query 草稿：截 500，随 pushPage 保存；初次进入从 route.query.draft 恢复，
// 同实例返回 applyRoute 不得重置正在编辑的 query。
function readRouteDraft(): string {
  const draft = typeof route.value.query.draft === 'string' ? route.value.query.draft : ''
  return draft.slice(0, 500)
}
function applyRouteDraft() {
  // 同一实例只应用一次 draft：返回时保留用户正在编辑的输入。
  if (draftApplied) return
  draftApplied = true
  const draft = readRouteDraft()
  if (draft && route.value.name === 'cloudSearch') query.value = draft
}
function applyRoute() {
  const name = String(route.value.name || '')
  pagePath.value = route.value.fullPath
  if (name === 'cloudSearch') {
    const memory = readLibraryState('cloudSearch')
    searchSource.value = 'cloud'
    view.value = 'library'
    source.value = ''
    kind.value = ''
    fuzzy.value = false
    applySubmittedQuery(typeof route.value.query.q === 'string' ? route.value.query.q : '')
    cloudSort.value = route.value.query.sort === 'popular_preview' || route.value.query.sort === 'date_desc' || route.value.query.sort === 'date_asc' ? route.value.query.sort : memory.sort
    cloudTarget.value = isPixivSearchTarget(route.value.query.target) ? route.value.query.target : memory.target
    // 契约：URL 缺 entity 永远 works，无 memory 回退；有 entity 才归一。
    // 记忆 entity 只在 searchTarget 新提交与 tab 切换时 write，这里只读 URL。
    cloudEntity.value = asCloudSearchEntity(route.value.query.entity)
    applyRouteDraft()
    return
  }
  if (name === 'cloudFavorites') {
    searchSource.value = 'local'
    view.value = 'library'
    applySubmittedQuery('')
    cloudFavoritesRestrict.value = route.value.query.restrict === 'private' ? 'private' : 'public'
    source.value = `pixiv:${cloudFavoritesRestrict.value}`
    return
  }
  if (name === 'search') {
    const memory = readLibraryState('localSearch')
    searchSource.value = 'local'
    view.value = route.value.query.favorites === 'true' ? 'favorites' : 'library'
    source.value = typeof route.value.query.source === 'string' ? route.value.query.source : memory.source
    kind.value = route.value.query.kind === 'image' || route.value.query.kind === 'video' ? route.value.query.kind : memory.kind
    fuzzy.value = route.value.query.fuzzy === 'true' || (route.value.query.fuzzy !== 'false' && memory.fuzzy)
    sort.value = route.value.query.sort === 'newest' || route.value.query.sort === 'oldest' || route.value.query.sort === 'title' || route.value.query.sort === 'random' || route.value.query.sort === 'relevance'
      ? route.value.query.sort : memory.sort
    order.value = route.value.query.by === 'collected' || route.value.query.by === 'published' ? route.value.query.by : memory.order
    seed.value = typeof route.value.query.seed === 'string' ? route.value.query.seed : (memory.seed || String(Date.now()))
    applySubmittedQuery(typeof route.value.query.q === 'string' ? route.value.query.q : '')
    return
  }
  const memory = readLibraryState('works')
  searchSource.value = 'local'
  view.value = name === 'favorites' ? 'favorites' : 'library'
  source.value = name === 'source'
    ? String(route.value.params.sourceId || '')
    : typeof route.value.query.source === 'string' ? route.value.query.source : memory.source
  if (source.value.startsWith('pixiv:')) {
    const restrict = source.value === 'pixiv:private' ? 'private' : 'public'
    source.value = ''
    void replacePage(router, { name: 'cloudFavorites', query: { restrict } }, route.value)
    return
  }
  kind.value = route.value.query.kind === 'image' || route.value.query.kind === 'video' ? route.value.query.kind : memory.kind
  fuzzy.value = memory.fuzzy
  sort.value = memory.sort
  order.value = memory.order
  seed.value = memory.seed || String(Date.now())
  applySubmittedQuery('')
}
// 切换视图时保留筛选选项；只有显式传入来源才改动来源（传空字符串代表全部来源）。
function navigate(next: 'library' | 'favorites', sourceId?: string) {
  const nextSource = sourceId !== undefined ? sourceId : source.value.startsWith('pixiv:') ? '' : source.value
  if (next === 'favorites') {
    void pushPage(router, { name: 'favorites', query: nextSource ? { source: nextSource } : {} })
    return
  }
  if (nextSource.startsWith('pixiv:')) void pushPage(router, { name: 'library', query: { source: nextSource } })
  else if (nextSource) void pushPage(router, { name: 'source', params: { sourceId: nextSource } })
  else void pushPage(router, { name: 'library' })
}
// 换一批：换一个随机种子，重新打乱这一批作品的顺序。
function reshuffle() { seed.value = String(Date.now()) }
function resetFilters() {
  query.value = ''
  source.value = ''
  kind.value = ''
  fuzzy.value = false
  if (route.value.name === 'search' || route.value.name === 'cloudSearch' || route.value.name === 'source' || route.value.name === 'cloudFavorites') void replacePage(router, { name: view.value === 'favorites' ? 'favorites' : 'library' }, route.value)
}
function retryLoadMore() { loadMore(true) }
watch(() => route.value.fullPath, () => {
  applyRoute()
  if (!routeInitialized || route.value.fullPath !== pagePath.value) queueLoadWorks()
  routeInitialized = true
}, { immediate: true })
watch([view, source, kind, sort, fuzzy, order, seed, cloudSort], () => {
  if (!pageActive.value || route.value.name === 'cloudSearch') return
  queueLoadWorks()
})
watchLibraryMemory(
  () => ({ view: view.value, source: source.value, kind: kind.value, fuzzy: fuzzy.value, order: order.value, seed: seed.value, sort: sort.value }),
  () => route.value.fullPath,
  () => pageActive.value,
  state => {
    if (route.value.name === 'search') writeLibraryState('localSearch', state as LocalSearchState)
    else if (route.value.name !== 'cloudSearch' && route.value.name !== 'cloudFavorites') writeLibraryState('works', state as LibraryWorksState)
  },
)
watch([cloudSort, cloudTarget], ([sort, target]) => {
  if (!pageActive.value) return
  writeLibraryState('cloudSearch', { sort, target, entity: readLibraryState('cloudSearch').entity })
  if (route.value.name === 'cloudSearch' && (route.value.query.sort !== sort || route.value.query.target !== target)) {
    void replacePage(router, { query: { ...route.value.query, sort, target } }, route.value)
  }
})
watch(cloudFavoritesRestrict, value => writeLibraryState('cloudFavorites', { restrict: value }))
// 列表底部进入视野附近时自动追加下一页。失活不断开 observer（KeepAlive 切回瞬间
// 可能触发回调），回调内以 pageActive 门禁；显式 loader 失活也保留供详情续页。
let sentinelObserver: IntersectionObserver | undefined
function bindSentinel() {
  sentinelObserver?.disconnect()
  sentinelObserver = undefined
  const element = sentinel.value
  if (!element || !('IntersectionObserver' in window)) return
  sentinelObserver = new IntersectionObserver(entries => {
    if (!pageActive.value || destroyed) return
    if (entries.some(entry => entry.isIntersecting)) void loadMore()
  }, { rootMargin: '600px 0px' })
  sentinelObserver.observe(element)
}
watchEffect(() => {
  // 依赖 sentinel，建立后交由 bindSentinel 管理生命周期。
  if (sentinel.value) bindSentinel()
})
// 作品页退出时发送待定位作品；列表页等目标进入结果并完成渲染后再滚动。
function handleWorkReturn(payload: WorkReturnPayload) {
  if (payload.returnPath !== pagePath.value) return
  // sourcePid 匹配：只认发往本实例的返回，避免串到别的列表页。
  const ownPid = typeof route.value.query.pid === 'string' ? route.value.query.pid : ''
  if (payload.sourcePid && ownPid && payload.sourcePid !== ownPid) return
  pendingWorkId.value = payload.workId
  if (pageActive.value && route.value.fullPath === pagePath.value) void restorePendingWork()
}
async function waitForLoading() {
  while (loading.value || loadingMore.value) await new Promise(resolve => setTimeout(resolve, 30))
}
async function ensureWorkAvailable(id: string) {
  await waitForLoading()
  if (result.value.items.some(work => work.id === id)) return true
  while (result.value.page < result.value.pages) {
    const previousPage = result.value.page
    await loadMore(true)
    if (result.value.items.some(work => work.id === id)) return true
    if (result.value.page <= previousPage) break
  }
  return false
}
function scrollToPendingWork(id: string, token: number): boolean {
  if (token !== pendingScrollToken || pendingWorkId.value !== id) return false
  const target = Array.from(document.querySelectorAll<HTMLElement>('.work-card[data-work-id]'))
    .find(card => card.dataset.workId === id)
  if (!target) return false
  target.scrollIntoView({ block: 'center', behavior: 'auto' })
  pendingWorkId.value = ''
  // changed 锚优先：定位成功即清 saved 记忆，避免普通恢复再覆盖锚点。
  savedScrollY.value = window.scrollY
  return true
}
function scheduleScrollToPendingWork(id: string, token: number): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { scrollToPendingWork(id, token) })
  })
}
async function restorePendingWork() {
  const id = pendingWorkId.value
  if (!id || !pageActive.value || route.value.fullPath !== pagePath.value) return
  const token = ++pendingScrollToken
  // 返回列表时，已加载过的卡片通常已经在 DOM 里。先直接定位，不要等后台刷新/加载状态结束。
  if (result.value.items.some(work => work.id === id)) {
    await nextTick()
    scheduleScrollToPendingWork(id, token)
    return
  }
  const available = await ensureWorkAvailable(id)
  if (token !== pendingScrollToken || pendingWorkId.value !== id) return
  if (!available) {
    pendingWorkId.value = ''
    return
  }
  await nextTick()
  scheduleScrollToPendingWork(id, token)
}
function startPolling() {
  clearInterval(poll)
  poll = setInterval(refreshStatus, 2000)
}
function bindGlobalListeners() {
  window.addEventListener('scroll', trackScroll, { passive: true })
  document.addEventListener('pointerdown', closeMenu)
  document.addEventListener('keydown', closeMenu)
}
function unbindGlobalListeners() {
  window.removeEventListener('scroll', trackScroll)
  document.removeEventListener('pointerdown', closeMenu)
  document.removeEventListener('keydown', closeMenu)
}
// 云端 tab：作品/作者切换 push 新 pid，保留 q 与输入草稿；users 不带 sort/target。
function openCloudEntity(entity: CloudSearchEntity) {
  if (entity === cloudEntity.value || route.value.name !== 'cloudSearch') return
  closeSuggestions()
  switchEntity(entity)
}
function openUser(user: PixivUserSummary) {
  void pushPage(router, { name: 'cloudUser', params: { userId: user.id }, query: { from: route.value.fullPath } })
}
function handleAuthChanged(payload: PixivAuthChangedPayload) {
  const previous = pixivStatus.value
  const previousAccount = previous?.settings.account?.id || ''
  const nextAccount = payload.accountId || ''
  // 无旧状态时只同步新状态，不标 dirty（首屏本来就要加载）。
  if (!previous) return
  // 账号/登出/localMode 变化：在途云端请求全部作废，迟到响应不再写回。
  if (previous.settings.configured !== payload.configured || previous.settings.localMode !== payload.localMode || previousAccount !== nextAccount) {
    pixivStatus.value = null
    mirrorUpdates.reset()
    cloudDirtyReason.value = 'auth'
    cloudRequestVersion++
    controller?.abort()
    cloudUserLoading.value = false
    loadingMore.value = false
    // 换账号瞬间即清云端展示：旧 items 可点会泄露旧账号数据，先清空再 dirty。
    // 清：云作品 result、云作者 users、翻页游标、去重视 visited、pageCache、
    // Work 会话 items（保留会话/loader 供返回续页，只清数据）。
    result.value = { items: [], total: 0, page: 1, pages: 1, elapsed: 0 }
    cloudResult.value = { items: [], nextCursor: null, elapsed: 0 }
    cloudNextCursor.value = null
    cloudUsers.value = []
    cloudUserCursor.value = null
    cloudUserError.value = ''
    cloudUserElapsed.value = 0
    seenUserIds = new Set<string>()
    seenUserCursors = new Set<string>()
    seenWorkIds = new Set<string>()
    error.value = ''
    moreFailed.value = false
    cloudUserMoreFailed.value = false
    pageCache.clear()
    const session = getLibrarySession(pageKey)
    if (session) {
      session.items = []
      session.total = 0
      session.page = 1
      session.pages = 1
    }
    cloudDataDirty.value = true
    if (pageActive.value && (cloudSearchMode.value || cloudFavoritesMode.value)) {
      notice('Pixiv 账号状态已变化，云端结果已清空', { label: '重新加载', handler: () => { void reloadCloudResults() } })
    }
  }
}
// dirty banner 手动刷新：只当 active 点 action；inactive 只标 dirty，回来手动点。
function reloadCloudResults() {
  cloudDataDirty.value = false
  if (!pageActive.value) return
  loadWorks()
}
function handleBookmarkSynced(payload: PixivBookmarkSyncedPayload) {
  const update = (item: Work) => {
    if ((item.pixivId || item.externalId) !== payload.illustId) return
    item.cloudBookmark = { bookmarked: payload.bookmarked, restrict: payload.restrict }
  }
  for (const item of result.value.items) update(item)
}
// 云端收藏入口：新页 push（发新 pid），同页 public/private 切换 replace。
function openCloudFavorites(restrict: 'public' | 'private') {
  if (route.value.name === 'cloudFavorites') {
    if (cloudFavoritesRestrict.value === restrict) return
    cloudFavoritesRestrict.value = restrict
    void replacePage(router, { name: 'cloudFavorites', query: { restrict } }, route.value)
    return
  }
  void pushPage(router, { name: 'cloudFavorites', query: { restrict } })
}
function switchCloudFavorites(restrict: 'public' | 'private') {
  if (route.value.name === 'cloudFavorites') {
    if (cloudFavoritesRestrict.value === restrict) return
    cloudFavoritesRestrict.value = restrict
    void replacePage(router, { name: 'cloudFavorites', query: { restrict } }, route.value)
  } else {
    void pushPage(router, { name: 'cloudFavorites', query: { restrict } })
  }
}
onMounted(() => {
  appEvents.on('work:return', handleWorkReturn)
  appEvents.on('pixiv:auth-changed', handleAuthChanged)
  appEvents.on('pixiv:bookmark-synced', handleBookmarkSynced)
  // 契约：users 绝不 retain Work 会话/loader；works/search/favorites 才持有 pageKey。
  // held loader 闭包：force 重试 + 失败 throw（不 silent），供详情 inactive 续页；
  // loader 内不 notice（inactive 也会调），失败由调用方按 active 决定提示。
  // 只 abort 当前在途，不禁 future：unmount 才 abort，held 闭包之后仍可继续。
  if (!isUserEntity.value) {
    retainLibrarySession(pageKey)
    setLibraryLoader(pageKey, async () => {
      await loadMore(true)
      if (moreFailed.value) throw new Error(error.value || '加载更多失败')
    })
    sessionRetained = true
  }
  void refreshStatus()
  void refreshPixivStatus()
  startPolling()
  bindGlobalListeners()
  trackScroll()
})
// KeepAlive 离开列表时暂停轮询和全局监听，回到列表时继续，避免后台页面重复请求。
// inactive 期间的 auth dirty：回来自动 reload（带 banner 可手动），不静默留空。
onActivated(() => {
  bindGlobalListeners()
  startPolling()
  if (cloudDataDirty.value && (cloudSearchMode.value || cloudFavoritesMode.value)) {
    reloadCloudResults()
  }
  // 普通返回（无 changed 锚）：恢复离开前记下的滚动；有锚时 restorePendingWork
  // 定位成功会同步更新 savedScrollY，不会被这里覆盖（先锚后普通）。
  void restorePendingWork()
  if (!pendingWorkId.value && savedScrollY.value > 0) {
    const targetY = savedScrollY.value
    void nextTick(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { window.scrollTo(0, targetY) })
      })
    })
  }
  void refreshStatus()
  void refreshPixivStatus()
})
// 离开列表前记滚动：详情返回时 router scrollBehavior 对 work 返回 false，
// 由本页统一恢复（changed 锚优先，普通恢复兜底）。
onBeforeRouteLeave(() => {
  savedScrollY.value = window.scrollY
})
onDeactivated(() => {
  dismiss()
  closeSuggestions()
  clearTimeout(blurTimer)
  unbindGlobalListeners()
  clearInterval(poll)
})
onUnmounted(() => {
  destroyed = true
  // 来源卸载只释 owner，不清 held loader：详情仍持有时 loader 保持 fetch 能力，
  // 0 owner 才由 release 删 session。loader 闭包只读快照参数，不依赖 destroyed。
  // users 实例从未 retain，这里也不 release，避免把别人的 0-owner 会话误删。
  if (sessionRetained) {
    releaseLibrarySession(pageKey)
    sessionRetained = false
  }
  appEvents.off('work:return', handleWorkReturn)
  appEvents.off('pixiv:auth-changed', handleAuthChanged)
  appEvents.off('pixiv:bookmark-synced', handleBookmarkSynced)
  unbindGlobalListeners()
  clearInterval(poll)
  clearTimeout(suggestionTimer)
  clearTimeout(blurTimer)
  controller?.abort()
  suggestionController?.abort()
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="navigate('library')"><span class="brand-mark"><Icon name="gallery" :size="26" /></span><div><strong>拾光</strong><small>MEDIA GARDEN</small></div></a>
      <button class="button filled add-folder" aria-label="添加媒体目录" title="添加媒体目录" @click="openSettings"><Icon name="plus" :size="21" /><span>添加媒体目录</span></button>
      <span class="nav-label">我的空间</span>
      <nav aria-label="主导航"><button class="nav-item" :class="{ active: view === 'library' && !source && !cloudFavoritesMode }" @click="navigate('library', '')"><Icon name="gallery" /><span>媒体库</span><span class="nav-count">{{ formatNumber(status?.works || 0) }}</span></button><button class="nav-item" :class="{ active: view === 'favorites' }" @click="navigate('favorites')"><Icon :name="view === 'favorites' ? 'heart-filled' : 'heart'" /><span>我的收藏</span><span class="nav-count">{{ formatNumber(status?.favorites || 0) }}</span></button><button class="nav-item" :class="{ active: cloudFavoritesMode }" :disabled="!cloudEnabled" :title="cloudEnabled ? '查看 Pixiv 云端收藏' : '请先配置 Pixiv 账号并关闭本地模式'" @click="openCloudFavorites(cloudFavoritesRestrict)"><Icon name="cloud" /><span>云端收藏</span></button></nav>
      <div class="nav-label row-label"><span>媒体来源</span><button class="icon-button tiny" aria-label="管理媒体来源" @click="openSettings"><Icon name="plus" :size="17" /></button></div>
      <nav class="source-nav" aria-label="媒体来源"><button v-for="item in sourceOptions" :key="item.id" class="nav-item source-nav-item" :class="{ active: source === item.id }" @click="navigate('library', item.id)"><span class="source-letter" :class="item.kind">{{ item.name.slice(0, 1).toUpperCase() }}</span><span class="ellipsis">{{ item.name }}</span><span v-if="'online' in item && !item.online" title="目录离线"><Icon name="offline" :size="17" /></span><span v-else-if="'works' in item" class="nav-count">{{ item.works }}</span></button><p v-if="!status?.sources.length" class="nav-empty">添加文件夹后，会显示在这里。</p></nav>
      <div class="sidebar-bottom"><button class="nav-item" @click="openSettings"><Icon name="settings" /><span>媒体库设置</span></button></div>
    </aside>
    <main class="main-content">
      <div class="library-toolbar" :class="{ stuck: scrolled }">
        <div class="search-row">
          <div class="search-field">
            <button class="search-mode-toggle" :class="{ cloud: searchSource === 'cloud' }" type="button" :aria-label="searchSource === 'cloud' ? '切换到本地搜索' : '切换到云搜索'" :title="searchSource === 'cloud' ? '切换到本地搜索' : '切换到云搜索'" @click="switchSearchMode"><Icon :name="searchSource === 'cloud' ? 'cloud' : 'folder'" :size="19" /><span>{{ searchSource === 'cloud' ? '云端' : '本地' }}</span><Icon name="swap" :size="16" /></button>
            <input ref="searchInput" v-model="query" type="text" :aria-label="searchSource === 'cloud' ? (isUserEntity ? '云搜索作者' : '云搜索作品') : '搜索作品'" :placeholder="searchSource === 'cloud' ? (isUserEntity ? '输入作者名，按 Enter 搜索…' : '输入关键词，按 Enter 搜索…') : '搜索标题、描述、作者或标签…'" maxlength="500" role="combobox" aria-autocomplete="list" aria-controls="tag-suggestions" :aria-expanded="suggestionsVisible" :aria-activedescendant="suggestionsVisible && suggestionIndex >= 0 ? 'tag-suggestion-' + suggestionIndex : undefined" @focus="focusSearch" @input="updateCaret" @click="updateCaret" @keyup="searchKeyup" @keydown.down.prevent="moveSuggestion(1)" @keydown.up.prevent="moveSuggestion(-1)" @keydown.enter="submitSearch" @keydown.esc="closeSuggestions" @blur="blurSuggestions" />
            <button v-if="query" class="icon-button small-icon" type="button" aria-label="清空搜索" @click="clearSearch"><Icon name="close" :size="19" /></button>
            <button class="search-submit" type="button" aria-label="执行搜索" title="搜索（Enter）" @click="submitSearch()"><Icon name="search" :size="22" /></button>
            <div v-if="suggestionsVisible" id="tag-suggestions" class="tag-suggestions" role="listbox" aria-label="标签搜索建议"><div class="suggestion-heading"><Icon name="tag" :size="15" /><span>{{ searchSource === 'cloud' ? '云搜索建议' : '按标签搜索' }}</span><b v-if="suggestionTotal > suggestions.length">还有 {{ formatNumber(suggestionTotal - suggestions.length) }} 个匹配标签</b></div><button v-for="(item, i) in suggestions" :id="'tag-suggestion-' + i" :key="item.name" type="button" class="tag-suggestion" :class="{ active: i === suggestionIndex }" role="option" :aria-selected="i === suggestionIndex" @mousedown.prevent @click="commitSuggestion(i)" @mouseenter="suggestionIndex = i"><span>{{ searchSource === 'cloud' ? item.name : '#' + item.name }}</span><small v-if="searchSource === 'local'">{{ formatNumber(item.count || 0) }} 组</small><small v-else-if="item.translatedName && item.translatedName !== item.name">{{ item.translatedName }}</small></button></div>
          </div>
          <!-- users 实体无任何筛选/排序功能：整个按钮隐藏，不留空菜单 -->
          <button v-if="!isUserEntity" ref="menuButton" class="icon-button menu-button" :class="{ active: filtersActive }" :aria-expanded="menuOpen" aria-haspopup="true" :title="filtersActive ? '筛选与排序（已应用筛选）' : '筛选与排序'" @click="menuOpen = !menuOpen"><Icon name="tune" :size="21" /><span v-if="filtersActive" class="menu-dot" /></button>
        </div>
        <Transition v-if="!isUserEntity" name="menu-pop"><div v-if="menuOpen" ref="menu" class="filter-menu" role="dialog" aria-label="筛选与排序">
          <label v-if="!cloudSearchMode && !cloudFavoritesMode && sourceOptions.length > 1" class="menu-row"><span>来源</span><span class="menu-select"><select v-model="source" aria-label="筛选媒体来源"><option value="">全部来源</option><option v-for="item in sourceOptions" :key="item.id" :value="item.id">{{ item.name }}</option></select><Icon name="down" :size="16" /></span></label>
          <div v-if="!isUserEntity" class="menu-row"><span>媒体类型</span><div class="menu-chips"><button v-for="filter in filters" :key="filter.id" class="filter-chip" :class="{ active: kind === filter.id }" :aria-pressed="kind === filter.id" @click="kind = filter.id"><Icon :name="kind === filter.id ? 'check' : filter.icon" :size="18" />{{ filter.label }}</button></div></div>
          <label v-if="!cloudSearchMode" class="menu-row"><span>模糊匹配</span><span class="fuzzy-toggle"><input v-model="fuzzy" type="checkbox" /><span class="mini-switch" /><span>{{ fuzzy ? '已开启' : '已关闭' }}</span></span></label>
          <label v-if="cloudSearchMode && !isUserEntity" class="menu-row"><span>匹配规则</span><span class="menu-select"><select v-model="cloudTarget" aria-label="云搜索匹配规则"><option v-for="target in pixivSearchTargets" :key="target.value" :value="target.value">{{ target.label }}</option></select><Icon name="down" :size="16" /></span></label>
          <label class="menu-row"><span>排序方式</span><span class="sort-select"><Icon name="sort" :size="18" /><select v-if="cloudSearchMode && !isUserEntity" v-model="cloudSort" aria-label="云搜索排序"><option value="popular_preview">热度预览</option><option value="date_desc">最新优先</option><option value="date_asc">最早优先</option></select><select v-else-if="!isUserEntity" v-model="sort" aria-label="排序方式"><option v-if="localSearchMode && submittedQuery" value="relevance">相关度优先</option><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="title">标题排序</option><option value="random">随机顺序</option></select><Icon name="down" :size="16" /></span></label>
          <label v-if="sort === 'random' && !cloudSearchMode" class="menu-row"><span>换一批</span><button class="button tonal small" type="button" @click="reshuffle"><Icon name="refresh" :size="17" />重新打乱</button></label>
          <label v-if="!cloudSearchMode && !isUserEntity" class="menu-row" :class="{ dim: timeSortDisabled }"><span>时间依据</span><span class="fuzzy-toggle order-toggle"><input v-model="order" type="checkbox" true-value="collected" false-value="published" :disabled="timeSortDisabled" /><span class="mini-switch" /><span>{{ effectiveOrder === 'collected' ? '收藏时间' : '发布时间' }}</span></span></label>
          <label v-if="!isUserEntity" class="menu-row menu-action-row"><span>媒体库索引</span><button class="button tonal small" type="button" :disabled="status?.scan.running || !hasLibrary" @click="scan"><Icon name="refresh" :class="{ spinning: status?.scan.running }" :size="17" />{{ status?.scan.running ? '正在扫描' : '刷新媒体库' }}</button></label>
        </div></Transition>
      </div>
      <!-- hero-meta 是本地库统计（组作品/目录数）：users 下隐藏，避免假关联 -->
      <section class="hero"><div class="hero-copy"><span class="eyebrow"><span class="short-line" />{{ view === 'favorites' ? 'YOUR FAVORITE MOMENTS' : 'A HOME FOR YOUR INSPIRATION' }}</span><h1>{{ title }}</h1><p>{{ caption }}</p><div v-if="!isUserEntity" class="hero-meta"><span><strong>{{ formatNumber(view === 'favorites' ? status?.favorites || 0 : currentSource?.works || status?.works || 0) }}</strong> 组作品</span><span class="dot-separator">·</span><span>{{ status?.sources.length || 0 }} 个媒体目录</span><span v-if="hasLibrary" class="hero-status"><Icon :name="status?.scan.running ? 'refresh' : 'check'" :class="{ spinning: status?.scan.running }" :size="15" />{{ status?.scan.running ? '正在整理' : '收藏随时可见' }}</span></div></div><div class="hero-illustration" aria-hidden="true"><div class="orbit orbit-one" /><div class="orbit orbit-two" /><div class="illustration-card back"><Icon name="video" :size="30" /></div><div class="illustration-card middle"><Icon name="leaf" :size="40" /></div><div class="illustration-card front"><div class="little-sun" /><div class="little-hill hill-one" /><div class="little-hill hill-two" /></div><span class="illustration-sparkle">✦</span><span class="illustration-dot" /></div></section>
      <section class="library-content" :aria-label="isUserEntity ? '作者列表' : '作品列表'">
        <div v-if="status?.scan.running" class="scan-progress" role="status"><div class="indeterminate-bar" /><span>{{ status.scan.phase }}<b>{{ formatNumber(status.scan.files) }} 个文件</b></span></div>
        <div v-if="status?.scan.errors.length && !status.scan.running" class="warning-banner"><Icon name="warning" :size="20" /><span>部分目录或描述未能读取，已有索引已保留。</span><button class="button text small" @click="openSettings">查看详情</button></div>
        <div v-if="cloudFavoritesMode" class="cloud-favorite-tabs" role="tablist" aria-label="Pixiv 收藏可见性"><button type="button" role="tab" :aria-selected="cloudFavoritesRestrict === 'public'" :class="{ active: cloudFavoritesRestrict === 'public' }" @click="switchCloudFavorites('public')">公开收藏</button><button type="button" role="tab" :aria-selected="cloudFavoritesRestrict === 'private'" :class="{ active: cloudFavoritesRestrict === 'private' }" @click="switchCloudFavorites('private')">私密收藏</button><span class="cloud-mirror-actions"><button type="button" class="cloud-mirror-refresh" :disabled="!cloudEnabled || mirrorRefreshing || mirrorBusy" @click="refreshCloudMirror('incremental')"><Icon name="refresh" :class="{ spinning: incrementalUpdating }" :size="16" />{{ incrementalUpdating ? '正在增量' : '增量更新' }}</button><button type="button" class="cloud-mirror-refresh" :disabled="!cloudEnabled || mirrorRefreshing || mirrorBusy" @click="refreshCloudMirror('full')"><Icon name="cloud" :size="16" />{{ fullUpdating ? '正在全量' : '全量刷新' }}</button></span></div>
        <div v-if="cloudDataDirty && (cloudSearchMode || cloudFavoritesMode)" class="dirty-banner" role="status"><Icon name="warning" :size="18" /><span>{{ cloudDirtyMessage }}</span><button class="button tonal small" type="button" @click="reloadCloudResults">重新加载</button></div>
        <div v-if="cloudSearchMode" class="cloud-entity-tabs" role="tablist" aria-label="云搜索维度"><button type="button" role="tab" :aria-selected="cloudEntity === 'works'" :class="{ active: cloudEntity === 'works' }" @click="openCloudEntity('works')">作品</button><button type="button" role="tab" :aria-selected="cloudEntity === 'users'" :class="{ active: cloudEntity === 'users' }" @click="openCloudEntity('users')">作者</button></div>
        <div class="results-heading"><h2>{{ cloudSearchMode ? (isUserEntity ? 'Pixiv 作者搜索' : 'Pixiv 云搜索') : cloudFavoritesMode ? (cloudFavoritesRestrict === 'private' ? 'Pixiv 私密收藏' : 'Pixiv 公开收藏') : submittedQuery ? '搜索结果' : view === 'favorites' ? '我的收藏' : currentSource?.name || '全部作品' }}<span>{{ formatNumber(isUserEntity ? cloudUsers.length : result.total) }}</span></h2><span v-if="cloudSearchMode && isUserEntity && !cloudUserLoading" class="results-note">已加载 {{ formatNumber(cloudUsers.length) }} 位作者 · {{ cloudUserElapsed }} ms</span><span v-else-if="cloudSearchMode && isUserEntity" class="results-note">正在搜索作者…</span><span v-else-if="cloudSearchMode && !isUserEntity && !loading" class="results-note">{{ cloudTargetLabel }} · {{ cloudSort === 'date_desc' ? '最新优先' : cloudSort === 'date_asc' ? '最早优先' : '热度预览' }} · {{ result.elapsed }} ms</span><span v-else-if="cloudSearchMode" class="results-note">正在搜索作品…</span><span v-else-if="cloudFavoritesMode" class="results-note" :title="currentMirror?.error || mirrorStatusText">{{ mirrorStatusText }} · {{ formatNumber(currentMirror?.items || result.total) }} 组</span><span v-else-if="submittedQuery && !loading" class="results-note">{{ result.elapsed }} ms · 支持简繁体与拼音</span><span v-else-if="submittedQuery" class="results-note">正在搜索…</span><span v-else class="results-note">{{ kind ? ({ image: '静止的画面，无限的想象', video: '按下播放，让故事继续', animation: '让灵感动起来' }[kind]) : '灵感，在这里慢慢生长' }}</span></div>
        <div v-if="cloudSearchMode && isUserEntity" class="user-results" aria-label="作者搜索结果">
          <div v-if="cloudUserError" class="empty-state error-state"><span class="empty-symbol"><Icon name="warning" :size="38" /></span><h3>暂时无法搜索作者</h3><p>{{ cloudUserError }}</p><button class="button filled" @click="loadCloudUsers(true)">重新搜索</button></div>
          <div v-else-if="cloudUserLoading && !cloudUsers.length" class="work-grid" aria-label="正在加载"><div v-for="n in 8" :key="n" class="skeleton-card"><div /><span /><small /></div></div>
          <div v-else-if="!cloudUsers.length" class="empty-state"><span class="empty-symbol"><Icon name="search" :size="40" /></span><h3>还没有找到相关作者</h3><p>试试更短的关键词。</p></div>
          <div v-else class="work-grid"><PixivUserCard v-for="user in cloudUsers" :key="user.id" :user="user" @open="openUser" /></div>
          <div v-if="cloudUsers.length" class="load-more">
            <button v-if="cloudUserCursor" class="button text small" :disabled="cloudUserLoading" @click="loadMore(true)"><Icon name="refresh" :class="{ spinning: cloudUserLoading }" :size="18" />{{ cloudUserLoading ? '正在加载更多…' : cloudUserMoreFailed ? '加载失败，点击重试' : '继续向下滚动，自动加载更多' }}</button>
            <span v-else class="load-status">已加载 {{ formatNumber(cloudUsers.length) }} 位作者</span>
            <div ref="sentinel" class="scroll-sentinel" aria-hidden="true"></div>
          </div>
        </div>
        <template v-else>
        <div v-if="error" class="empty-state error-state"><span class="empty-symbol"><Icon name="warning" :size="38" /></span><h3>暂时无法连接媒体库</h3><p>{{ error }}</p><button class="button filled" @click="refreshStatus(); loadWorks()">重新连接</button></div>
        <div v-else-if="loading && !result.items.length" class="work-grid" aria-label="正在加载"><div v-for="n in 8" :key="n" class="skeleton-card"><div /><span /><small /></div></div>
        <div v-else-if="!hasLibrary" class="empty-state welcome-state"><div class="empty-art"><Icon name="folder-plus" :size="54" /><span>✦</span></div><span class="eyebrow">YOUR COLLECTION STARTS HERE</span><h3>给你的喜欢，一个家。</h3><p>添加存放图片和视频的文件夹，<br />拾光会自动将同组作品整理在一起。</p><button class="button filled" @click="openSettings"><Icon name="plus" :size="20" />添加第一个媒体目录</button><div class="welcome-features"><span><Icon name="images" :size="17" />自动分组</span><span><Icon name="search" :size="17" />描述搜索</span><span><Icon name="heart" :size="17" />跨设备收藏</span></div></div>
        <div v-else-if="!result.items.length" class="empty-state"><span class="empty-symbol"><Icon :name="submittedQuery ? 'search' : view === 'favorites' ? 'heart' : 'images'" :size="40" /></span><h3>{{ status?.scan.running ? '正在整理你的第一批作品' : submittedQuery ? '还没有找到相关作品' : view === 'favorites' ? '留一点位置，给心动的作品' : '这里还没有作品' }}</h3><p>{{ status?.scan.running ? '扫描完成后，作品会自动出现在这里。' : submittedQuery ? '试试更短的关键词，或开启模糊匹配。' : view === 'favorites' ? '点击作品卡片上的爱心，就能在这里找到它。' : '检查分组规则，或调整筛选条件再看看。' }}</p><button v-if="submittedQuery || kind || source" class="button tonal" @click="resetFilters">清除筛选</button><button v-else-if="!status?.scan.running && view !== 'favorites'" class="button tonal" @click="openSettings">检查媒体目录</button></div>
        <div v-else class="work-grid" :class="{ refreshing: loading }"><WorkCard v-for="work in result.items" :key="work.id" :work="work" :cloud-enabled="cloudEnabled" @open="openWork" @open-author="openAuthor" @favorite="toggleFavorite" @cloud-favorite="toggleCloudFavorite" /></div>
        <div v-if="result.items.length" class="load-more">
          <button v-if="result.page < result.pages" class="button text small" :disabled="loadingMore" @click="retryLoadMore"><Icon name="refresh" :class="{ spinning: loadingMore }" :size="18" />{{ loadingMore ? '正在加载更多…' : moreFailed ? '加载失败，点击重试' : '继续向下滚动，自动加载更多' }}</button>
          <span v-else class="load-status">已加载全部 {{ formatNumber(result.total) }} 组作品</span>
          <div ref="sentinel" class="scroll-sentinel" aria-hidden="true"></div>
        </div>
        </template>
      </section>
      <footer class="page-footer"><span>拾光 MEDIA GARDEN</span><span>为每一份喜欢，留一处安放。</span></footer>
    </main>
    <nav class="mobile-nav" aria-label="手机导航"><button :class="{ active: view === 'library' && !cloudFavoritesMode }" @click="navigate('library')"><span><Icon name="gallery" /></span>媒体库</button><button :class="{ active: view === 'favorites' }" @click="navigate('favorites')"><span><Icon :name="view === 'favorites' ? 'heart-filled' : 'heart'" /></span>我的收藏</button><button :class="{ active: cloudFavoritesMode }" :disabled="!cloudEnabled" @click="openCloudFavorites(cloudFavoritesRestrict)"><span><Icon name="cloud" /></span>云端收藏</button><button @click="openSettings"><span><Icon name="settings" /></span>设置</button></nav>
    <AppNotice :notice="toast" @dismiss="dismiss" @action="runAction" />
  </div>
</template>
