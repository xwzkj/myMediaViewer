<script setup lang="ts">
import { computed, onBeforeUnmount, onUnmounted, ref, watch } from 'vue'
import type { PixivSearchResponse, Work, WorksResponse } from '../../shared/types'
import { api } from '../api'
import { readRecommendationSource, writeRecommendationSource, type SearchSource } from '../library-state'
import { createRecommendationSession } from '../recommendation-session'
import { getLibrarySession, releaseLibrarySession, retainLibrarySession } from '../library-session'
import { appEvents, type PixivAuthChangedPayload, type PixivBookmarkSyncedPayload } from '../events'
import Icon from './Icon.vue'
import WorkFavoriteActions from './WorkFavoriteActions.vue'
import WorkMediaBadge from './WorkMediaBadge.vue'
import SmoothThumbnail from './SmoothThumbnail.vue'

const props = defineProps<{ work: Work; active?: boolean; cloudEnabled?: boolean }>()
const emit = defineEmits<{ open: [work: Work, listKey: string]; favorite: [work: Work]; cloudFavorite: [work: Work]; notice: [message: string] }>()
const isActive = computed(() => props.active ?? true)
// 实例内来源：初始取全局默认，之后只归实例所有，返回不被别的作品重置。
const source = ref<SearchSource>(readRecommendationSource())
const items = ref<Work[]>([])
const loading = ref(false)
const error = ref('')
const page = ref(1)
const pages = ref(1)
const cursor = ref<string | null>(null)
const ownedKeys = new Set<string>()
// cloud 翻页去重：已见 id 跨页累积（服务端游标可能回吐重复）。
const seenIds = new Set<string>()
let loadVersion = 0
let controller: AbortController | undefined
// auth 版本：账号变化推进版本，迟到旧响应丢弃；inactive 只 clear+dirty，回来 reload。
let authVersion = 0
let cacheDirty = false
const cloudAvailable = computed(() => Boolean(props.cloudEnabled && props.work.pixivId))

if (!cloudAvailable.value && source.value === 'cloud') source.value = 'local'

watch(source, value => writeRecommendationSource(value))
watch(() => props.active ?? true, () => { /* 失活不中止未完成的本实例请求，回来直接用结果 */ })
watch(() => [props.work.id, props.work.pixivId, source.value, cloudAvailable.value], () => { void load(true) }, { immediate: true })

// 跨页同步：只收不发。auth 变化：清旧缓存并推进版本作废在途；
// inactive 只 clear+dirty，回来（active）才 reload，避免后台请求。
function handleAuthChanged() {
  authVersion++
  controller?.abort()
  items.value = []
  cursor.value = null
  page.value = 1
  pages.value = 1
  error.value = ''
  seenIds.clear()
  cacheDirty = true
  if (isActive.value) {
    cacheDirty = false
    void load(true)
  }
}
// bookmark 同步：只更新本地 items；owned 会话镜像一并更新（详情前后翻页可用）。
function handleBookmarkSynced(payload: PixivBookmarkSyncedPayload) {
  const next = { bookmarked: payload.bookmarked, restrict: payload.restrict }
  for (const item of items.value) {
    if ((item.pixivId || item.externalId) === payload.illustId) item.cloudBookmark = next
  }
  for (const key of ownedKeys) {
    const session = getLibrarySession(key)
    if (!session) continue
    for (const item of session.items) {
      if ((item.pixivId || item.externalId) === payload.illustId) item.cloudBookmark = next
    }
  }
}
appEvents.on('pixiv:auth-changed', handleAuthChanged)
appEvents.on('pixiv:bookmark-synced', handleBookmarkSynced)
watch(isActive, active => {
  if (active && cacheDirty) {
    cacheDirty = false
    void load(true)
  }
})
onBeforeUnmount(() => { loadVersion++ })
onUnmounted(() => {
  loadVersion++
  controller?.abort()
  appEvents.off('pixiv:auth-changed', handleAuthChanged)
  appEvents.off('pixiv:bookmark-synced', handleBookmarkSynced)
  for (const key of ownedKeys) releaseLibrarySession(key)
  ownedKeys.clear()
})

async function load(reset = false) {
  if (source.value === 'cloud' && !cloudAvailable.value) { source.value = 'local'; return }
  const version = ++loadVersion
  const seenVersion = authVersion
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  if (reset) { items.value = []; seenIds.clear(); cursor.value = null; page.value = 1; pages.value = 1 }
  loading.value = true; error.value = ''
  try {
    if (source.value === 'cloud') {
      const params = new URLSearchParams()
      if (!reset && cursor.value) params.set('cursor', cursor.value)
      const response = await api<PixivSearchResponse>(`/pixiv/works/${encodeURIComponent(props.work.pixivId!)}/related?${params}`, { signal })
      if (version !== loadVersion || seenVersion !== authVersion) return
      const fresh = response.items.filter(item => !seenIds.has(item.id))
      for (const item of fresh) seenIds.add(item.id)
      // reset 也要过 seenIds：服务端可能首屏回吐，visited 保证不重复。
      items.value = reset ? fresh : [...items.value, ...fresh]
      cursor.value = response.nextCursor
      // 第 3 页起 nextCursor 仍可能存在：pages 跟随“还有下一页”走，不再固定 2。
      if (reset) {
        page.value = 1
        pages.value = response.nextCursor ? 2 : 1
      } else {
        page.value = page.value + 1
        pages.value = response.nextCursor ? page.value + 1 : page.value
      }
    } else {
      const response = await api<WorksResponse>(`/works/${encodeURIComponent(props.work.id)}/related?page=${reset ? 1 : page.value + 1}`, { signal })
      if (version !== loadVersion || seenVersion !== authVersion) return
      const fresh = reset ? response.items : response.items.filter(item => !seenIds.has(item.id))
      for (const item of response.items) seenIds.add(item.id)
      items.value = reset ? fresh : [...items.value, ...fresh]
      page.value = response.page
      pages.value = response.pages
    }
  } catch (e) {
    if (version !== loadVersion || seenVersion !== authVersion) return
    const message = (e as Error).message
    if (reset || !items.value.length) error.value = message
    // 后台 notice 只当 active 才发：失活页的失败不串到前台。
    else if (isActive.value) emit('notice', `加载更多失败：${message}`)
  }
  finally { if (version === loadVersion && seenVersion === authVersion) loading.value = false }
}

function changeSource(value: SearchSource) {
  if (value === 'cloud' && !cloudAvailable.value) { emit('notice', '当前作品没有可用的云端推荐，请先配置 Pixiv 账号'); return }
  source.value = value
}

function openWork(work: Work) {
  const listKey = createRecommendationSession({
    workId: props.work.id, pixivId: props.work.pixivId, source: source.value,
    items: items.value, page: page.value, pages: pages.value, cursor: cursor.value,
  })
  ownedKeys.add(listKey)
  retainLibrarySession(listKey)
  emit('open', work, listKey)
}
</script>

<template>
  <section class="work-recommendations" aria-label="相关作品推荐">
    <div class="recommendation-heading"><div><span>RELATED WORKS</span><h3>相关作品</h3></div><div class="recommendation-tabs" role="tablist"><button type="button" role="tab" :aria-selected="source === 'local'" :class="{ active: source === 'local' }" @click="changeSource('local')">本地推荐</button><button type="button" role="tab" :disabled="!cloudAvailable" :aria-selected="source === 'cloud'" :class="{ active: source === 'cloud' }" @click="changeSource('cloud')">云端推荐</button></div></div>
    <p v-if="error" class="recommendation-error"><Icon name="warning" :size="16" />{{ error }}</p>
    <div v-else-if="loading && !items.length" class="recommendation-loading"><span class="spinner" />正在挑选相关作品…</div>
    <div v-else-if="!items.length" class="recommendation-empty">暂时没有找到相关作品。</div>
    <div v-else class="recommendation-list">
      <article v-for="item in items" :key="item.id" class="recommendation-card">
        <button type="button" class="recommendation-open" :aria-label="item.title" @click="openWork(item)"><SmoothThumbnail :src="item.cover" :alt="item.title" /></button>
        <div class="recommendation-favorites">
          <WorkMediaBadge :work="item" inline />
          <WorkFavoriteActions :work="item" :cloud-enabled="cloudEnabled" @favorite="emit('favorite', $event)" @cloud-favorite="emit('cloudFavorite', $event)" />
        </div>
      </article>
    </div>
    <button v-if="(source === 'cloud' ? cursor : page < pages) && items.length" class="button tonal small recommendation-more" type="button" :disabled="loading" @click="load(false)"><Icon name="refresh" :class="{ spinning: loading }" :size="16" />{{ loading ? '加载中…' : '加载更多' }}</button>
  </section>
</template>

<style scoped>
.work-recommendations { margin-top: 30px; padding-top: 22px; border-top: 1px solid var(--outline); }
.recommendation-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.recommendation-heading span { color: var(--muted); font-size: 8px; letter-spacing: 1.4px; }
.recommendation-heading h3 { margin: 5px 0 0; font-size: 15px; }
.recommendation-tabs { display: flex; gap: 5px; }
.recommendation-tabs button { padding: 5px 8px; border-radius: 8px; background: var(--surface-high); color: var(--muted); font-size: 9px; }
.recommendation-tabs button.active { background: var(--primary-container); color: var(--on-container); }
.recommendation-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.recommendation-card { position: relative; padding: 0; overflow: hidden; border: 1px solid var(--outline); border-radius: 12px; background: var(--card); }
.recommendation-open { position: relative; display: block; width: 100%; aspect-ratio: 1 / 1.18; padding: 0; background: var(--surface-high); }
.recommendation-favorites { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 6px; border-top: 1px solid var(--outline); }
.recommendation-card:hover { border-color: var(--primary); }
.recommendation-loading, .recommendation-empty, .recommendation-error { display: flex; align-items: center; gap: 8px; padding: 16px 5px; color: var(--muted); font-size: 10px; }
.recommendation-error { color: var(--danger); }
.recommendation-more { width: 100%; justify-content: center; margin-top: 10px; }
</style>
