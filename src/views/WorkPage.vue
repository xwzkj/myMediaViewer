<script setup lang="ts">
import { computed, nextTick, ref, watch, onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import type { PixivBookmarkUpdateResult, PixivStatus, Work, WorkDetail } from '../../shared/types'
import { tagQuery } from '../../shared/search-query'
import { api } from '../api'
import { adjacentWork, getLibrarySession, releaseLibrarySession, retainLibrarySession } from '../library-session'
import { appEvents, type PixivAuthChangedPayload, type PixivBookmarkSyncedPayload } from '../events'
import { createSearchSessionId } from '../route-cache-key'
import { pushPage, replacePage, returnFromPage } from '../navigation'
import { usePageRoute } from '../use-page-route'
import Icon from '../components/Icon.vue'
import AppNotice from '../components/AppNotice.vue'
import { useNotice } from '../use-notice'
import WorkViewer from '../components/WorkViewer.vue'

defineOptions({ name: 'WorkPage' })

const router = useRouter()
// helper 自身快照：失活后不再跟随全局，保证返回缓存 A 时不重跑、不串 B 的状态。
const { route: pageRoute, active: pageActive, pageKey } = usePageRoute()
const route = pageRoute
const isActive = pageActive
void pageKey
const listKey = computed(() => typeof route.value.query.list === 'string' ? route.value.query.list : '')
const instancePid = computed(() => typeof route.value.query.pid === 'string' ? route.value.query.pid : '')
const cloudWork = computed(() => route.value.name === 'cloudWork')
const work = ref<WorkDetail | null>(null)
const pixivStatus = ref<PixivStatus | null>(null)
const loading = ref(true)
const error = ref('')
const navigating = ref(false)
const favoriteRequests = new Set<string>()
// 详情返回生命周期：前后翻页后工作 id 已变，回来源时标记 changed 供来源直接定位。
const returnedChanged = ref(false)
const savedScrollY = ref(0)
// 宽屏（>700px）下 .viewer-page 固定 100dvh 且 overflow:hidden，滚动发生在 .work-info
// 这个 overflow-y:auto 的独立容器里，window.scrollY 恒为 0。KeepAlive 失活会把子树从
// 文档里摘掉，元素一旦脱离文档 scrollTop 即归零；所以 aside 的滚动位置必须和 window 的
// 一样在离开前采集、回来渲染后恢复，否则从推荐作品返回时列表会跳回作品信息顶部。
const savedAsideScroll = ref(0)
let loadVersion = 0
let pixivVersion = 0
let retainedListKey = ''
let statusDirty = false
// 详情旧 work/auth 版本：失效时清展示，激活才重载；inactive 只 dirty 不 reload。
let workRequestVersion = 0
onUnmounted(() => { loadVersion++; pixivVersion++; workRequestVersion++ })
const { toast, notice, dismiss, runAction } = useNotice()

function retainList(key: string) {
  if (!key || key === retainedListKey) return
  if (retainedListKey) releaseLibrarySession(retainedListKey)
  retainedListKey = key
  retainLibrarySession(key)
}

// 云端作品详情的来源提示：服务端不知道用户是从哪儿点进来的，这里按来源路由补上，
// 让「来源」字段能区分云搜索与云推荐；不可解析或来源是收藏夹/作者页时不带提示，
// 服务端按收藏状态给中性来源。收藏夹里的作品由服务端按 restrict 覆盖，提示不生效。
function cloudSourceHint(): string {
  if (!cloudWork.value) return ''
  const from = typeof route.value.query.from === 'string' ? route.value.query.from : ''
  if (!from.startsWith('/')) return ''
  try {
    const resolved = router.resolve(from)
    if (resolved.name === 'cloudSearch') return 'search'
    if (resolved.name === 'cloudWork') return 'related'
  } catch { /* from 不可解析时退回中性来源 */ }
  return ''
}

async function load() {
  const version = ++loadVersion
  const requestVersion = workRequestVersion
  const id = String(route.value.params.workId)
  if (!cloudWork.value && id.startsWith('pixiv:')) {
    await replacePage(router, { name: 'cloudWork', params: { workId: id.slice(6) }, query: route.value.query }, route.value)
    return
  }
  // 同实例前后翻页：先同步清空旧展示，再加载新作品，避免闪现旧内容。
  work.value = null
  loading.value = true
  error.value = ''
  try {
    const hint = cloudSourceHint()
    const value = await api<WorkDetail>(cloudWork.value
      ? `/pixiv/works/${encodeURIComponent(id)}${hint ? `?from=${hint}` : ''}`
      : `/works/${encodeURIComponent(id)}`)
    if (version === loadVersion && requestVersion === workRequestVersion) work.value = value
  } catch (e) {
    if (version !== loadVersion || requestVersion !== workRequestVersion) return
    work.value = null
    error.value = (e as Error).message
  } finally {
    if (version === loadVersion && requestVersion === workRequestVersion) loading.value = false
  }
}

async function refreshPixivStatus() {
  const version = ++pixivVersion
  try {
    const value = await api<PixivStatus>('/pixiv/status')
    if (version !== pixivVersion) return
    const previous = pixivStatus.value
    const authChanged = previous
      && (previous.settings.configured !== value.settings.configured
        || previous.settings.localMode !== value.settings.localMode
        || (previous.settings.account?.id || '') !== (value.settings.account?.id || ''))
    pixivStatus.value = value
    if (authChanged) {
      // 账号/本地模式/账号 id 变化：有旧作品也必须失效（不只 !work 才 dirty）。
      statusDirty = true
      appEvents.emit('pixiv:auth-changed', {
        configured: value.settings.configured,
        localMode: value.settings.localMode,
        accountId: value.settings.account?.id,
      })
      if (isActive.value) {
        statusDirty = false
        void load()
      }
    }
  } catch {
    if (version === pixivVersion) pixivStatus.value = null
  }
}

// 跨页同步监听：auth/bookmark 只收不发（本页 emit 已在 toggle 单点），避免循环 emit。
// auth 变化：清旧展示并推进版本作废在途；inactive 只 dirty，activated 才 reload。
function handleAuthChanged(payload: PixivAuthChangedPayload) {
  const previous = pixivStatus.value
  if (!previous) {
    pixivStatus.value = null
    statusDirty = true
    return
  }
  const changed = previous.settings.configured !== payload.configured
    || previous.settings.localMode !== payload.localMode
    || (previous.settings.account?.id || '') !== (payload.accountId || '')
  if (!changed) return
  pixivStatus.value = null
  workRequestVersion++
  work.value = null
  statusDirty = true
  if (isActive.value) {
    statusDirty = false
    void refreshPixivStatus()
    void load()
  }
}
// bookmark 同步：只更新本地展示（主作品 + 来源列表镜像），不回 emit。
function handleBookmarkSynced(payload: PixivBookmarkSyncedPayload) {
  const next = { bookmarked: payload.bookmarked, restrict: payload.restrict }
  if (work.value && (work.value.pixivId || work.value.externalId) === payload.illustId) {
    work.value.cloudBookmark = next
  }
  const session = listKey.value ? getLibrarySession(listKey.value) : undefined
  if (session) {
    for (const item of session.items) {
      if ((item.pixivId || item.externalId) === payload.illustId) item.cloudBookmark = next
    }
  }
}

function close() {
  void returnFromPage(router, route.value)
}

function goLibrary() {
  void pushPage(router, { name: 'library' })
}

onMounted(() => {
  appEvents.on('pixiv:auth-changed', handleAuthChanged)
  appEvents.on('pixiv:bookmark-synced', handleBookmarkSynced)
})

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
    appEvents.emit('pixiv:bookmark-synced', { illustId, bookmarked: response.bookmarked, restrict: response.restrict })
    notice(response.warning || (response.bookmarked ? '已加入 Pixiv 云端收藏' : '已取消 Pixiv 云端收藏'))
  } catch (e) {
    notice((e as Error).message)
  } finally { favoriteRequests.delete(key) }
}

function openSearch(query: string) {
  const source = cloudWork.value ? 'cloudSearch' : 'search'
  // 标签/作者搜索永远是作品维度，不受云搜 users 记忆污染。
  const business = source === 'cloudSearch'
    ? { q: query, from: route.value.fullPath, sid: createSearchSessionId(), entity: 'works' }
    : { q: query, from: route.value.fullPath, sid: createSearchSessionId() }
  void pushPage(router, { name: source, query: business })
}

function searchTag(tag: string) {
  openSearch(cloudWork.value ? tag : tagQuery(tag))
}

function searchAuthor(author: string) {
  openSearch(author)
}

function openAuthor(target: Work) {
  const directId = target.pixivUserId
  if (directId) {
    void pushPage(router, { name: 'cloudUser', params: { userId: directId }, query: { from: route.value.fullPath } })
    return
  }
  // 详情条目缺 UID：按需取一次对应详情补 UID，仍无则 notice，不静默跳搜索。
  void (async () => {
    try {
      const id = String(route.value.params.workId)
      const detail = await api<WorkDetail>(cloudWork.value ? `/pixiv/works/${encodeURIComponent(id)}` : `/works/${encodeURIComponent(id)}`)
      if (detail.pixivUserId) {
        if (work.value) work.value.pixivUserId = detail.pixivUserId
        await pushPage(router, { name: 'cloudUser', params: { userId: detail.pixivUserId }, query: { from: route.value.fullPath } })
      } else {
        notice('该作品暂无可用的创作者主页')
      }
    } catch (e) {
      notice((e as Error).message)
    }
  })()
}

function openRelated(target: Work, key: string) {
  const nextCloud = target.hasLocal === false || target.id.startsWith('pixiv:')
  // 相关推荐进入新作品：新历史实例（pushPage 发新 pid），from 设为当前 fullPath
  //（直接父），list 为推荐快照，保证 B 的返回直达 A。
  void pushPage(router, {
    name: nextCloud ? 'cloudWork' : 'work',
    params: { workId: nextCloud ? (target.pixivId || target.externalId) : target.id },
    query: { ...route.value.query, from: route.value.fullPath, list: key },
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
  // 来源 inactive 也允许显式分页加载：本函数是用户手势驱动，不受活跃门禁阻断。
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
  returnedChanged.value = true
  const nextCloud = target.hasLocal === false || target.id.startsWith('pixiv:')
  await replacePage(router, { name: nextCloud ? 'cloudWork' : 'work', params: { workId: nextCloud ? (target.pixivId || target.externalId) : target.id }, query: route.value.query }, route.value)
  } catch (e) { if (!auto) notice((e as Error).message) }
  finally { navigating.value = false }
}

// 稳定标量 key：同 workId+name+pid 内 fullPath 变化（如 from/list 透传）不重载。
const workIdentity = computed(() => `${String(route.value.name || '')}:${String(route.value.params.workId || '')}:${instancePid.value}`)
watch(workIdentity, () => {
  dismiss()
  retainList(listKey.value)
  void load()
}, { immediate: true })
watch(() => route.value.fullPath, () => { void refreshPixivStatus() }, { immediate: true })

// 失活的 KeepAlive 子树会被移入游离容器，document 里只剩当前实例，querySelector 不会拿错页。
function asideScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.work-info')
}
// 离开详情前采集滚动：窄屏滚 window，宽屏滚 .work-info，两套容器都要记。
function captureScroll() {
  savedScrollY.value = window.scrollY
  savedAsideScroll.value = asideScroller()?.scrollTop ?? 0
}
// router scrollBehavior 对 from work 返回 false（不碰滚动），由页面统一在渲染后恢复；
// nextTick+双 RAF 保证 DOM 高度就绪后才定位，避免被后续渲染覆盖。
function restoreScroll() {
  const targetY = savedScrollY.value
  const targetAside = savedAsideScroll.value
  void nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.scrollTo(0, targetY)
        // 首次挂载时 targetAside 为 0：不复位容器，避免覆盖别处刚恢复的位置。
        const aside = asideScroller()
        if (aside && targetAside > 0) aside.scrollTop = targetAside
      })
    })
  })
}

onActivated(() => {
  restoreScroll()
  // 统一父失效：auth 变化的旧父 work 已在 handleAuthChanged 清掉；
  // viewer unmount 由 WorkViewer 自身 onUnmounted 释放资源，这里只负责重载。
  // inactive 不 reload 只 dirty+clear，回来（activated）才 reload。
  if (statusDirty) {
    statusDirty = false
    void refreshPixivStatus()
    void load()
  }
})
onDeactivated(() => {
  // 只 dismiss：滚动只由 onBeforeRouteLeave 捕获。deactivated 时新页 CSS
  //（viewer fixed body）已迫使 window.scrollY 归 0，这里再写会覆盖有效值。
  dismiss()
})

onUnmounted(() => {
  appEvents.off('pixiv:auth-changed', handleAuthChanged)
  appEvents.off('pixiv:bookmark-synced', handleBookmarkSynced)
  if (retainedListKey) {
    releaseLibrarySession(retainedListKey)
    retainedListKey = ''
  }
})

onBeforeRouteLeave(to => {
  // 离开详情前捕获滚动：唯一写入点。同作品 prev/next 内部导航同样经过这里，
  // 照常记录（router 对同 pid replace 返回 false，由 onActivated 恢复）。
  captureScroll()
  if (!work.value) return
  const returnPath = typeof route.value.query.from === 'string' ? route.value.query.from : ''
  if (!returnPath) return
  // 只在回到 recorded from 时才发事件：去作者/搜索/设置等不误发到原列表；
  // 去嵌套详情（推荐 B）必须发（父列表不用锚，但 B 返回父 A 需要事件定位）。
  const isNestedDetail = to.name === 'work' || to.name === 'cloudWork' || to.name === 'cloudUser'
  const backToRecordedFrom = to.fullPath === returnPath
  if (!isNestedDetail && !(backToRecordedFrom && returnedChanged.value)) return
  // sourcePid 从 recorded from 解析：来源按自己的 pid 比较才匹配。
  let sourcePid: string | undefined
  try {
    const resolved = router.resolve(returnPath)
    if (typeof resolved.query.pid === 'string' && resolved.query.pid) sourcePid = resolved.query.pid
  } catch { /* from 不可解析时不带 pid，来源按 returnPath 匹配 */ }
  appEvents.emit('work:return', { workId: work.value.id, returnPath, sourcePid, changed: returnedChanged.value || undefined })
})
</script>

<template>
  <WorkViewer v-if="work" :work="work" :active="isActive" :navigating="navigating || loading" :cloud-enabled="Boolean(pixivStatus?.settings.configured && !pixivStatus.settings.localMode)" @close="close" @favorite="toggleFavorite" @cloud-favorite="toggleCloudFavorite" @open-related="openRelated" @notice="notice" @search-tag="searchTag" @open-author="openAuthor" @search-author="searchAuthor" @navigate="navigateWork" />
  <div v-else class="route-state"><span v-if="loading" class="spinner" />{{ loading ? '正在打开作品…' : error || '作品不存在' }}<button v-if="!loading" class="button tonal" @click="goLibrary"><Icon name="left" :size="18" />返回媒体库</button></div>
  <AppNotice :notice="toast" @dismiss="dismiss" @action="runAction" />
</template>
