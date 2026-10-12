<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import type { PixivBookmarkUpdateResult, PixivStatus, Work, WorkDetail } from '../../shared/types'
import { tagQuery } from '../../shared/search-query'
import { api } from '../api'
import { adjacentWork, getLibrarySession } from '../library-session'
import { appEvents } from '../events'
import { createSearchSessionId } from '../route-cache-key'
import Icon from '../components/Icon.vue'
import AppNotice from '../components/AppNotice.vue'
import { useNotice } from '../use-notice'
import WorkViewer from '../components/WorkViewer.vue'

const route = useRoute()
const router = useRouter()
const listKey = computed(() => typeof route.query.list === 'string' ? route.query.list : '')
const cloudWork = computed(() => route.name === 'cloudWork')
const work = ref<WorkDetail | null>(null)
const pixivStatus = ref<PixivStatus | null>(null)
const loading = ref(true)
const error = ref('')
const navigating = ref(false)
const favoriteRequests = new Set<string>()
let loadVersion = 0
onBeforeUnmount(() => { loadVersion++ })
const { toast, notice, dismiss, runAction } = useNotice()

async function load() {
  const version = ++loadVersion
  const id = String(route.params.workId)
  if (!cloudWork.value && id.startsWith('pixiv:')) {
    await router.replace({ name: 'cloudWork', params: { workId: id.slice(6) }, query: route.query })
    return
  }
  loading.value = true
  error.value = ''
  try {
    const value = await api<WorkDetail>(cloudWork.value ? `/pixiv/works/${encodeURIComponent(id)}` : `/works/${encodeURIComponent(id)}`)
    if (version === loadVersion) work.value = value
  } catch (e) {
    if (version !== loadVersion) return
    work.value = null
    error.value = (e as Error).message
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

function close() {
  const from = typeof route.query.from === 'string' ? route.query.from : '/'
  router.replace(from)
}

async function toggleFavorite(target: Work) {
  const key = `local:${target.id}`
  if (target.hasLocal === false || favoriteRequests.has(key)) return
  favoriteRequests.add(key)
  const next = !target.favorite
  try {
    await api(`/works/${encodeURIComponent(target.id)}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite: next }) })
    target.favorite = next
    if (work.value?.id === target.id) work.value.favorite = next
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
    const response = await api<PixivBookmarkUpdateResult>(`/pixiv/works/${illustId}/bookmark`, { method: 'PUT', body: JSON.stringify({ bookmarked: next }) })
    target.cloudBookmark = { bookmarked: response.bookmarked, restrict: response.restrict }
    if (work.value?.pixivId === illustId) work.value.cloudBookmark = target.cloudBookmark
    notice(response.warning || (response.bookmarked ? '已加入 Pixiv 云端收藏' : '已取消 Pixiv 云端收藏'))
  } catch (e) {
    notice((e as Error).message)
  } finally { favoriteRequests.delete(key) }
}

function openSearch(query: string) {
  const source = cloudWork.value ? 'cloudSearch' : 'search'
  router.push({ name: source, query: { q: query, from: route.fullPath, sid: createSearchSessionId() } })
}

function searchTag(tag: string) {
  openSearch(cloudWork.value ? tag : tagQuery(tag))
}

function searchAuthor(author: string) {
  openSearch(author)
}

function openRelated(target: Work, listKey: string) {
  const nextCloud = target.hasLocal === false || target.id.startsWith('pixiv:')
  void router.push({
    name: nextCloud ? 'cloudWork' : 'work',
    params: { workId: nextCloud ? (target.pixivId || target.externalId) : target.id },
    query: { ...route.query, list: listKey },
  })
}

async function navigateWork(direction: number, auto = false) {
  if (!work.value || navigating.value || loading.value) return
  const originalId = work.value.id
  const key = listKey.value
  if (!key) {
    if (!auto) notice('当前作品没有可用的来源列表')
    return
  }
  navigating.value = true
  try {
  let target = adjacentWork(key, work.value.id, direction)
  const session = getLibrarySession(key)
  if (!target && direction > 0 && session && session.page < session.pages && session.loadMore) {
    await session.loadMore()
    if (work.value?.id !== originalId) return
    target = adjacentWork(key, originalId, direction)
  }
  if (!target) {
    if (!auto) notice(direction > 0 ? '已经是最后一组作品' : '已经是第一组作品')
    return
  }
  // 作品页内部翻页只替换当前记录，浏览器返回应回到来源列表而不是上一部作品。
  const nextCloud = target.hasLocal === false || target.id.startsWith('pixiv:')
  await router.replace({ name: nextCloud ? 'cloudWork' : 'work', params: { workId: nextCloud ? (target.pixivId || target.externalId) : target.id }, query: route.query })
  } catch (e) { if (!auto) notice((e as Error).message) }
  finally { navigating.value = false }
}

watch(() => [route.params.workId, route.name], () => { dismiss(); void load() }, { immediate: true })
watch(() => route.fullPath, async () => {
  try { pixivStatus.value = await api<PixivStatus>('/pixiv/status') } catch { pixivStatus.value = null }
}, { immediate: true })

onBeforeRouteLeave(to => {
  if (to.name === 'work' || !work.value) return
  const returnPath = typeof route.query.from === 'string' ? route.query.from : ''
  if (returnPath) appEvents.emit('work:return', { workId: work.value.id, returnPath })
})
</script>

<template>
  <WorkViewer v-if="work" :work="work" :navigating="navigating || loading" :cloud-enabled="Boolean(pixivStatus?.settings.configured && !pixivStatus.settings.localMode)" @close="close" @favorite="toggleFavorite" @cloud-favorite="toggleCloudFavorite" @open-related="openRelated" @notice="notice" @search-tag="searchTag" @search-author="searchAuthor" @navigate="navigateWork" />
  <div v-else class="route-state"><span v-if="loading" class="spinner" />{{ loading ? '正在打开作品…' : error || '作品不存在' }}<button v-if="!loading" class="button tonal" @click="router.push('/')"><Icon name="left" :size="18" />返回媒体库</button></div>
  <AppNotice :notice="toast" @dismiss="dismiss" @action="runAction" />
</template>
