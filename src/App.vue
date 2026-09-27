<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, watchEffect, nextTick } from 'vue'
import type { LibraryStatus, TagSuggestion, TagSuggestionsResponse, Work, WorksResponse } from '../shared/types'
import { activeSearchToken, replaceWithTag, tagQuery } from '../shared/search-query'
import { api, formatNumber } from './api'
import Icon from './components/Icon.vue'
import WorkCard from './components/WorkCard.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ViewerDialog from './components/ViewerDialog.vue'

const status = ref<LibraryStatus | null>(null)
const view = ref<'library' | 'favorites'>('library')
const source = ref('')
const kind = ref('')
const query = ref('')
const sort = ref('newest')
// 排序依据：收藏时间（文件名开头的 bmk_id）或发布时间，默认按收藏顺序。
const order = ref<'collected' | 'published'>(localStorage.getItem('orderBy') === 'published' ? 'published' : 'collected')
const fuzzy = ref(false)
const result = ref<WorksResponse>({ items: [], total: 0, page: 1, pages: 1, elapsed: 0 })
const loading = ref(true)
// 滚动到底部时逐页追加，不再分页浏览。
const loadingMore = ref(false)
const moreFailed = ref(false)
const sentinel = ref<HTMLElement>()
const error = ref('')
const settings = ref(false)
const selected = ref<Work | null>(null)
const toast = ref('')
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
const title = computed(() => query.value.trim() ? '发现你心中的那一张' : view.value === 'favorites' ? '把喜欢，留在身边。' : currentSource.value ? currentSource.value.name : '每一份喜欢，都值得珍藏。')
const caption = computed(() => query.value.trim() ? `正在整个描述、标题、作者与标签中寻找「${query.value.trim()}」` : view.value === 'favorites' ? '那些让你停下来的瞬间，都在这里。' : '让散落在文件夹里的灵感，在这里重新相遇。')
const hasLibrary = computed(() => !!status.value?.sources.length)
const filters = computed(() => [{ id: '', label: '全部', icon: 'gallery', count: status.value?.works || 0 }, { id: 'image', label: '图片', icon: 'image', count: status.value?.images || 0 }, { id: 'video', label: '视频', icon: 'video', count: status.value?.videos || 0 }, { id: 'animation', label: '动图', icon: 'animation', count: status.value?.animations || 0 }])

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
  const params = new URLSearchParams({ q: query.value, source: source.value, kind: kind.value, favorites: String(view.value === 'favorites'), page: String(target), sort: sort.value, fuzzy: String(fuzzy.value), by: order.value })
  try {
    const response = await api<WorksResponse>(`/works?${params}`, { signal: active.signal })
    if (controller !== active) return
    if (target <= 1) { if (silent) mergeFirstPage(response); else result.value = response }
    else result.value = { ...response, items: [...result.value.items, ...response.items] }
  } catch (e) {
    if (active.signal.aborted) return
    if (target <= 1) error.value = (e as Error).message
    else { moreFailed.value = true; notice('加载更多失败，请稍后重试') }
  } finally {
    if (controller === active) { loading.value = false; loadingMore.value = false }
  }
}
function loadWorks() { void loadPage(1) }
function loadMore(force = false) {
  if (force) moreFailed.value = false
  if (loading.value || loadingMore.value || moreFailed.value) return
  if (result.value.page >= result.value.pages) return
  void loadPage(result.value.page + 1)
}
async function refreshStatus() {
  if (refreshInProgress) return
  refreshInProgress = true
  try {
    const previous = status.value?.scan.finishedAt
    const next = await api<LibraryStatus>('/status')
    if (destroyed) return
    status.value = next
    if (source.value && !next.sources.some(s => s.id === source.value)) source.value = ''
    if (previous !== undefined && previous !== next.scan.finishedAt) void loadPage(1, true)
  } catch (e) { if (!status.value) error.value = (e as Error).message }
  finally { refreshInProgress = false }
}
function notice(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = '' }, 4200) }
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
    if (selected.value?.id === work.id) selected.value.favorite = next
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
function searchByTag(tag: string) {
  query.value = tagQuery(tag)
  view.value = 'library'; source.value = ''; kind.value = ''; fuzzy.value = false
  selected.value = null
  closeSuggestions()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function navigate(next: 'library' | 'favorites', sourceId = '') { view.value = next; source.value = sourceId; query.value = ''; kind.value = '' }
function resetFilters() { query.value = ''; source.value = ''; kind.value = ''; fuzzy.value = false }
function retryLoadMore() { loadMore(true) }
async function sourcesChanged() { await refreshStatus(); void loadWorks() }
watch([view, source, kind, sort, fuzzy, order], () => void loadWorks())
watch(order, value => localStorage.setItem('orderBy', value))
// 列表底部进入视野附近时自动追加下一页。
watchEffect(onCleanup => {
  const element = sentinel.value
  if (!element || !('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore() }, { rootMargin: '600px 0px' })
  observer.observe(element)
  onCleanup(() => observer.disconnect())
})
watch(query, () => { clearTimeout(debounce); debounce = setTimeout(() => { if (query.value.trim()) sort.value = 'relevance'; else if (sort.value === 'relevance') sort.value = 'newest'; void loadWorks() }, 220) })
onMounted(() => { void refreshStatus(); void loadWorks(); poll = setInterval(refreshStatus, 2000) })
onUnmounted(() => { destroyed = true; clearInterval(poll); clearTimeout(debounce); clearTimeout(toastTimer); clearTimeout(suggestionTimer); clearTimeout(blurTimer); controller?.abort(); suggestionController?.abort() })
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="navigate('library')"><span class="brand-mark"><Icon name="gallery" :size="26" /></span><div><strong>拾光</strong><small>MEDIA GARDEN</small></div></a>
      <button class="button filled add-folder" aria-label="添加媒体目录" title="添加媒体目录" @click="settings = true"><Icon name="plus" :size="21" /><span>添加媒体目录</span></button>
      <span class="nav-label">我的空间</span>
      <nav aria-label="主导航"><button class="nav-item" :class="{ active: view === 'library' && !source }" @click="navigate('library')"><Icon name="gallery" /><span>媒体库</span><span class="nav-count">{{ formatNumber(status?.works || 0) }}</span></button><button class="nav-item" :class="{ active: view === 'favorites' }" @click="navigate('favorites')"><Icon :name="view === 'favorites' ? 'heart-filled' : 'heart'" /><span>我的收藏</span><span class="nav-count">{{ formatNumber(status?.favorites || 0) }}</span></button></nav>
      <div class="nav-label row-label"><span>媒体来源</span><button class="icon-button tiny" aria-label="管理媒体来源" @click="settings = true"><Icon name="plus" :size="17" /></button></div>
      <nav class="source-nav" aria-label="媒体来源"><button v-for="item in status?.sources" :key="item.id" class="nav-item source-nav-item" :class="{ active: source === item.id }" @click="navigate('library', item.id)"><span class="source-letter" :class="item.kind">{{ item.kind === 'pixiv' ? 'P' : 'T' }}</span><span class="ellipsis">{{ item.name }}</span><span v-if="!item.online" title="目录离线"><Icon name="offline" :size="17" /></span><span v-else class="nav-count">{{ item.works }}</span></button><p v-if="!status?.sources.length" class="nav-empty">添加文件夹后，会显示在这里。</p></nav>
      <div class="sidebar-bottom"><div class="local-note"><span class="online-dot" /><div><strong>你的私人收藏馆</strong><small>本地存储 · 局域网共享</small></div><Icon name="leaf" :size="25" /></div><button class="nav-item" @click="settings = true"><Icon name="settings" /><span>媒体库设置</span></button></div>
    </aside>
    <main class="main-content">
      <header class="topbar"><div class="breadcrumb"><span>我的空间</span><Icon name="right" :size="16" /><strong>{{ view === 'favorites' ? '我的收藏' : currentSource?.name || '媒体库' }}</strong></div><div class="top-actions"><span class="device-label"><span class="online-dot" />本地媒体库</span><button class="icon-button" :aria-label="dark ? '切换浅色模式' : '切换深色模式'" @click="dark = !dark"><Icon :name="dark ? 'sun' : 'moon'" :size="21" /></button><button class="avatar" aria-label="打开媒体库设置" @click="settings = true">拾</button></div></header>
      <section class="hero"><div class="hero-copy"><span class="eyebrow"><span class="short-line" />{{ view === 'favorites' ? 'YOUR FAVORITE MOMENTS' : 'A HOME FOR YOUR INSPIRATION' }}</span><h1>{{ title }}</h1><p>{{ caption }}</p><div class="hero-meta"><span><strong>{{ formatNumber(view === 'favorites' ? status?.favorites || 0 : currentSource?.works || status?.works || 0) }}</strong> 组作品</span><span class="dot-separator">·</span><span>{{ status?.sources.length || 0 }} 个媒体目录</span><span v-if="hasLibrary" class="hero-status"><Icon :name="status?.scan.running ? 'refresh' : 'check'" :class="{ spinning: status?.scan.running }" :size="15" />{{ status?.scan.running ? '正在整理' : '收藏随时可见' }}</span></div></div><div class="hero-illustration" aria-hidden="true"><div class="orbit orbit-one" /><div class="orbit orbit-two" /><div class="illustration-card back"><Icon name="video" :size="30" /></div><div class="illustration-card middle"><Icon name="leaf" :size="40" /></div><div class="illustration-card front"><div class="little-sun" /><div class="little-hill hill-one" /><div class="little-hill hill-two" /></div><span class="illustration-sparkle">✦</span><span class="illustration-dot" /></div></section>
      <section class="library-content" aria-label="作品列表">
        <div class="search-row"><div class="search-field"><Icon name="search" :size="23" /><input ref="searchInput" v-model="query" type="text" aria-label="搜索作品" placeholder="搜索标题、描述、作者或标签…" maxlength="500" role="combobox" aria-autocomplete="list" aria-controls="tag-suggestions" :aria-expanded="suggestionsVisible" :aria-activedescendant="suggestionIndex >= 0 ? 'tag-suggestion-' + suggestionIndex : undefined" @focus="focusSearch" @input="updateCaret" @click="updateCaret" @keyup="searchKeyup" @keydown.down.prevent="moveSuggestion(1)" @keydown.up.prevent="moveSuggestion(-1)" @keydown.enter.prevent="commitSuggestion()" @keydown.esc="closeSuggestions" @blur="blurSuggestions" /><button v-if="query" class="icon-button small-icon" aria-label="清空搜索" @click="clearSearch"><Icon name="close" :size="19" /></button><span v-else class="search-hint">多个关键词用空格分隔</span><div v-if="suggestionsVisible" id="tag-suggestions" class="tag-suggestions" role="listbox" aria-label="标签搜索建议"><div class="suggestion-heading"><Icon name="tag" :size="15" /><span>按标签搜索</span><b v-if="suggestionTotal > suggestions.length">还有 {{ formatNumber(suggestionTotal - suggestions.length) }} 个匹配标签</b></div><button v-for="(item, i) in suggestions" :id="'tag-suggestion-' + i" :key="item.name" type="button" class="tag-suggestion" :class="{ active: i === suggestionIndex }" role="option" :aria-selected="i === suggestionIndex" @mousedown.prevent="commitSuggestion(i)" @mouseenter="suggestionIndex = i"><span>#{{ item.name }}</span><small>{{ formatNumber(item.count) }} 组</small></button></div></div><button class="button outlined scan-button" @click="scan" :disabled="status?.scan.running || !hasLibrary"><Icon name="refresh" :class="{ spinning: status?.scan.running }" :size="20" /><span>{{ status?.scan.running ? '正在扫描' : '刷新媒体库' }}</span></button></div>
        <div class="filter-row"><div class="filter-chips" aria-label="媒体类型"><button v-for="filter in filters" :key="filter.id" class="filter-chip" :class="{ active: kind === filter.id }" :aria-pressed="kind === filter.id" @click="kind = filter.id"><Icon :name="kind === filter.id ? 'check' : filter.icon" :size="18" />{{ filter.label }}<span v-if="!source && view === 'library'">{{ formatNumber(filter.count) }}</span></button></div><div class="filter-tools"><label class="fuzzy-toggle" title="同时支持错字和漏字的近似匹配"><input v-model="fuzzy" type="checkbox" /><span class="mini-switch" /><span>模糊匹配</span></label><label class="sort-select"><Icon name="sort" :size="20" /><select v-model="sort" aria-label="排序方式"><option v-if="query" value="relevance">相关度优先</option><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="title">标题排序</option></select><Icon name="down" :size="16" /></label><label class="fuzzy-toggle order-toggle" :class="{ dim: sort === 'title' || sort === 'relevance' }" :title="sort === 'title' || sort === 'relevance' ? '标题和相关度排序和时间无关' : (order === 'collected' ? '当前按收藏顺序排列，点击改用发布时间' : '当前按发布时间排列，点击改用收藏顺序')"><input v-model="order" type="checkbox" true-value="collected" false-value="published" :disabled="sort === 'title' || sort === 'relevance'" aria-label="按收藏时间排序" /><span class="mini-switch" /><span>{{ order === 'collected' ? '收藏时间' : '发布时间' }}</span></label></div></div>
        <label v-if="status && status.sources.length > 1" class="mobile-source-filter"><Icon name="folder" :size="17" /><select v-model="source" aria-label="筛选媒体来源"><option value="">全部媒体来源</option><option v-for="item in status.sources" :key="item.id" :value="item.id">{{ item.name }}</option></select><Icon name="down" :size="16" /></label>
        <div v-if="status?.scan.running" class="scan-progress" role="status"><div class="indeterminate-bar" /><span>{{ status.scan.phase }}<b>{{ formatNumber(status.scan.files) }} 个文件</b></span></div>
        <div v-if="status?.scan.errors.length && !status.scan.running" class="warning-banner"><Icon name="warning" :size="20" /><span>部分目录或描述未能读取，已有索引已保留。</span><button class="button text small" @click="settings = true">查看详情</button></div>
        <div class="results-heading"><h2>{{ query ? '搜索结果' : view === 'favorites' ? '我的收藏' : currentSource?.name || '全部作品' }}<span>{{ formatNumber(result.total) }}</span></h2><span v-if="query && !loading" class="results-note">{{ result.elapsed }} ms · 支持简繁体与拼音</span><span v-else class="results-note">{{ kind ? ({ image: '静止的画面，无限的想象', video: '按下播放，让故事继续', animation: '让灵感动起来' }[kind]) : '灵感，在这里慢慢生长' }}</span></div>
        <div v-if="error" class="empty-state error-state"><span class="empty-symbol"><Icon name="warning" :size="38" /></span><h3>暂时无法连接媒体库</h3><p>{{ error }}</p><button class="button filled" @click="refreshStatus(); loadWorks()">重新连接</button></div>
        <div v-else-if="loading && !result.items.length" class="work-grid" aria-label="正在加载"><div v-for="n in 8" :key="n" class="skeleton-card"><div /><span /><small /></div></div>
        <div v-else-if="!hasLibrary" class="empty-state welcome-state"><div class="empty-art"><Icon name="folder-plus" :size="54" /><span>✦</span></div><span class="eyebrow">YOUR COLLECTION STARTS HERE</span><h3>给你的喜欢，一个家。</h3><p>添加存放图片和视频的文件夹，<br />拾光会自动将同组作品整理在一起。</p><button class="button filled" @click="settings = true"><Icon name="plus" :size="20" />添加第一个媒体目录</button><div class="welcome-features"><span><Icon name="images" :size="17" />自动分组</span><span><Icon name="search" :size="17" />描述搜索</span><span><Icon name="heart" :size="17" />跨设备收藏</span></div></div>
        <div v-else-if="!result.items.length" class="empty-state"><span class="empty-symbol"><Icon :name="query ? 'search' : view === 'favorites' ? 'heart' : 'images'" :size="40" /></span><h3>{{ status?.scan.running ? '正在整理你的第一批作品' : query ? '还没有找到相关作品' : view === 'favorites' ? '留一点位置，给心动的作品' : '这里还没有作品' }}</h3><p>{{ status?.scan.running ? '扫描完成后，作品会自动出现在这里。' : query ? '试试更短的关键词，或开启模糊匹配。' : view === 'favorites' ? '点击作品卡片上的爱心，就能在这里找到它。' : '检查分组规则，或调整筛选条件再看看。' }}</p><button v-if="query || kind || source" class="button tonal" @click="resetFilters">清除筛选</button><button v-else-if="!status?.scan.running && view !== 'favorites'" class="button tonal" @click="settings = true">检查媒体目录</button></div>
        <div v-else class="work-grid" :class="{ refreshing: loading }"><WorkCard v-for="work in result.items" :key="work.id" :work="work" @open="selected = $event" @favorite="toggleFavorite" /></div>
        <div v-if="result.items.length" class="load-more">
          <button v-if="result.page < result.pages" class="button text small" :disabled="loadingMore" @click="retryLoadMore"><Icon name="refresh" :class="{ spinning: loadingMore }" :size="18" />{{ loadingMore ? '正在加载更多…' : moreFailed ? '加载失败，点击重试' : '继续向下滚动，自动加载更多' }}</button>
          <span v-else class="load-status">已加载全部 {{ formatNumber(result.total) }} 组作品</span>
          <div ref="sentinel" class="scroll-sentinel" aria-hidden="true"></div>
        </div>
      </section>
      <footer class="page-footer"><span>拾光 MEDIA GARDEN</span><span>为每一份喜欢，留一处安放。</span></footer>
    </main>
    <nav class="mobile-nav" aria-label="手机导航"><button :class="{ active: view === 'library' }" @click="navigate('library')"><span><Icon name="gallery" /></span>媒体库</button><button :class="{ active: view === 'favorites' }" @click="navigate('favorites')"><span><Icon :name="view === 'favorites' ? 'heart-filled' : 'heart'" /></span>我的收藏</button><button @click="settings = true"><span><Icon name="settings" /></span>设置</button></nav>
    <SettingsDialog v-if="settings" :status="status" @close="settings = false" @changed="sourcesChanged" @notice="notice" />
    <ViewerDialog v-if="selected" :work="selected" @close="selected = null" @favorite="toggleFavorite" @notice="notice" @search-tag="searchByTag" />
    <Transition name="toast"><div v-if="toast" class="snackbar" role="status"><Icon name="success" :size="20" /><span>{{ toast }}</span><button class="icon-button" aria-label="关闭提示" @click="toast = ''"><Icon name="close" :size="18" /></button></div></Transition>
  </div>
</template>
