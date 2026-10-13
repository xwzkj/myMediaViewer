<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { PixivSearchResponse, Work, WorksResponse } from '../../shared/types'
import { api } from '../api'
import { readRecommendationSource, writeRecommendationSource, type SearchSource } from '../library-state'
import { createRecommendationSession } from '../recommendation-session'
import Icon from './Icon.vue'

const props = defineProps<{ work: Work; cloudEnabled?: boolean }>()
const emit = defineEmits<{ open: [work: Work, listKey: string]; favorite: [work: Work]; cloudFavorite: [work: Work]; notice: [message: string] }>()
const source = ref<SearchSource>(readRecommendationSource())
const items = ref<Work[]>([])
const loading = ref(false)
const error = ref('')
const page = ref(1)
const pages = ref(1)
const cursor = ref<string | null>(null)
let loadVersion = 0
let controller: AbortController | undefined
const cloudAvailable = computed(() => Boolean(props.cloudEnabled && props.work.pixivId))

if (!cloudAvailable.value && source.value === 'cloud') source.value = 'local'

watch(source, value => writeRecommendationSource(value))
watch(() => [props.work.id, props.work.pixivId, source.value, cloudAvailable.value], () => { void load(true) }, { immediate: true })
onBeforeUnmount(() => { loadVersion++; controller?.abort() })

async function load(reset = false) {
  if (source.value === 'cloud' && !cloudAvailable.value) { source.value = 'local'; return }
  const version = ++loadVersion
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  if (reset) { items.value = []; cursor.value = null; page.value = 1; pages.value = 1 }
  loading.value = true; error.value = ''
  try {
    if (source.value === 'cloud') {
      const params = new URLSearchParams()
      if (!reset && cursor.value) params.set('cursor', cursor.value)
      const response = await api<PixivSearchResponse>(`/pixiv/works/${encodeURIComponent(props.work.pixivId!)}/related?${params}`, { signal })
      if (version !== loadVersion) return
      items.value = reset ? response.items : [...items.value, ...response.items]
      cursor.value = response.nextCursor
      pages.value = response.nextCursor ? 2 : 1
      page.value = reset ? 1 : page.value + 1
    } else {
      const response = await api<WorksResponse>(`/works/${encodeURIComponent(props.work.id)}/related?page=${reset ? 1 : page.value + 1}`, { signal })
      if (version !== loadVersion) return
      items.value = reset ? response.items : [...items.value, ...response.items]
      page.value = response.page
      pages.value = response.pages
    }
  } catch (e) {
    if (version !== loadVersion) return
    const message = (e as Error).message
    if (reset || !items.value.length) error.value = message
    else emit('notice', `加载更多失败：${message}`)
  }
  finally { if (version === loadVersion) loading.value = false }
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
        <button type="button" class="recommendation-open" :aria-label="item.title" @click="openWork(item)"><img :src="item.cover" :alt="item.title" loading="lazy" decoding="async" /></button>
        <div class="recommendation-favorites">
          <button v-if="item.hasLocal !== false" type="button" class="icon-button" :class="{ selected: item.favorite }" :aria-label="item.favorite ? '取消本地收藏' : '加入本地收藏'" :aria-pressed="item.favorite" @click="emit('favorite', item)"><Icon :name="item.favorite ? 'heart-filled' : 'heart'" :size="18" /></button>
          <button v-if="cloudEnabled && item.pixivId" type="button" class="icon-button" :class="{ selected: item.cloudBookmark?.bookmarked }" :aria-label="item.cloudBookmark?.bookmarked ? '取消 Pixiv 云端收藏' : '加入 Pixiv 云端收藏'" :aria-pressed="item.cloudBookmark?.bookmarked === true" @click="emit('cloudFavorite', item)"><Icon :name="item.cloudBookmark?.bookmarked ? 'cloud-heart' : 'cloud'" :size="18" /></button>
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
.recommendation-card { position: relative; padding: 0; overflow: hidden; border: 1px solid var(--outline); border-radius: 10px; background: var(--surface-high); aspect-ratio: 1 / 1.18; }
.recommendation-open { display: block; width: 100%; height: 100%; padding: 0; background: transparent; }
.recommendation-favorites { position: absolute; right: 6px; bottom: 6px; display: flex; gap: 4px; }
.recommendation-favorites .icon-button { width: 34px; height: 34px; background: var(--surface); box-shadow: 0 1px 6px #0003; color: var(--text); }
.recommendation-favorites .icon-button.selected { background: var(--primary-container); color: var(--on-container); }
.recommendation-card:hover { border-color: var(--primary); }
.recommendation-card img { display: block; width: 100%; height: 100%; object-fit: cover; }
.recommendation-loading, .recommendation-empty, .recommendation-error { display: flex; align-items: center; gap: 8px; padding: 16px 5px; color: var(--muted); font-size: 10px; }
.recommendation-error { color: var(--danger); }
.recommendation-more { width: 100%; justify-content: center; margin-top: 10px; }
</style>
