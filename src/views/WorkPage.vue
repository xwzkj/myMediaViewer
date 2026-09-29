<script setup lang="ts">
import { ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import type { Work, WorkDetail } from '../../shared/types'
import { tagQuery } from '../../shared/search-query'
import { api } from '../api'
import { adjacentWork, librarySession } from '../library-session'
import { appEvents } from '../events'
import { createSearchSessionId } from '../route-cache-key'
import Icon from '../components/Icon.vue'
import ViewerDialog from '../components/ViewerDialog.vue'

const route = useRoute()
const router = useRouter()
const work = ref<Work | null>(null)
const loading = ref(true)
const error = ref('')
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined

async function load() {
  loading.value = true
  error.value = ''
  try {
    work.value = await api<WorkDetail>(`/works/${encodeURIComponent(String(route.params.workId))}`)
  } catch (e) {
    work.value = null
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function close() {
  const from = typeof route.query.from === 'string' ? route.query.from : '/'
  router.replace(from)
}

function notice(message: string) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 4200)
}

async function toggleFavorite(target: Work) {
  const next = !target.favorite
  try {
    await api(`/works/${encodeURIComponent(target.id)}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite: next }) })
    target.favorite = next
    if (work.value?.id === target.id) work.value.favorite = next
    notice(next ? '已加入我的收藏' : '已取消收藏')
  } catch (e) {
    notice((e as Error).message)
  }
}

function openSearch(query: string) {
  router.push({ name: 'search', query: { q: query, from: route.fullPath, sid: createSearchSessionId() } })
}

function searchTag(tag: string) {
  openSearch(tagQuery(tag))
}

function searchAuthor(author: string) {
  openSearch(author)
}

async function navigateWork(direction: number, auto = false) {
  if (!work.value) return
  let target = adjacentWork(work.value.id, direction)
  if (!target && direction > 0 && librarySession.page < librarySession.pages && librarySession.loadMore) {
    await librarySession.loadMore()
    target = adjacentWork(work.value.id, direction)
  }
  if (!target) {
    if (!auto) notice(direction > 0 ? '已经是最后一组作品' : '已经是第一组作品')
    return
  }
  // 作品页内部翻页只替换当前记录，浏览器返回应回到来源列表而不是上一部作品。
  router.replace({ name: 'work', params: { workId: target.id }, query: route.query })
}

watch(() => route.params.workId, load, { immediate: true })

onBeforeRouteLeave(to => {
  if (to.name === 'work' || !work.value) return
  const returnPath = typeof route.query.from === 'string' ? route.query.from : ''
  if (returnPath) appEvents.emit('work:return', { workId: work.value.id, returnPath })
})
</script>

<template>
  <ViewerDialog v-if="work" page :work="work" @close="close" @favorite="toggleFavorite" @notice="notice" @search-tag="searchTag" @search-author="searchAuthor" @navigate="navigateWork" />
  <div v-else class="route-state"><span v-if="loading" class="spinner" />{{ loading ? '正在打开作品…' : error || '作品不存在' }}<button v-if="!loading" class="button tonal" @click="router.push('/')"><Icon name="left" :size="18" />返回媒体库</button></div>
  <Transition name="toast"><div v-if="toast" class="snackbar" role="status"><Icon name="success" :size="20" /><span>{{ toast }}</span></div></Transition>
</template>
