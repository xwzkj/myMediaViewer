<script setup lang="ts">
import { ref, computed, onActivated, onDeactivated, onMounted, onUnmounted, watch, watchEffect, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LibraryStatus, TagSuggestion, TagSuggestionsResponse, Work, WorksResponse } from '../../shared/types'
import { activeSearchToken, replaceWithTag, tagQuery } from '../../shared/search-query'
import { api, formatNumber } from '../api'
import { appEvents, type WorkReturnPayload } from '../events'
import { createSearchSessionId, routeCacheKey } from '../route-cache-key'
import { setLibraryContext, setLibraryLoader, syncLibrarySession } from '../library-session'
import Icon from '../components/Icon.vue'
import WorkCard from '../components/WorkCard.vue'

defineOptions({ name: 'LibraryView' })

const route = useRoute()
const router = useRouter()
// 每个列表路由由独立的 KeepAlive 实例负责，搜索页按关键词和筛选项分开缓存。
const pageKey = routeCacheKey(route)
const pagePath = ref(routeCacheKey(route) === pageKey ? route.fullPath : '')
const pendingWorkId = ref('')
let pendingScrollToken = 0
const status = ref<LibraryStatus | null>(null)
// 记住上次看的是哪个来源、带哪些筛选、怎么排序，下次打开直接恢复。
const savedState = ((): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('libraryState') || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
})()
const savedText = (value: unknown, allowed: string[], fallback: string) => typeof value === 'string' && allowed.includes(value) ? value : fallback
const view = ref<'library' | 'favorites'>(savedState.view === 'favorites' ? 'favorites' : 'library')
const source = ref(typeof savedState.source === 'string' ? savedState.source : '')
const kind = ref(savedText(savedState.kind, ['', 'image', 'video'], ''))
const query = ref('')
const sort = ref(savedText(savedState.sort, ['newest', 'oldest', 'title', 'random'], 'newest'))
// 随机顺序用 seed 固定这一次的乱序结果，翻页不会重复或漏作品；换一批就换一个 seed。
const seed = ref(typeof savedState.seed === 'string' ? savedState.seed : String(Date.now()))
// 排序依据：收藏时间（文件名开头的 bmk_id）或发布时间，默认按收藏顺序。
const order = ref<'collected' | 'published'>(savedText(savedState.order, ['collected', 'published'], localStorage.getItem('orderBy') === 'published' ? 'published' : 'collected') as 'collected' | 'published')
const fuzzy = ref(savedState.fuzzy === true)
const result = ref<WorksResponse>({ items: [], total: 0, page: 1, pages: 1, elapsed: 0 })
const loading = ref(true)
// 滚动到底部时逐页追加，不再分页浏览。
const loadingMore = ref(false)
const moreFailed = ref(false)
const sentinel = ref<HTMLElement>()
const error = ref('')
const toast = ref('')
// toast 可以带一个操作链接，例如缓存译文提供的“重新翻译”。
const toastAction = ref<{ label: string; handler: () => void } | null>(null)
const toastTone = ref<'info' | 'error'>('info')
// 原生 dialog 打开后会进入浏览器 top layer，普通 DOM 再高的 z-index 也会被它盖住，
// 所以提示要挂到当前最上层的 dialog 里；没有弹窗时才挂在 body。
const toastHost = ref<HTMLElement | null>(null)
function topLayerHost() {
  const dialogs = document.querySelectorAll<HTMLElement>('dialog[open]')
  return dialogs.length ? dialogs[dialogs.length - 1] : null
}
const dark = ref(localStorage.getItem('theme') === 'dark')
const busyFavorites = new Set<string>()
const suggestions = ref<TagSuggestion[]>([])
const suggestionTotal = ref(0)
const suggestionOpen = ref(false)
const suggestionIndex = ref(-1)
const searchInput = ref<HTMLInputElement>()
let poll: ReturnType<typeof setInterval>
let debounce: ReturnType<typeof setTimeout>
let toastTimer: ReturnType<typeof setTimeout>
let controller: AbortController | undefined
let destroyed = false
let refreshInProgress = false
let caret = 0
let suggestionTimer: ReturnType<typeof setTimeout>
let blurTimer: ReturnType<typeof setTimeout>
let suggestionController: AbortController | undefined

const suggestionsVisible = computed(() => suggestionOpen.value && suggestions.value.length > 0)
const currentSource = computed(() => status.value?.sources.find(s => s.id === source.value))
// 顶部工具条吸顶后才显示分隔线，滚动时和内容区分开。
const scrolled = ref(false)
function trackScroll() { scrolled.value = window.scrollY > 4 }
// 筛选与排序收进二级菜单，只让搜索行常驻顶部。
const menuOpen = ref(false)
const menu = ref<HTMLElement>()
const menuButton = ref<HTMLElement>()
const filtersActive = computed(() => Boolean(kind.value || source.value || fuzzy.value))
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
const title = computed(() => query.value.trim() ? '发现你心中的那一张' : view.value === 'favorites' ? '把喜欢，留在身边。' : currentSource.value ? currentSource.value.name : '每一份喜欢，都值得珍藏。')
const caption = computed(() => query.value.trim() ? `正在整个描述、标题、作者与标签中寻找「${query.value.trim()}」` : view.value === 'favorites' ? '那些让你停下来的瞬间，都在这里。' : '让散落在文件夹里的灵感，在这里重新相遇。')
const hasLibrary = computed(() => !!status.value?.sources.length)
// 视频与动图合并成一个筛选，动图在后端按 animation 归类，这里用逗号列表一起取。
const filters = computed(() => [{ id: '', label: '全部', icon: 'gallery', count: status.value?.works || 0 }, { id: 'image', label: '图片', icon: 'image', count: status.value?.images || 0 }, { id: 'video', label: '视频', icon: 'video', count: (status.value?.videos || 0) + (status.value?.animations || 0) }])

watch(dark, value => { document.documentElement.dataset.theme = value ? 'dark' : 'light'; localStorage.setItem('theme', value ? 'dark' : 'light') }, { immediate: true })
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
  const params = new URLSearchParams({ q: query.value, source: source.value, kind: kind.value === 'video' ? 'video,animation' : kind.value, favorites: String(view.value === 'favorites'), page: String(target), sort: sort.value, fuzzy: String(fuzzy.value), by: effectiveOrder.value, seed: seed.value })
  try {
    const response = await api<WorksResponse>(`/works?${params}`, { signal: active.signal })
    if (controller !== active) return
    if (target <= 1) { if (silent) mergeFirstPage(response); else result.value = response }
    else result.value = { ...response, items: [...result.value.items, ...response.items] }
    syncLibrarySession(pageKey, target <= 1 ? result.value : response, target > 1)
    setLibraryContext(pageKey, { source: source.value, kind: kind.value, fuzzy: fuzzy.value, sort: sort.value, order: order.value, seed: seed.value })
  } catch (e) {
    if (active.signal.aborted) return
    if (target <= 1) error.value = (e as Error).message
    else { moreFailed.value = true; notice('加载更多失败，请稍后重试') }
  } finally {
    if (controller === active) { loading.value = false; loadingMore.value = false }
  }
}
function loadWorks() { void loadPage(1) }
async function loadMore(force = false) {
  if (force) moreFailed.value = false
  if (loading.value || loadingMore.value || moreFailed.value) return
  if (result.value.page >= result.value.pages) return
  await loadPage(result.value.page + 1)
}
async function refreshStatus() {
  if (refreshInProgress) return
  refreshInProgress = true
  try {
    const previous = status.value?.scan.finishedAt
    const next = await api<LibraryStatus>('/status')
    if (destroyed) return
    status.value = next
    if (source.value && !next.sources.some(s => s.id === source.value)) {
    source.value = ''
    if (route.name === 'source') void router.replace({ name: 'library' })
  }
    if (previous !== undefined && previous !== next.scan.finishedAt) void loadPage(1, true)
  } catch (e) { if (!status.value) error.value = (e as Error).message }
  finally { refreshInProgress = false }
}
function notice(message: string, action?: { label: string; handler: () => void }, tone: 'info' | 'error' = 'info') {
  toastHost.value = topLayerHost()
  toast.value = message
  toastTone.value = tone
  toastAction.value = action || null
  clearTimeout(toastTimer)
  toastTimer = setTimeout(dismissToast, action ? 8000 : 4200)
}
function dismissToast() {
  toast.value = ''
  toastAction.value = null
  clearTimeout(toastTimer)
}
// 点 toast 里的操作链接：先收起提示，再执行动作。
function runToastAction() {
  const action = toastAction.value
  dismissToast()
  action?.handler()
}
async function scan() {
  try { await api('/scan', { method: 'POST' }); await refreshStatus(); notice('正在检查目录中的新增和修改') }
  catch (e) { notice((e as Error).message) }
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
function closeSuggestions() { suggestionOpen.value = false; suggestionIndex.value = -1 }
function blurSuggestions() { clearTimeout(blurTimer); blurTimer = setTimeout(closeSuggestions, 160) }
function queueSuggestions() { clearTimeout(suggestionTimer); suggestionTimer = setTimeout(loadSuggestions, 140) }
async function loadSuggestions() {
  suggestionController?.abort()
  const active = new AbortController()
  suggestionController = active
  const term = activeSearchToken(query.value, caret).value.trim().slice(0, 60)
  try {
    const response = await api<TagSuggestionsResponse>(`/tags?q=${encodeURIComponent(term)}`, { signal: active.signal })
    if (suggestionController !== active || destroyed) return
    suggestions.value = response.items
    suggestionTotal.value = response.total
    suggestionIndex.value = -1
    suggestionOpen.value = response.items.length > 0
  } catch { /* 建议列表不可用时不影响正常搜索 */ }
}
function focusSearch() { caret = searchInput.value?.selectionStart ?? query.value.length; queueSuggestions() }
function updateCaret(event: Event) {
  const input = event.target as HTMLInputElement
  caret = input.selectionStart ?? input.value.length
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
  const next = replaceWithTag(query.value, caret, item.name)
  query.value = next.query
  caret = next.caret
  closeSuggestions()
  void nextTick(() => { searchInput.value?.focus(); searchInput.value?.setSelectionRange(caret, caret) })
}
function clearSearch() { query.value = ''; caret = 0; closeSuggestions(); searchInput.value?.focus() }
function openSettings() {
  router.push({ name: 'settings', query: { from: route.fullPath } })
}
function openWork(work: Work) {
  router.push({ name: 'work', params: { workId: work.id }, query: { from: route.fullPath, list: pageKey } })
}
function routeFilters(extra: Record<string, string> = {}) {
  const next: Record<string, string> = { ...extra }
  if (source.value) next.source = source.value
  if (kind.value) next.kind = kind.value
  if (fuzzy.value) next.fuzzy = 'true'
  if (sort.value && sort.value !== 'newest') next.sort = sort.value
  if (order.value === 'published') next.by = 'published'
  if (seed.value) next.seed = seed.value
  return next
}
function searchTarget(value: string) {
  const next = routeFilters({ q: value })
  const currentSid = typeof route.query.sid === 'string' ? route.query.sid : ''
  next.sid = route.name === 'search' && currentSid ? currentSid : createSearchSessionId()
  if (view.value === 'favorites') next.favorites = 'true'
  return { name: 'search' as const, query: next }
}
function listTarget() {
  if (view.value === 'favorites') return { name: 'favorites' as const, query: source.value ? { source: source.value } : {} }
  if (source.value) return { name: 'source' as const, params: { sourceId: source.value } }
  return { name: 'library' as const }
}
// 路由是页面身份的唯一来源；筛选和排序仍可沿用本地记忆，搜索词由 URL 保存。
function applyRoute() {
  if (routeCacheKey(route) !== pageKey) return
  const name = String(route.name || '')
  pagePath.value = route.fullPath
  view.value = name === 'favorites' || (name === 'search' && route.query.favorites === 'true') ? 'favorites' : 'library'
  source.value = name === 'source'
    ? String(route.params.sourceId || '')
    : typeof route.query.source === 'string' ? route.query.source : ''
  const nextKind = route.query.kind
  if (nextKind === 'image' || nextKind === 'video') kind.value = nextKind
  else if (name === 'search') kind.value = ''
  if (route.query.fuzzy === 'true') fuzzy.value = true
  else if (name === 'search') fuzzy.value = false
  const nextSort = route.query.sort
  if (nextSort === 'oldest' || nextSort === 'title' || nextSort === 'random' || nextSort === 'relevance') sort.value = nextSort
  if (route.query.by === 'published') order.value = 'published'
  else if (route.query.by === 'collected') order.value = 'collected'
  if (typeof route.query.seed === 'string') seed.value = route.query.seed
  query.value = name === 'search' && typeof route.query.q === 'string' ? route.query.q : ''
}
// 切换视图时保留筛选选项；只有显式传入来源才改动来源（传空字符串代表全部来源）。
function navigate(next: 'library' | 'favorites', sourceId?: string) {
  const nextSource = sourceId !== undefined ? sourceId : source.value
  if (next === 'favorites') {
    router.push({ name: 'favorites', query: nextSource ? { source: nextSource } : {} })
    return
  }
  if (nextSource) router.push({ name: 'source', params: { sourceId: nextSource } })
  else router.push({ name: 'library' })
}
// 换一批：换一个随机种子，重新打乱这一批作品的顺序。
function reshuffle() { seed.value = String(Date.now()) }
function resetFilters() {
  query.value = ''
  source.value = ''
  kind.value = ''
  fuzzy.value = false
  if (route.name === 'search' || route.name === 'source') router.replace({ name: view.value === 'favorites' ? 'favorites' : 'library' })
}
function retryLoadMore() { loadMore(true) }
watch(() => route.fullPath, applyRoute, { immediate: true })
watch([view, source, kind, sort, fuzzy, order, seed], () => void loadWorks())
// 搜索词不保存，其余的来源 / 筛选 / 排序都写进 localStorage。
// 搜索期间会临时切到相关度排序，这里记下用户原本选过的排序，清空搜索后还原。
let preSearchSort = sort.value
watch([view, source, kind, fuzzy, sort, order, seed], () => {
  localStorage.setItem('libraryState', JSON.stringify({
    view: view.value, source: source.value, kind: kind.value, fuzzy: fuzzy.value, order: order.value, seed: seed.value,
    sort: sort.value === 'relevance' ? preSearchSort : sort.value,
  }))
})
// 列表底部进入视野附近时自动追加下一页。
watchEffect(onCleanup => {
  const element = sentinel.value
  if (!element || !('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore() }, { rootMargin: '600px 0px' })
  observer.observe(element)
  onCleanup(() => observer.disconnect())
})
// 搜索时临时切到相关度排序，清空搜索后还原用户记住的排序方式。
watch(query, value => {
  clearTimeout(debounce)
  const routeQuery = route.name === 'search' && typeof route.query.q === 'string' ? route.query.q : ''
  if (routeQuery !== value) {
    if (value.trim()) void router.replace(searchTarget(value))
    else if (route.name === 'search') void router.replace(listTarget())
  }
  debounce = setTimeout(() => {
    if (value.trim()) { if (sort.value !== 'relevance') { preSearchSort = sort.value; sort.value = 'relevance' } }
    else if (sort.value === 'relevance') sort.value = preSearchSort
    void loadWorks()
  }, 220)
})
// 作品页退出时发送待定位作品；列表页等目标进入结果并完成渲染后再滚动。
function handleWorkReturn(payload: WorkReturnPayload) {
  if (payload.returnPath !== pagePath.value) return
  pendingWorkId.value = payload.workId
  if (routeCacheKey(route) === pageKey && route.fullPath === pagePath.value) void restorePendingWork()
}
async function waitForLoading() {
  while (loading.value || loadingMore.value) await new Promise(resolve => setTimeout(resolve, 30))
}
async function ensureWorkAvailable(id: string) {
  await waitForLoading()
  if (result.value.items.some(work => work.id === id)) return true
  while (result.value.page < result.value.pages) {
    const previousPage = result.value.page
    await loadPage(previousPage + 1)
    if (result.value.items.some(work => work.id === id)) return true
    if (result.value.page <= previousPage) break
  }
  return false
}
async function restorePendingWork() {
  const id = pendingWorkId.value
  if (!id || routeCacheKey(route) !== pageKey || route.fullPath !== pagePath.value) return
  const token = ++pendingScrollToken
  const available = await ensureWorkAvailable(id)
  if (token !== pendingScrollToken || pendingWorkId.value !== id) return
  if (!available) {
    pendingWorkId.value = ''
    return
  }
  await nextTick()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== pendingScrollToken) return
      const target = Array.from(document.querySelectorAll<HTMLElement>('.work-card[data-work-id]'))
        .find(card => card.dataset.workId === id)
      if (!target) return
      target.scrollIntoView({ block: 'center', behavior: 'auto' })
      pendingWorkId.value = ''
    })
  })
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
onMounted(() => {
  appEvents.on('work:return', handleWorkReturn)
  setLibraryLoader(pageKey, () => loadMore())
  void refreshStatus()
  void loadWorks()
  startPolling()
  bindGlobalListeners()
  trackScroll()
})
// KeepAlive 离开列表时暂停轮询和全局监听，回到列表时继续，避免后台页面重复请求。
onActivated(() => {
  bindGlobalListeners()
  startPolling()
  void restorePendingWork()
  void refreshStatus()
})
onDeactivated(() => {
  unbindGlobalListeners()
  clearInterval(poll)
})
onUnmounted(() => {
  destroyed = true
  setLibraryLoader(pageKey, null)
  appEvents.off('work:return', handleWorkReturn)
  unbindGlobalListeners()
  clearInterval(poll)
  clearTimeout(debounce)
  clearTimeout(toastTimer)
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
      <nav aria-label="主导航"><button class="nav-item" :class="{ active: view === 'library' && !source }" @click="navigate('library', '')"><Icon name="gallery" /><span>媒体库</span><span class="nav-count">{{ formatNumber(status?.works || 0) }}</span></button><button class="nav-item" :class="{ active: view === 'favorites' }" @click="navigate('favorites')"><Icon :name="view === 'favorites' ? 'heart-filled' : 'heart'" /><span>我的收藏</span><span class="nav-count">{{ formatNumber(status?.favorites || 0) }}</span></button></nav>
      <div class="nav-label row-label"><span>媒体来源</span><button class="icon-button tiny" aria-label="管理媒体来源" @click="openSettings"><Icon name="plus" :size="17" /></button></div>
      <nav class="source-nav" aria-label="媒体来源"><button v-for="item in status?.sources" :key="item.id" class="nav-item source-nav-item" :class="{ active: source === item.id }" @click="navigate('library', item.id)"><span class="source-letter" :class="item.kind">{{ item.kind === 'pixiv' ? 'P' : 'T' }}</span><span class="ellipsis">{{ item.name }}</span><span v-if="!item.online" title="目录离线"><Icon name="offline" :size="17" /></span><span v-else class="nav-count">{{ item.works }}</span></button><p v-if="!status?.sources.length" class="nav-empty">添加文件夹后，会显示在这里。</p></nav>
      <div class="sidebar-bottom"><button class="nav-item" @click="openSettings"><Icon name="settings" /><span>媒体库设置</span></button></div>
    </aside>
    <main class="main-content">
      <div class="library-toolbar" :class="{ stuck: scrolled }">
        <div class="search-row"><div class="search-field"><Icon name="search" :size="23" /><input ref="searchInput" v-model="query" type="text" aria-label="搜索作品" placeholder="搜索标题、描述、作者或标签…" maxlength="500" role="combobox" aria-autocomplete="list" aria-controls="tag-suggestions" :aria-expanded="suggestionsVisible" :aria-activedescendant="suggestionIndex >= 0 ? 'tag-suggestion-' + suggestionIndex : undefined" @focus="focusSearch" @input="updateCaret" @click="updateCaret" @keyup="searchKeyup" @keydown.down.prevent="moveSuggestion(1)" @keydown.up.prevent="moveSuggestion(-1)" @keydown.enter.prevent="commitSuggestion()" @keydown.esc="closeSuggestions" @blur="blurSuggestions" /><button v-if="query" class="icon-button small-icon" aria-label="清空搜索" @click="clearSearch"><Icon name="close" :size="19" /></button><span v-else class="search-hint">多个关键词用空格分隔</span><div v-if="suggestionsVisible" id="tag-suggestions" class="tag-suggestions" role="listbox" aria-label="标签搜索建议"><div class="suggestion-heading"><Icon name="tag" :size="15" /><span>按标签搜索</span><b v-if="suggestionTotal > suggestions.length">还有 {{ formatNumber(suggestionTotal - suggestions.length) }} 个匹配标签</b></div><button v-for="(item, i) in suggestions" :id="'tag-suggestion-' + i" :key="item.name" type="button" class="tag-suggestion" :class="{ active: i === suggestionIndex }" role="option" :aria-selected="i === suggestionIndex" @mousedown.prevent="commitSuggestion(i)" @mouseenter="suggestionIndex = i"><span>#{{ item.name }}</span><small>{{ formatNumber(item.count) }} 组</small></button></div></div><button ref="menuButton" class="icon-button menu-button" :class="{ active: filtersActive }" :aria-expanded="menuOpen" aria-haspopup="true" :title="filtersActive ? '筛选与排序（已应用筛选）' : '筛选与排序'" @click="menuOpen = !menuOpen"><Icon name="tune" :size="21" /><span v-if="filtersActive" class="menu-dot" /></button><button class="button outlined scan-button" @click="scan" :disabled="status?.scan.running || !hasLibrary"><Icon name="refresh" :class="{ spinning: status?.scan.running }" :size="20" /><span>{{ status?.scan.running ? '正在扫描' : '刷新媒体库' }}</span></button><button class="icon-button theme-button" :aria-label="dark ? '切换浅色模式' : '切换深色模式'" :title="dark ? '切换浅色模式' : '切换深色模式'" @click="dark = !dark"><Icon :name="dark ? 'sun' : 'moon'" :size="21" /></button></div>
        <Transition name="menu-pop"><div v-if="menuOpen" ref="menu" class="filter-menu" role="dialog" aria-label="筛选与排序"><label v-if="status && status.sources.length > 1" class="menu-row"><span>媒体来源</span><span class="menu-select"><select v-model="source" aria-label="筛选媒体来源"><option value="">全部来源</option><option v-for="item in status.sources" :key="item.id" :value="item.id">{{ item.name }}</option></select><Icon name="down" :size="16" /></span></label><div class="menu-row"><span>媒体类型</span><div class="menu-chips"><button v-for="filter in filters" :key="filter.id" class="filter-chip" :class="{ active: kind === filter.id }" :aria-pressed="kind === filter.id" @click="kind = filter.id"><Icon :name="kind === filter.id ? 'check' : filter.icon" :size="18" />{{ filter.label }}</button></div></div><label class="menu-row"><span>模糊匹配</span><span class="fuzzy-toggle"><input v-model="fuzzy" type="checkbox" /><span class="mini-switch" /><span>{{ fuzzy ? '已开启' : '已关闭' }}</span></span></label><label class="menu-row"><span>排序方式</span><span class="sort-select"><Icon name="sort" :size="18" /><select v-model="sort" aria-label="排序方式"><option v-if="query" value="relevance">相关度优先</option><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="title">标题排序</option><option value="random">随机顺序</option></select><Icon name="down" :size="16" /></span></label><label v-if="sort === 'random'" class="menu-row"><span>换一批</span><button class="button tonal small" type="button" @click="reshuffle"><Icon name="refresh" :size="17" />重新打乱</button></label><label class="menu-row" :class="{ dim: timeSortDisabled }"><span>时间依据</span><span class="fuzzy-toggle order-toggle"><input v-model="order" type="checkbox" true-value="collected" false-value="published" :disabled="timeSortDisabled" /><span class="mini-switch" /><span>{{ effectiveOrder === 'collected' ? '收藏时间' : '发布时间' }}</span></span></label></div></Transition>
      </div>
      <section class="hero"><div class="hero-copy"><span class="eyebrow"><span class="short-line" />{{ view === 'favorites' ? 'YOUR FAVORITE MOMENTS' : 'A HOME FOR YOUR INSPIRATION' }}</span><h1>{{ title }}</h1><p>{{ caption }}</p><div class="hero-meta"><span><strong>{{ formatNumber(view === 'favorites' ? status?.favorites || 0 : currentSource?.works || status?.works || 0) }}</strong> 组作品</span><span class="dot-separator">·</span><span>{{ status?.sources.length || 0 }} 个媒体目录</span><span v-if="hasLibrary" class="hero-status"><Icon :name="status?.scan.running ? 'refresh' : 'check'" :class="{ spinning: status?.scan.running }" :size="15" />{{ status?.scan.running ? '正在整理' : '收藏随时可见' }}</span></div></div><div class="hero-illustration" aria-hidden="true"><div class="orbit orbit-one" /><div class="orbit orbit-two" /><div class="illustration-card back"><Icon name="video" :size="30" /></div><div class="illustration-card middle"><Icon name="leaf" :size="40" /></div><div class="illustration-card front"><div class="little-sun" /><div class="little-hill hill-one" /><div class="little-hill hill-two" /></div><span class="illustration-sparkle">✦</span><span class="illustration-dot" /></div></section>
      <section class="library-content" aria-label="作品列表">
        <div v-if="status?.scan.running" class="scan-progress" role="status"><div class="indeterminate-bar" /><span>{{ status.scan.phase }}<b>{{ formatNumber(status.scan.files) }} 个文件</b></span></div>
        <div v-if="status?.scan.errors.length && !status.scan.running" class="warning-banner"><Icon name="warning" :size="20" /><span>部分目录或描述未能读取，已有索引已保留。</span><button class="button text small" @click="openSettings">查看详情</button></div>
        <div class="results-heading"><h2>{{ query ? '搜索结果' : view === 'favorites' ? '我的收藏' : currentSource?.name || '全部作品' }}<span>{{ formatNumber(result.total) }}</span></h2><span v-if="query && !loading" class="results-note">{{ result.elapsed }} ms · 支持简繁体与拼音</span><span v-else class="results-note">{{ kind ? ({ image: '静止的画面，无限的想象', video: '按下播放，让故事继续', animation: '让灵感动起来' }[kind]) : '灵感，在这里慢慢生长' }}</span></div>
        <div v-if="error" class="empty-state error-state"><span class="empty-symbol"><Icon name="warning" :size="38" /></span><h3>暂时无法连接媒体库</h3><p>{{ error }}</p><button class="button filled" @click="refreshStatus(); loadWorks()">重新连接</button></div>
        <div v-else-if="loading && !result.items.length" class="work-grid" aria-label="正在加载"><div v-for="n in 8" :key="n" class="skeleton-card"><div /><span /><small /></div></div>
        <div v-else-if="!hasLibrary" class="empty-state welcome-state"><div class="empty-art"><Icon name="folder-plus" :size="54" /><span>✦</span></div><span class="eyebrow">YOUR COLLECTION STARTS HERE</span><h3>给你的喜欢，一个家。</h3><p>添加存放图片和视频的文件夹，<br />拾光会自动将同组作品整理在一起。</p><button class="button filled" @click="openSettings"><Icon name="plus" :size="20" />添加第一个媒体目录</button><div class="welcome-features"><span><Icon name="images" :size="17" />自动分组</span><span><Icon name="search" :size="17" />描述搜索</span><span><Icon name="heart" :size="17" />跨设备收藏</span></div></div>
        <div v-else-if="!result.items.length" class="empty-state"><span class="empty-symbol"><Icon :name="query ? 'search' : view === 'favorites' ? 'heart' : 'images'" :size="40" /></span><h3>{{ status?.scan.running ? '正在整理你的第一批作品' : query ? '还没有找到相关作品' : view === 'favorites' ? '留一点位置，给心动的作品' : '这里还没有作品' }}</h3><p>{{ status?.scan.running ? '扫描完成后，作品会自动出现在这里。' : query ? '试试更短的关键词，或开启模糊匹配。' : view === 'favorites' ? '点击作品卡片上的爱心，就能在这里找到它。' : '检查分组规则，或调整筛选条件再看看。' }}</p><button v-if="query || kind || source" class="button tonal" @click="resetFilters">清除筛选</button><button v-else-if="!status?.scan.running && view !== 'favorites'" class="button tonal" @click="openSettings">检查媒体目录</button></div>
        <div v-else class="work-grid" :class="{ refreshing: loading }"><WorkCard v-for="work in result.items" :key="work.id" :work="work" @open="openWork" @favorite="toggleFavorite" /></div>
        <div v-if="result.items.length" class="load-more">
          <button v-if="result.page < result.pages" class="button text small" :disabled="loadingMore" @click="retryLoadMore"><Icon name="refresh" :class="{ spinning: loadingMore }" :size="18" />{{ loadingMore ? '正在加载更多…' : moreFailed ? '加载失败，点击重试' : '继续向下滚动，自动加载更多' }}</button>
          <span v-else class="load-status">已加载全部 {{ formatNumber(result.total) }} 组作品</span>
          <div ref="sentinel" class="scroll-sentinel" aria-hidden="true"></div>
        </div>
      </section>
      <footer class="page-footer"><span>拾光 MEDIA GARDEN</span><span>为每一份喜欢，留一处安放。</span></footer>
    </main>
    <nav class="mobile-nav" aria-label="手机导航"><button :class="{ active: view === 'library' }" @click="navigate('library')"><span><Icon name="gallery" /></span>媒体库</button><button :class="{ active: view === 'favorites' }" @click="navigate('favorites')"><span><Icon :name="view === 'favorites' ? 'heart-filled' : 'heart'" /></span>我的收藏</button><button @click="openSettings"><span><Icon name="settings" /></span>设置</button></nav>
    <Teleport :to="toastHost || 'body'"><Transition name="toast"><div v-if="toast" class="snackbar" :class="{ error: toastTone === 'error' }" :role="toastTone === 'error' ? 'alert' : 'status'"><Icon :name="toastTone === 'error' ? 'warning' : 'success'" :size="20" /><span>{{ toast }}</span><button v-if="toastAction" class="toast-action" type="button" @click="runToastAction">{{ toastAction.label }}</button><button class="icon-button" aria-label="关闭提示" @click="dismissToast"><Icon name="close" :size="18" /></button></div></Transition></Teleport>
  </div>
</template>
