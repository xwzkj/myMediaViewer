<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, onUnmounted, onActivated, onDeactivated, onMounted, watch } from 'vue'
import type { AiTranslateFields, AiTranslateResult, MangaJob, MangaPageResult, WorkDetail, Work } from '../../shared/types'
import { showImagePreview } from 'vant'
import type { ImagePreviewOptions } from 'vant'
import { api, formatSize, kindLabel } from '../api'
import Icon from './Icon.vue'
import { nearbyImages, createViewerImageCache, revealThumbnail, nextTranslationDisplay, metadataVisibility, resolveAssetUrl, resolvePreviewSource, originalAssetUrl, rubberBandOffset, resolveSwipeRelease, swipeSettleDuration, swipeVelocity, constrainZoom, zoomAt, type ZoomState } from '../viewer-media'

import { drawMangaRegion } from '../manga-layout'
import { vReleaseVideo, releaseVideos } from '../video-lifecycle'
import type { Notice, NoticeAction } from '../use-notice'
import WorkRecommendations from './WorkRecommendations.vue'
import SmoothThumbnail from './SmoothThumbnail.vue'

const props = defineProps<{ work: WorkDetail; active?: boolean; navigating?: boolean; cloudEnabled?: boolean }>()
const emit = defineEmits<{ close: []; favorite: [work: Work]; cloudFavorite: [work: Work]; openRelated: [work: Work, listKey: string]; notice: [message: string, action?: NoticeAction, tone?: Notice['tone']]; searchTag: [tag: string]; openAuthor: [work: Work]; searchAuthor: [author: string]; navigate: [direction: number, auto?: boolean] }>()
// 在线作者走应用内主页：有 pixivUserId 且为在线条目才可点；本地作者保留按名搜索。
const onlineAuthor = computed(() => Boolean(props.work.pixivUserId && (props.work.hasLocal === false || props.work.origin === 'pixiv' || props.work.id.startsWith('pixiv:'))))
const root = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const filmstrip = ref<HTMLElement>()
const images = createViewerImageCache()
let drawVersion = 0
const video = ref<HTMLVideoElement>()
onBeforeUnmount(() => {
  window.removeEventListener('keydown', keyboard)
  document.removeEventListener('error', previewImageError, true)
  document.removeEventListener('wheel', previewWheel)
  document.removeEventListener('pointerdown', previewPointerDown)
  document.removeEventListener('pointermove', previewPointerMove)
  document.removeEventListener('pointerup', previewPointerUp)
  document.removeEventListener('pointercancel', previewPointerUp)
  if (root.value) releaseVideos(root.value)
})
onMounted(() => {
  window.addEventListener('keydown', keyboard)
  // Vant ImagePreview 只处理触摸：桌面端的原图兜底、滚轮缩放与拖拽平移在这里补。
  document.addEventListener('error', previewImageError, true)
  document.addEventListener('wheel', previewWheel, { passive: false })
  document.addEventListener('pointerdown', previewPointerDown)
  document.addEventListener('pointermove', previewPointerMove)
  document.addEventListener('pointerup', previewPointerUp)
  document.addEventListener('pointercancel', previewPointerUp)
})
const detail = computed(() => props.work)
const index = ref(0)
const mediaError = ref(false)
const mediaRetryToken = ref(0)
const previewing = ref(false)
const slideshow = ref(false)
const converting = ref(false)
const convertMessage = ref('')
const compatible = ref(false)
const ugoiraImageFallback = ref(false)
const originalAssets = ref<Set<string>>(new Set())
// 图片翻译：保留原图 / 已擦字译图两种显示方式；OCR 与译文都从服务端任务返回。
const mangaResults = ref<Record<string, MangaPageResult>>({})
const mangaJob = ref<MangaJob | null>(null)
const mangaMode = ref<'source' | 'translated'>('source')
const mangaError = ref('')
const mangaScopeOpen = ref(false)
const mangaCanvas = ref<HTMLCanvasElement>()
let mangaTimer: ReturnType<typeof setTimeout> | undefined
let mangaToken = 0
// 翻译：显示模式控制只显示原文、只显示译文，或两者对照。
type TranslationDisplay = 'source' | 'translated' | 'both'
const translation = ref<AiTranslateResult | null>(null)
const translating = ref(false)
const translationError = ref('')
const translationDisplay = ref<TranslationDisplay>('translated')
const translationDisplayLabels: Record<TranslationDisplay, string> = { source: '仅原文', translated: '仅译文', both: '原文 + 译文' }
let timer: ReturnType<typeof setInterval> | undefined
let conversionTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const asset = computed(() => detail.value?.assets[index.value])
const isVideo = computed(() => asset.value && !ugoiraImageFallback.value && (asset.value.kind === 'video' || asset.value.extension === 'webm'))
const canTranslateManga = computed(() => asset.value?.kind === 'image' && asset.value.extension !== 'gif')
const mangaResult = computed(() => asset.value ? mangaResults.value[asset.value.id] || null : null)
const mangaPageAssets = computed(() => (detail.value?.assets || []).filter(item => item.kind === 'image' && item.extension !== 'gif'))
const mangaBusy = computed(() => mangaJob.value?.state === 'queued' || mangaJob.value?.state === 'processing')
// 任务失败（整任务失败或部分页面失败）时，把失败页码和原因都列出来，而不是只报一句“有几张失败”。
const mangaFailures = computed(() => {
  const failed = mangaJob.value?.failed
  if (!failed?.length) return []
  const assets = detail.value?.assets || []
  return failed.map(item => {
    const at = assets.findIndex(asset => asset.id === item.assetId)
    return { assetId: item.assetId, page: at >= 0 ? `第 ${at + 1} 张` : '图片', message: item.message }
  })
})
const mediaUrl = computed(() => {
  let url: string | undefined
  if (compatible.value && asset.value?.origin !== 'pixiv') url = `/api/assets/${asset.value?.id}/compatible`
  else if (asset.value?.origin === 'pixiv' && originalAssets.value.has(asset.value.id)) {
    url = `/api/pixiv/assets/${asset.value.illustId}/${asset.value.page}/original`
  } else {
    url = asset.value?.url
  }
  if (url && ugoiraImageFallback.value) {
    url = `${url}${url.includes('?') ? '&' : '?'}format=webp`
  }
  if (url && asset.value?.origin === 'pixiv' && mediaRetryToken.value) {
    return `${url}${url.includes('?') ? '&' : '?'}retry=${mediaRetryToken.value}`
  }
  return url
})

// 切换分 P / 作品时丢弃旧图翻译状态，后台任务即使稍后完成也不会覆盖当前页面。
function resetManga() {
  mangaToken++
  drawVersion++
  images.clear()
  clearTimeout(mangaTimer)
  mangaTimer = undefined
  mangaJob.value = null
  mangaResults.value = {}
  mangaMode.value = 'source'
  mangaError.value = ''
  mangaScopeOpen.value = false
}
const isActive = computed(() => props.active ?? true)
function startSlideshowTimer() {
  stopSlideshowTimer()
  timer = setInterval(() => { if (slideshow.value && !isVideo.value && !previewing.value && isActive.value) next(1, true) }, 4500)
}
function stopSlideshowTimer() {
  if (timer) clearInterval(timer)
  timer = undefined
}
function pauseMediaForLeave() {
  // 离屏仅暂停：保留 currentTime/src，回来看 cached 可继续；不释放资源。
  try { video.value?.pause() } catch { /* 离屏暂停失败不影响返回 */ }
  // 批准语义：halt 自动翻页，返回不自动续播，由用户显式再开。
  slideshow.value = false
  stopSlideshowTimer()
  clearTimeout(mangaTimer)
  mangaTimer = undefined
  clearTimeout(conversionTimer)
  conversionTimer = undefined
  closePreview(true)
}
// 可续查的在途任务：只记 GET 可恢复的 job 查询，不记 POST 提交。
let resumableMangaJobId = ''
let resumableConversionAssetId = ''
let resumeInFlight = false
async function resumeJobStatus() {
  // activated 只 GET 续查，不 POST 新任务；单次在途防重复 timer；token 守卫防旧页串新页。
  if (resumeInFlight) return
  resumeInFlight = true
  const token = mangaToken
  const workId = props.work.id
  try {
    if (resumableMangaJobId && mangaBusy.value) {
      const jobId = resumableMangaJobId
      try {
        const job = await api<MangaJob>(`/ai/manga/jobs/${jobId}`)
        if (disposed || token !== mangaToken || workId !== props.work.id) return
        await handleMangaJob(job, token, false)
      } catch { /* 续查失败保留 job，下次激活再试 */ }
    }
    if (resumableConversionAssetId && converting.value) {
      const id = resumableConversionAssetId
      try {
        const job = await api<{ state: string; message?: string }>(`/assets/${id}/convert`)
        if (disposed || id !== asset.value?.id) return
        await handleConversionJob(job, id)
      } catch { /* 续查失败保留，下次激活再试 */ }
    }
  } finally {
    resumeInFlight = false
  }
}
startSlideshowTimer()
// 图片翻译任务句柄：在途 resolve 只排下一 timer 当 active；缓存结果允许但不串 notice。
async function handleMangaJob(job: MangaJob, token: number, notify: boolean) {
  if (disposed || token !== mangaToken) return
  mangaJob.value = job
  if (job.state === 'queued' || job.state === 'processing') resumableMangaJobId = job.id
  else if (job.state === 'ready' || job.state === 'failed') resumableMangaJobId = ''

  const incoming = job.results || (job.result && job.currentAssetId ? [{ assetId: job.currentAssetId, result: job.result }] : [])
  for (const item of incoming) mangaResults.value[item.assetId] = item.result

  const currentResult = asset.value ? mangaResults.value[asset.value.id] : undefined
  if (currentResult) mangaMode.value = 'translated'
  if (job.state === 'ready') {
    await nextTick()
    if (currentResult) void drawMangaResult()
    // POST 响应在 deactivate 后才到：notify 为 true 也不串页，只当 active 才 emit。
    if (!notify || !isActive.value) return
    if (job.failed?.length) {
      emit('notice', `已完成 ${job.results?.length || 0}/${job.total} 张漫画翻译，${job.failed.length} 张失败：${job.failed[0].message}`, undefined, 'error')
    } else if (mangaPageAssets.value.length > 1) {
      emit('notice', `整部漫画翻译完成，共 ${job.results?.length || 0} 张`)
    } else {
      emit('notice', currentResult?.cached
        ? `已显示缓存的漫画译图（${currentResult.model || '本地 OCR'}）`
        : `漫画图片翻译完成（${currentResult?.model || '本地 OCR'}）`)
    }
    return
  }
  if (job.state === 'failed') {
    mangaError.value = job.message || job.stage || '漫画图片翻译失败'
    // 详情区会列出逐张失败的原因，这里再弹一条提示，保证离开详情区也能看到失败。
    if (notify && isActive.value) emit('notice', `图片翻译失败：${mangaError.value}`, undefined, 'error')
    return
  }
  if (!isActive.value) return
  // 排下一 timer 前清旧 timer：resume 与在途轮询可能重复，只保留最新一支。
  clearTimeout(mangaTimer)
  const delay = job.state === 'queued' ? 1200 : 800
  mangaTimer = setTimeout(async () => {
    try { await handleMangaJob(await api<MangaJob>(`/ai/manga/jobs/${job.id}`), token, isActive.value) }
    catch (e) {
      if (token !== mangaToken) return
      const message = (e as Error).message
      mangaError.value = message
      mangaJob.value = { ...job, state: 'failed', stage: '翻译失败', progress: 100, message }
      if (isActive.value) emit('notice', `图片翻译失败：${message}`, undefined, 'error')
    }
  }, delay)
}

// 兼容版本任务句柄：同上，在途只当 active 续查；结果缓存允许，notice 不串页。
async function handleConversionJob(job: { state: string; message?: string }, id: string) {
  if (disposed || id !== asset.value?.id) return
  if (job.state === 'ready') {
    compatible.value = true
    mediaError.value = false
    converting.value = false
    convertMessage.value = '正在播放兼容版本'
    resumableConversionAssetId = ''
    return
  }
  if (job.state === 'failed') {
    converting.value = false
    convertMessage.value = job.message || '转换失败'
    resumableConversionAssetId = ''
    return
  }
  resumableConversionAssetId = id
  convertMessage.value = job.state === 'queued' ? '已加入处理队列…' : '正在生成兼容版本，完成后会自动切换…'
  if (!isActive.value) return
  clearTimeout(conversionTimer)
  conversionTimer = setTimeout(async () => {
    try { await handleConversionJob(await api(`/assets/${id}/convert`), id) }
    catch (e) {
      if (disposed || id !== asset.value?.id) return
      converting.value = false
      convertMessage.value = (e as Error).message
    }
  }, 2000)
}
onActivated(() => {
  // 无条件建 interval 浪费：只在 slideshow 开启时计时；halt 后回来不自动续播。
  if (slideshow.value) startSlideshowTimer()
  void resumeJobStatus()
})
onDeactivated(() => {
  pauseMediaForLeave()
})
// 详情由作品页统一加载；切换作品后直接使用新资源，并回到第一张。
// 跨作品清可续查句柄：旧 job 绝不串新作品；旧 timer 一并清除。
watch(() => props.work.id, () => {
  const direction: 1 | -1 = slide.value >= 0 ? 1 : -1
  gesture = null
  suppressClick = false
  // 换作品时丢弃上一部的浮层与未落定的翻页，避免旧页码串到新作品。
  closePreview(false)
  settlePageImmediately()
  index.value = 0
  slide.value = 1
  clearTimeout(pageCommitTimer)
  clearTimeout(enteringTimer)
  pendingPageCommit = undefined
  pageAnimating.value = false
  pageOffset.value = 0
  settleWorkImmediately()
  entering.value = prefersReducedMotion() ? '' : direction >= 0 ? 'next' : 'prev'
  if (entering.value) enteringTimer = setTimeout(() => { entering.value = '' }, 260)
  mediaError.value = false
  mediaRetryToken.value = 0
  compatible.value = false
  ugoiraImageFallback.value = false
  converting.value = false
  convertMessage.value = ''
  originalAssets.value = new Set()
  translation.value = null
  translationError.value = ''
  translationDisplay.value = 'translated'
  resumableMangaJobId = ''
  resumableConversionAssetId = ''
  clearTimeout(mangaTimer)
  mangaTimer = undefined
  clearTimeout(conversionTimer)
  conversionTimer = undefined
  resetManga()
})
watch(index, async () => {
  // 浮层自己发起的换页不能销毁浮层；其他来源换页必须把浮层关掉。
  if (previewOwnsIndex) previewOwnsIndex = false
  else closePreview(false)
  mediaError.value = false
  mediaRetryToken.value = 0
  compatible.value = false
  ugoiraImageFallback.value = false
  converting.value = false
  convertMessage.value = ''
  clearTimeout(conversionTimer)
  mangaError.value = ''
  mangaScopeOpen.value = false
  await nextTick()
  mangaMode.value = mangaResult.value ? 'translated' : 'source'
  if (mangaResult.value) void drawMangaResult()
})
// Warm current/adjacent original images and translated bases with the same bounded cache.
watch(() => {
  const nearby = nearbyImages(detail.value?.assets || [], index.value)
  return nearby.flatMap(item => {
    const translated = mangaResults.value[item.id]
    return [{key: item.url, url: item.url}, ...(translated?.regions.length ? [{key: translated.key + ':' + translated.baseUrl, url: translated.baseUrl}] : [])]
  })
}, urls => { for (const item of urls) void images.load(item.key,item.url).catch(()=>{}) }, {immediate:true})
watch([() => asset.value?.id, filmstrip], async () => {
  await nextTick()
  const selected = filmstrip.value?.querySelector<HTMLElement>('button.active')
  if (filmstrip.value && selected) revealThumbnail(filmstrip.value, selected, !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}, {flush:'post'})
// Cache lookup only: warming a translated neighbour must never start OCR/translation.
watch(() => asset.value?.id, async (assetId, _previous, onCleanup) => {
  if (!assetId) return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const token = mangaToken
  const workId = props.work.id
  await Promise.all(nearbyImages(detail.value?.assets || [], index.value).map(async item => {
    if (item.kind !== 'image' || item.extension === 'gif' || item.origin === 'pixiv' || mangaResults.value[item.id]) return
    try {
      const { result } = await api<{ result: MangaPageResult | null }>(`/ai/manga/auto/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      if (controller.signal.aborted || disposed || token !== mangaToken || workId !== props.work.id || mangaBusy.value || mangaResults.value[item.id]) return
      if (result?.regions.length) {
        mangaResults.value[item.id] = result
        if (asset.value?.id === item.id) mangaMode.value = 'translated'
      }
    } catch { /* Optional warmup must not block reading the original. */ }
  }))
}, { immediate: true })
// v-if 切换会让 canvas 重新挂载；只要译图、显示模式或 canvas 实例变化，就重新绘制一次。
watch([mangaMode, () => mangaResult.value?.key, () => mangaCanvas.value], async ([mode, key, canvas]) => {
  if (mode !== 'translated' || !key || !canvas) return
  await nextTick()
  void drawMangaResult()
})
watch(slideshow, value => { if (value && isVideo.value && isActive.value) void video.value?.play().catch(() => {}) })
// 标题、作者、标签、描述一起交给 AI，保证同一组信息的译文风格一致。
const translatable = computed<AiTranslateFields>(() => {
  const tags = props.work.tags.filter(tag => tag.trim())
  const fields: AiTranslateFields = {}
  if (props.work.title.trim()) fields.title = props.work.title
  if (props.work.author.trim()) fields.author = props.work.author
  if (detail.value?.description.trim()) fields.description = detail.value.description
  if (tags.length) fields.tags = tags
  return fields
})
const hasTranslatable = computed(() => Object.keys(translatable.value).length > 0)
// 原文与译文的可见性：仅原文 / 仅译文 / 两者都显示。
const metadataDisplay = computed(() => metadataVisibility(translationDisplay.value, Boolean(translation.value)))
const sourceVisible = computed(() => metadataDisplay.value.source)
const translatedVisible = computed(() => metadataDisplay.value.translated)
const displayLabel = computed(() => translationDisplayLabels[translationDisplay.value])
// 标签成对渲染：无论显示哪种语言，点击都用原文标签去搜索。
// 译文标签按位置对应原文；模型少给或漏给时回退到原文，避免出现空标签。
// 仅译文模式下没有译文的标签仍要显示原文，否则标签会渲染成空白。
const tagRows = computed(() => props.work.tags.map((original, i) => {
  const translated = translation.value?.fields.tags?.[i]?.trim() || original
  const distinct = translated !== original
  return {
    original,
    primary: !sourceVisible.value && translatedVisible.value && distinct ? translated : original,
    secondary: sourceVisible.value && translatedVisible.value && distinct ? translated : null,
  }
}))
// 分 P 到头后继续切换作品；两个方向都从新作品的第一张开始。
function goWork(direction: number, auto = false) {
  if (props.navigating) return
  slide.value = direction
  emit('navigate', direction, auto)
}
function next(direction: number, auto = false) {
  const count = detail.value?.assets.length || 0
  if (!count) return
  const target = index.value + direction
  if (target < 0 || target >= count) { goWork(direction, auto); return }
  slide.value = direction
  goToIndex(target, direction >= 0 ? 1 : -1)
}
// 手势：在图片 / 视频区域左右滑动切换分 P，在信息区等其他位置左右滑动切换上一个 / 下一个作品。
// 位移分两段：拖动时 1:1 跟随指针（只有列表首尾之外做橡皮筋），松手后按位移 + 速度吸附到落定位。
const slide = ref(1)
const mediaKey = computed(() => `${props.work.id}:${asset.value?.id || 'empty'}:${mediaRetryToken.value}`)
/** 一屏宽度；0 表示还没量到（此时直接落位，不播放位移）。 */
const pageWidth = ref(0)
/** 当前页相对居中的横向偏移：负值表示正在看下一张。 */
const pageOffset = ref(0)
const pageAnimating = ref(false)
const pageSettleMs = ref(220)
/** 信息区（mode === 'work'）拖动时整块内容的横向偏移。 */
const workOffset = ref(0)
const workAnimating = ref(false)
const workSettleMs = ref(220)
/** 新作品第一页的入场方向，沿用原来的 26px + 透明度动画。 */
const entering = ref<'' | 'next' | 'prev'>('')
let pageCommitTimer: ReturnType<typeof setTimeout> | undefined
let pendingPageCommit: (() => void) | undefined
let workSettleTimer: ReturnType<typeof setTimeout> | undefined
let enteringTimer: ReturnType<typeof setTimeout> | undefined
let gesture: {
  pointerId: number
  startX: number
  startY: number
  mode: 'page' | 'work' | 'ignore'
  axis: 'none' | 'x' | 'y'
  width: number
  offset: number
  samples: { x: number; t: number }[]
} | null = null
let suppressClick = false
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
/** 一屏宽度：优先量媒体舞台，量不到就退回窗口宽度。 */
function stageWidth() {
  return stage.value?.clientWidth || root.value?.clientWidth || window.innerWidth || 0
}
const pagerStyle = computed(() => ({
  transform: `translateX(calc(-100% + ${pageOffset.value}px))`,
  transition: pageAnimating.value && !prefersReducedMotion() ? `transform ${pageSettleMs.value}ms cubic-bezier(.2,.8,.3,1)` : 'none',
}))
const contentStyle = computed(() => workOffset.value !== 0 || workAnimating.value
  ? { transform: `translateX(${workOffset.value}px)`, transition: workAnimating.value && !prefersReducedMotion() ? `transform ${workSettleMs.value}ms cubic-bezier(.2,.8,.3,1)` : 'none' }
  : undefined)
// 放大浮层（Vant ImagePreview）只保留我们自己的会话信息，浮层本体由 vant 托管。
type PreviewAsset = { item: WorkDetail['assets'][number]; pageIndex: number }
type PreviewSession = {
  id: number
  workId: string
  assets: PreviewAsset[]
  images: string[]
  index: number
  closing: boolean
  /** 原图地址 → 预览图地址；原图 403/404 时兜底换回。 */
  fallbacks: Map<string, string>
  /** 用 Canvas 译图代替原图的页（打开时的那一页）。 */
  translatedIndex: number
}
/** showImagePreview 返回的实例（vant 的类型是 any，这里只声明用到的部分）。 */
type ImagePreviewHandle = { close: () => void }
/** function-call 的选项类型漏掉了这两个点击开关，组件本身是支持的。 */
type MediaPreviewOptions = ImagePreviewOptions & { closeOnClickImage?: boolean; closeOnClickOverlay?: boolean }
let previewSession: PreviewSession | undefined
let previewHandle: ImagePreviewHandle | undefined
let previewSessionId = 0
/** 由浮层发起的页码同步：此时主查看器换页不能反过来销毁浮层。 */
let previewOwnsIndex = false
const previewAssets = computed<PreviewAsset[]>(() => (detail.value?.assets || [])
  .map((item, pageIndex) => ({ item, pageIndex }))
  .filter(({ item }) => item.kind === 'image' && item.extension !== 'webm'))
// 相邻页只渲染图片、最多当前 ±1 页，避免整部作品的媒体一起解码。
function neighborUrl(at: number) {
  const item = detail.value?.assets[at]
  if (!item || item.kind !== 'image' || item.extension === 'webm') return undefined
  return resolveAssetUrl(item, originalAssets.value, false)
}
const previousUrl = computed(() => neighborUrl(index.value - 1))
const nextUrl = computed(() => neighborUrl(index.value + 1))
function gestureMode(target: EventTarget | null): 'page' | 'work' | 'ignore' {
  if (!(target instanceof Element)) return 'ignore'
  // 放大浮层（teleport 到 body）里的手势交给 Vant 自己处理。
  if (target.closest('.media-gallery-preview') || target.closest('.van-image-preview')) return 'ignore'
  if (target.closest('.media-stage')) return 'page'
  if (target.closest('.filmstrip') || target.closest('button,a,input,select,textarea')) return 'ignore'
  return 'work'
}
function startGesture(target: EventTarget | null, x: number, y: number, id: number) {
  if (previewing.value) return
  // 上一段落定动画先收尾，避免从半路开始拖动，或页码在拖动中被改写。
  settlePageImmediately()
  settleWorkImmediately()
  gesture = { pointerId: id, startX: x, startY: y, mode: gestureMode(target), axis: 'none', width: stageWidth(), offset: 0, samples: [{ x, t: Date.now() }] }
  if (gesture.width) pageWidth.value = gesture.width
}
function moveGesture(id: number, x: number, y: number) {
  const active = gesture
  if (!active || active.pointerId !== id || active.mode === 'ignore') return
  const dx = x - active.startX
  const dy = y - active.startY
  if (active.axis === 'none') {
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    // |dy| > |dx| 判定为纵向手势：取消拖动并把偏移归零，交回页面滚动 / 视频进度条。
    active.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x'
  }
  if (active.axis === 'y') {
    pageOffset.value = 0
    workOffset.value = 0
    return
  }
  active.samples.push({ x, t: Date.now() })
  if (active.samples.length > 8) active.samples.shift()
  active.offset = dx
  if (active.mode === 'page') {
    pageAnimating.value = false
    const count = detail.value?.assets.length || 0
    // 页内位移 1:1 跟手，只有列表首尾之外才做橡皮筋阻尼。
    pageOffset.value = rubberBandOffset(dx, active.width, index.value > 0, index.value < count - 1)
  } else {
    workAnimating.value = false
    workOffset.value = Math.max(-active.width, Math.min(active.width, dx))
  }
}
function endGesture(id: number, x: number, y: number) {
  const active = gesture
  if (!active || active.pointerId !== id) return
  gesture = null
  if (active.mode === 'ignore' || active.axis !== 'x') { pageOffset.value = 0; workOffset.value = 0; return }
  const velocity = swipeVelocity(active.samples)
  const count = detail.value?.assets.length || 0
  const release = resolveSwipeRelease({ offset: active.offset, velocity, width: active.width, index: index.value, count, mode: active.mode })
  if (release.action === 'stay') { settleBack(active.mode); return }
  // 一次成功滑动之后不能再触发 click 打开放大层。
  suppressClick = true
  setTimeout(() => { suppressClick = false }, 350)
  if (release.action === 'work') { settleBack(active.mode); goWork(release.direction); return }
  slide.value = release.direction
  settleToPage(release.index, release.direction, velocity)
}
/** 松手但没有翻页：从松手时的偏移量平滑回弹到落定位，不跳变。 */
function settleBack(mode: 'page' | 'work') {
  if (mode === 'work') {
    workSettleMs.value = prefersReducedMotion() ? 0 : 180
    workAnimating.value = !prefersReducedMotion()
    workOffset.value = 0
    clearTimeout(workSettleTimer)
    workSettleTimer = setTimeout(() => { workAnimating.value = false }, workSettleMs.value + 20)
    return
  }
  const offset = pageOffset.value
  if (!offset) { pageAnimating.value = false; return }
  const duration = prefersReducedMotion() ? 0 : swipeSettleDuration(Math.abs(offset), 0, { min: 160, max: 300 })
  pageSettleMs.value = duration
  pageAnimating.value = duration > 0
  pageOffset.value = 0
  clearTimeout(pageCommitTimer)
  if (duration) pageCommitTimer = setTimeout(() => { pageAnimating.value = false }, duration + 20)
}
function settleWorkImmediately() {
  clearTimeout(workSettleTimer)
  workAnimating.value = false
  workOffset.value = 0
}
/** 翻页落定：先滑到相邻页的位置，再在同一帧提交页码并复位偏移（视觉上无缝）。 */
function settleToPage(target: number, direction: 1 | -1, velocity: number) {
  const width = stageWidth() || pageWidth.value
  if (!width || prefersReducedMotion()) { commitPage(target); return }
  const targetOffset = -direction * width
  const duration = swipeSettleDuration(Math.abs(targetOffset - pageOffset.value), velocity)
  pageSettleMs.value = duration
  pageAnimating.value = true
  pageOffset.value = targetOffset
  clearTimeout(pageCommitTimer)
  pendingPageCommit = () => commitPage(target)
  pageCommitTimer = setTimeout(() => { const commit = pendingPageCommit; if (commit) commit() }, duration + 20)
}
/** 程序化翻页（箭头 / 键盘 / 缩略图 / 自动翻页）也走同一套落位动画。 */
function goToIndex(target: number, direction: 1 | -1, animate = true) {
  const count = detail.value?.assets.length || 0
  if (target < 0 || target >= count || target === index.value) return
  settlePageImmediately()
  const width = stageWidth() || pageWidth.value
  if (!animate || !width) { commitPage(target); return }
  settleToPage(target, direction, width / 260)
}
function commitPage(target: number) {
  pendingPageCommit = undefined
  clearTimeout(pageCommitTimer)
  pageAnimating.value = false
  pageOffset.value = 0
  index.value = target
}
/** 落定动画没播完就来了新手势 / 新导航：立即收尾，避免页码在半路被改。 */
function settlePageImmediately() {
  const commit = pendingPageCommit
  if (!commit) return
  pendingPageCommit = undefined
  clearTimeout(pageCommitTimer)
  commit()
}
// 鼠标：只在媒体区域拖动翻页，避开视频底部控制条。
function pointerDown(event: PointerEvent) {
  if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) return
  if (gestureMode(event.target) !== 'page') return
  const video = event.target.closest('video')
  if (video && event.clientY > video.getBoundingClientRect().bottom - 56) return
  startGesture(event.target, event.clientX, event.clientY, event.pointerId)
}
function pointerMove(event: PointerEvent) { if (event.pointerType === 'mouse') moveGesture(event.pointerId, event.clientX, event.clientY) }
function pointerUp(event: PointerEvent) { if (event.pointerType === 'mouse') endGesture(event.pointerId, event.clientX, event.clientY) }
function pointerCancel() { gesture = null; pageOffset.value = 0; workOffset.value = 0 }
function suppressGestureClick(event: MouseEvent) {
  if (!suppressClick) return
  event.preventDefault()
  event.stopPropagation()
}
// 触屏用 touch 事件，滑到视频画面上也能收到（视频控件不会把它吞掉）。
function touchStart(event: TouchEvent) {
  const touch = event.changedTouches[0]
  if (!touch) return
  startGesture(event.target, touch.clientX, touch.clientY, touch.identifier)
}
function touchMove(event: TouchEvent) {
  const touch = Array.from(event.changedTouches).find(item => item.identifier === gesture?.pointerId)
  if (touch) moveGesture(touch.identifier, touch.clientX, touch.clientY)
}
function touchEnd(event: TouchEvent) {
  const touch = Array.from(event.changedTouches).find(item => item.identifier === gesture?.pointerId)
  if (touch) endGesture(touch.identifier, touch.clientX, touch.clientY)
}
function touchCancel() { gesture = null; pageOffset.value = 0; workOffset.value = 0 }
function retryMedia() {
  mediaError.value = false
  ugoiraImageFallback.value = false
  mediaRetryToken.value++
}
function handleVideoError(event: Event) {
  // Ignore errors from a video released during navigation or replaced by a new work.
  const element = event.target as HTMLVideoElement | null
  if (disposed || !element?.getAttribute('src') || element.getAttribute('src') !== mediaUrl.value) return
  if (asset.value?.origin === 'pixiv' && asset.value.kind === 'animation' && !ugoiraImageFallback.value) {
    ugoiraImageFallback.value = true
    mediaError.value = false
    return
  }
  mediaError.value = true
}
// 放大浮层：Vant ImagePreview（teleport 到 body，宽屏下不会被 .viewer-page 裁掉）。
function openPreview() {
  if (suppressClick || !asset.value || asset.value.kind !== 'image') return
  const entries = previewAssets.value
  if (!entries.length) return
  const found = entries.findIndex(entry => entry.item.id === asset.value?.id)
  const initialIndex = found >= 0 ? found : 0
  const translated = mangaResult.value && mangaMode.value === 'translated' && mangaCanvas.value
    ? mangaCanvas.value.toDataURL('image/png')
    : ''
  // Bug 1：浮层与主舞台共用同一套分辨率解析；正在放大的这一页按需升级到原图。
  const originals = new Set(originalAssets.value)
  const fallbacks = new Map<string, string>()
  const urls = entries.map((entry, at) => {
    if (translated && at === initialIndex) return translated
    const source = resolvePreviewSource(entry.item, originals, { forceOriginal: at === initialIndex })
    if (!source) return entry.item.url
    if (source.fallback) fallbacks.set(source.src, source.fallback)
    return source.src
  })
  if (!translated && asset.value.origin === 'pixiv') originals.add(asset.value.id)
  originalAssets.value = originals
  closePreview(false)
  const session: PreviewSession = {
    id: ++previewSessionId,
    workId: props.work.id,
    assets: entries,
    images: urls,
    index: initialIndex,
    closing: false,
    fallbacks,
    translatedIndex: translated ? initialIndex : -1,
  }
  previewSession = session
  previewing.value = true
  previewHandle = showImagePreview(previewOptions(session, initialIndex)) as ImagePreviewHandle
}
function previewOptions(session: PreviewSession, startPosition: number): MediaPreviewOptions {
  return {
    images: [...session.images],
    startPosition,
    loop: false,
    closeable: true,
    showIndex: true,
    swipeDuration: 300,
    className: 'media-gallery-preview',
    teleport: 'body',
    // 不要单独抬高遮罩：Vant 给遮罩和浮层同一个全局 z-index（2000+），浮层在 DOM 里靠后，
    // 本来就压在遮罩上；只设 overlayStyle.zIndex 会把遮罩抬到浮层之上，整张图被 0.9 的黑罩
    // 盖住（浮层内联 z-index 2001 无法被样式表覆盖）。2000+ 也远高于 app 自己的最高 z-index。
    closeOnClickImage: false,
    closeOnClickOverlay: true,
    onChange: (at: number) => changePreviewPage(session, at),
    onScale: (event: { scale: number }) => { if (event.scale > 1) void upgradePreviewPage(session, session.index) },
    onClose: () => { if (previewSession === session) closePreview(true) },
  }
}
/** 重开只刷新 images / startPosition（浮层不会关闭），用来把某一页换成原图或按方向键翻页。 */
function reopenPreview(session: PreviewSession) {
  if (previewSession !== session || session.closing) return
  resetPreviewZoom()
  previewHandle = showImagePreview(previewOptions(session, session.index)) as ImagePreviewHandle
}
/** 浮层翻页：记录页码、复位缩放、按需升级原图，并同步主查看器。 */
function changePreviewPage(session: PreviewSession, at: number) {
  if (previewSession !== session || session.closing) return
  session.index = at
  resetPreviewZoom()
  const entry = session.assets[at]
  if (!entry) return
  // 由浮层发起的换页：主查看器跟着换，但不能再把浮层销毁掉。
  if (entry.pageIndex !== index.value && entry.pageIndex >= 0 && entry.pageIndex < (detail.value?.assets.length || 0)) {
    previewOwnsIndex = true
    selectPage(entry.pageIndex, false)
  }
  void upgradePreviewPage(session, at)
}
/** 方向键翻页：function-call 没暴露 prev/next，用 startPosition 跳到相邻页。 */
function stepPreview(step: 1 | -1) {
  const session = previewSession
  if (!session || session.closing) return
  const target = session.index + step
  if (target < 0 || target >= session.images.length) return
  changePreviewPage(session, target)
  reopenPreview(session)
}
/** 正在浏览 / 放大的 Pixiv 页按需取原图；拿不到就继续用预览图。 */
async function upgradePreviewPage(session: PreviewSession, at: number) {
  const entry = session.assets[at]
  if (!entry || entry.item.origin !== 'pixiv' || session.translatedIndex === at) return
  const url = originalAssetUrl(entry.item)
  if (session.images[at] === url) return
  const source = resolvePreviewSource(entry.item, originalAssets.value, { forceOriginal: true })
  if (!source?.fallback) return
  try {
    await images.load(`preview:${entry.item.id}:${url}`, url)
  } catch {
    return
  }
  if (previewSession !== session || session.closing || session.assets[at] !== entry) return
  session.images[at] = url
  session.fallbacks.set(url, source.fallback)
  originalAssets.value = new Set([...originalAssets.value, entry.item.id])
  const element = previewItemElement(at)?.querySelector('img')
  if (element) element.src = url
}
function previewItemElement(at: number): HTMLElement | null {
  const overlay = document.querySelector('.media-gallery-preview')
  const items = overlay?.querySelectorAll<HTMLElement>('.van-image-preview__swipe-item')
  return items?.item(at) || null
}
/** 原图 403/404：换回预览图并让 Vant 重新渲染这一页（src 变化会重置它自己的错误态）。 */
function previewImageError(event: Event) {
  const session = previewSession
  const target = event.target
  if (!session || session.closing || !(target instanceof HTMLImageElement)) return
  if (!target.closest('.media-gallery-preview')) return
  const src = target.getAttribute('src') || ''
  const fallback = session.fallbacks.get(src)
  if (!fallback) return
  session.fallbacks.delete(src)
  // 原图确实不可用：主舞台也不该再继续用它（否则 mediaUrl 会停在 403 的原图上）。
  const failed = session.assets.filter(entry => originalAssetUrl(entry.item) === src)
  if (failed.length) {
    const next = new Set(originalAssets.value)
    for (const entry of failed) next.delete(entry.item.id)
    originalAssets.value = next
  }
  session.images = session.images.map(image => image === src ? fallback : image)
  reopenPreview(session)
}
// Vant ImagePreview 只处理触摸：桌面端补上滚轮缩放与拖拽平移（不重写成第二个查看器）。
let zoomElement: HTMLElement | null = null
let zoomBaseTransform = ''
let zoomState: ZoomState = { scale: 1, x: 0, y: 0 }
let panPointerId: number | null = null
let panOrigin: { x: number; y: number } | null = null
function previewImageBox(): { el: HTMLElement; frame: HTMLElement } | null {
  const session = previewSession
  if (!session) return null
  const el = previewItemElement(session.index)?.querySelector<HTMLElement>('.van-image-preview__image')
  if (!el?.parentElement) return null
  return { el, frame: el.parentElement }
}
function applyPreviewZoom() {
  if (!zoomElement) return
  zoomElement.style.transform = zoomState.scale === 1
    ? zoomBaseTransform
    : `matrix(${zoomState.scale},0,0,${zoomState.scale},${zoomState.x},${zoomState.y})`
  zoomElement.style.transitionDuration = '0s'
}
function resetPreviewZoom() {
  if (zoomElement) {
    zoomElement.style.transform = zoomBaseTransform
    zoomElement.style.transitionDuration = ''
  }
  zoomElement = null
  zoomBaseTransform = ''
  zoomState = { scale: 1, x: 0, y: 0 }
  panPointerId = null
  panOrigin = null
}
function previewWheel(event: WheelEvent) {
  if (!previewing.value) return
  const box = previewImageBox()
  if (!box) return
  event.preventDefault()
  if (zoomElement !== box.el) {
    resetPreviewZoom()
    zoomElement = box.el
    zoomBaseTransform = box.el.style.transform
  }
  const frame = box.frame.getBoundingClientRect()
  const size = { width: box.el.offsetWidth || frame.width, height: box.el.offsetHeight || frame.height }
  const cursor = { x: event.clientX - frame.left - size.width / 2, y: event.clientY - frame.top - size.height / 2 }
  zoomState = zoomAt(zoomState, cursor, event.deltaY < 0 ? 1.15 : 1 / 1.15, size)
  if (zoomState.scale <= 1) { resetPreviewZoom(); return }
  applyPreviewZoom()
}
function previewPointerDown(event: PointerEvent) {
  if (!previewing.value || event.button !== 0 || zoomState.scale <= 1 || !zoomElement) return
  if (!(event.target instanceof Element) || !event.target.closest('.media-gallery-preview')) return
  panPointerId = event.pointerId
  panOrigin = { x: event.clientX, y: event.clientY }
  event.preventDefault()
}
function previewPointerMove(event: PointerEvent) {
  if (panPointerId !== event.pointerId || !panOrigin || !zoomElement) return
  const size = { width: zoomElement.offsetWidth, height: zoomElement.offsetHeight }
  zoomState = constrainZoom({
    scale: zoomState.scale,
    x: zoomState.x + event.clientX - panOrigin.x,
    y: zoomState.y + event.clientY - panOrigin.y,
  }, size)
  panOrigin = { x: event.clientX, y: event.clientY }
  applyPreviewZoom()
}
function previewPointerUp(event: PointerEvent) {
  if (panPointerId !== event.pointerId) return
  panPointerId = null
  panOrigin = null
}
/** 关闭浮层：默认把浏览到的页码应用回主查看器。 */
function closePreview(sync = true) {
  const session = previewSession
  previewSession = undefined
  previewing.value = false
  resetPreviewZoom()
  if (sync && session) {
    const entry = session.assets[session.index]
    if (entry && entry.pageIndex !== index.value) {
      previewOwnsIndex = true
      selectPage(entry.pageIndex, false)
    }
  }
  const handle = previewHandle
  previewHandle = undefined
  if (handle) { try { handle.close() } catch { /* 浮层可能已经关闭 */ } }
}
function selectPage(target: number, animate = true) {
  if (target === index.value) return
  slide.value = target >= index.value ? 1 : -1
  goToIndex(target, slide.value >= 0 ? 1 : -1, animate)
}
function keyboard(event: KeyboardEvent) {
  if (!isActive.value) return
  if (previewing.value) {
    // Vant 浮层只处理触摸：桌面端补回 Esc 关闭与方向键翻页。
    if (event.key === 'Escape') { event.preventDefault(); closePreview(true); return }
    if (event.key === 'ArrowRight') { event.preventDefault(); stepPreview(1); return }
    if (event.key === 'ArrowLeft') { event.preventDefault(); stepPreview(-1); return }
    return
  }
  const target = event.target
  if (target instanceof HTMLElement && target.matches('input,textarea,video,button,select')) return
  if (event.key === 'ArrowRight') { event.preventDefault(); next(1) }
  if (event.key === 'ArrowLeft') { event.preventDefault(); next(-1) }
}
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.value?.requestFullscreen() }
  catch { emit('notice', '这个浏览器暂不支持全屏') }
}
// 翻译入口：force=true 时跳过缓存，重新调用 AI。
async function translate(force = false) {
  if (translating.value || !hasTranslatable.value) return
  translating.value = true
  translationError.value = ''
  const workId = props.work.id
  try {
    const result = await api<AiTranslateResult>('/ai/translate', { method: 'POST', body: JSON.stringify({ fields: translatable.value, force }) })
    // 翻译期间用户可能已经切到别的作品，丢弃过期的结果。
    if (disposed || workId !== props.work.id) return
    translation.value = result
    translationDisplay.value = 'translated'
    if (result.cached) {
      emit('notice', `已显示缓存的译文（${result.model}）`, { label: '重新翻译', handler: () => void translate(true) })
    } else {
      emit('notice', `已使用 ${result.model} 完成翻译`)
    }
  } catch (e) {
    if (disposed || workId !== props.work.id) return
    translationError.value = (e as Error).message
    emit('notice', `AI 翻译失败：${translationError.value}`, undefined, 'error')
  } finally {
    translating.value = false
  }
}
// 点击翻译入口：只有一张可翻译图片时直接开始，多张时展开“本页 / 整部”选择。
function chooseMangaTranslation() {
  if (!asset.value || !canTranslateManga.value || mangaBusy.value) return
  if (mangaPageAssets.value.length <= 1) {
    void runMangaTranslation('page', Boolean(mangaResult.value))
    return
  }
  mangaScopeOpen.value = !mangaScopeOpen.value
}

// 图片翻译：服务端任务式处理 OCR、擦字和批量翻译，这里只负责轮询、保存各页结果与 Canvas 排版。
async function runMangaTranslation(scope: 'page' | 'work', force = false) {
  if (!asset.value || !canTranslateManga.value || mangaBusy.value) return
  const pageIds = scope === 'work'
    ? mangaPageAssets.value.map(item => item.id)
    : [asset.value.id]
  if (!pageIds.length) return

  mangaScopeOpen.value = false
  const token = ++mangaToken
  mangaError.value = ''
  clearTimeout(mangaTimer)
  try {
    // POST 只在用户手势时提交一次；后续轮询与 activated 续查都走 GET。
    await handleMangaJob(await api<MangaJob>('/ai/manga/translate', {
      method: 'POST',
      body: JSON.stringify({ assetIds: pageIds, force }),
    }), token, true)
  } catch (e) {
    if (token === mangaToken) mangaError.value = (e as Error).message
  }
}

async function drawMangaResult() {
  const result = mangaResult.value
  const canvas = mangaCanvas.value
  if (!result || !canvas || !result.width || !result.height) return
  const version = ++drawVersion
  const workId = props.work.id
  const assetId = asset.value?.id
  let image: HTMLImageElement
  try {
    image = await images.load(result.key + ':' + result.baseUrl, result.baseUrl)
  } catch (e) {
    if (!disposed && version === drawVersion && asset.value?.id === assetId) mangaError.value = (e as Error).message
    return
  }
  if (disposed || version !== drawVersion || props.work.id !== workId || asset.value?.id !== assetId || mangaCanvas.value !== canvas || mangaResult.value?.key !== result.key || mangaMode.value !== 'translated') return
  canvas.width = result.width
  canvas.height = result.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, result.width, result.height)
  for (const region of result.regions) drawMangaRegion(ctx, region)
}

// 点击按钮在“仅译文 → 原文 + 译文 → 仅原文”之间循环。
function cycleTranslationDisplay() {
  translationDisplay.value = nextTranslationDisplay(translationDisplay.value)
}
async function makeCompatible() {
  if (!asset.value) return
  const id = asset.value.id
  converting.value = true
  convertMessage.value = '正在准备兼容版本…'
  try { await handleConversionJob(await api(`/assets/${id}/convert`, { method: 'POST' }), id) }
  catch (e) { converting.value = false; convertMessage.value = (e as Error).message }
}
function closeRoot() {
  // 离开只暂停保留进度/src：真正卸载由 v-release-video（beforeUnmount）释放资源，
  // 缓存实例 forward/back 还能继续看。旧的 releaseVideos 会清 src，返回要重载。
  try { video.value?.pause() } catch { /* 关闭暂停失败不影响返回 */ }
  emit('close')
}
</script>

<template>
  <main ref="root" class="viewer-page" :aria-label="work.title" @click.capture="suppressGestureClick" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerCancel" @touchstart.passive="touchStart" @touchmove.passive="touchMove" @touchend="touchEnd" @touchcancel="touchCancel">
    <div class="viewer-content" :style="contentStyle">
      <div class="viewer-main">
        <div ref="stage" class="media-stage">
          <div class="media-pager" :style="pagerStyle">
            <div class="media-page" aria-hidden="true"><img v-if="previousUrl" :src="previousUrl" alt="" draggable="false" /></div>
            <div class="media-page">
              <div :key="mediaKey" class="media-frame" :class="entering ? 'enter-' + entering : undefined">
              <p v-if="!asset" class="inline-error">作品没有可显示的媒体</p>
              <template v-else>
                <video v-if="isVideo" v-release-video ref="video" :key="mediaUrl" :src="mediaUrl" :poster="asset.thumbnail" controls playsinline preload="metadata" :autoplay="isActive && (slideshow || asset.kind === 'animation')" :muted="asset.kind === 'animation'" :loop="asset.kind === 'animation' && !slideshow" @error="handleVideoError" @ended="slideshow && isActive && next(1, true)" />
                <canvas v-else-if="mangaResult && mangaMode === 'translated' && mangaResult.regions.length" :key="mangaResult.key" ref="mangaCanvas" class="manga-canvas" :width="mangaResult.width" :height="mangaResult.height" :aria-label="`${work.title}，第 ${index + 1} 张的漫画译图`" @click="openPreview" />
                <img v-else :key="mediaUrl" :src="mediaUrl" draggable="false" :alt="`${work.title}，第 ${index + 1} 张`" @click="openPreview" @error="mediaError = true" />
                <div v-if="mediaError" class="media-error"><Icon name="warning" :size="32" /><p>{{ isVideo ? '浏览器无法播放这个视频' : '无法读取这张图片' }}</p><button v-if="asset?.origin === 'pixiv'" class="button tonal" @click="retryMedia"><Icon name="refresh" :size="18" />重试</button><button v-else-if="isVideo" class="button tonal" :disabled="converting" @click="makeCompatible">{{ converting ? '正在处理…' : '生成兼容版本' }}</button></div>
              </template>
            </div>
          </div>
            <div class="media-page" aria-hidden="true"><img v-if="nextUrl" :src="nextUrl" alt="" draggable="false" /></div>
          </div>
          <button v-if="(detail?.assets.length || 0) > 1" class="viewer-arrow previous" aria-label="上一张" @click="next(-1)"><Icon name="left" :size="32" /></button><button v-if="(detail?.assets.length || 0) > 1" class="viewer-arrow next" aria-label="下一张" @click="next(1)"><Icon name="right" :size="32" /></button>
        </div>
        <div class="viewer-controls"><span class="viewer-media-info">{{ asset ? kindLabel(asset.kind) + (asset.size > 0 ? ' · ' + formatSize(asset.size) : '') : '' }}</span><div class="viewer-actions"><button v-if="work.hasLocal !== false" class="icon-button" :class="{ selected: work.favorite }" :aria-label="work.favorite ? '取消本地收藏' : '加入本地收藏'" :aria-pressed="work.favorite" @click="emit('favorite', work)"><Icon :name="work.favorite ? 'heart-filled' : 'heart'" :size="20" /></button><button v-if="cloudEnabled && work.pixivId" class="icon-button cloud-favorite" :class="{ selected: work.cloudBookmark?.bookmarked }" :aria-label="work.cloudBookmark?.bookmarked ? '取消 Pixiv 云端收藏' : '加入 Pixiv 云端收藏'" :aria-pressed="work.cloudBookmark?.bookmarked === true" @click="emit('cloudFavorite', work)"><Icon :name="work.cloudBookmark?.bookmarked ? 'cloud-heart' : 'cloud'" :size="20" /></button><button class="icon-button" :aria-label="slideshow ? '停止自动翻页' : '自动翻页'" :aria-pressed="slideshow" @click="slideshow = !slideshow"><Icon :name="slideshow ? 'pause' : 'play'" :size="22" /></button><button class="icon-button" aria-label="全屏" @click="fullscreen"><Icon name="fullscreen" :size="22" /></button><button class="icon-button" aria-label="返回上一页" @click="closeRoot"><Icon name="left" :size="22" /></button></div></div>
        <div v-if="(detail?.assets.length || 0) > 1" ref="filmstrip" class="filmstrip"><button v-for="(item, i) in detail?.assets" :key="item.id" :class="{ active: index === i }" :aria-label="`第 ${i + 1} 项`" :aria-pressed="index === i" @click="selectPage(i)"><SmoothThumbnail :src="item.thumbnail" alt="" /><span class="filmstrip-page">{{ i + 1 }}</span></button></div>
      </div>
            <aside class="work-info">
        <nav class="work-navigation" aria-label="切换作品">
          <button type="button" class="button tonal small" :disabled="navigating" @click="goWork(-1)"><Icon name="left" :size="20" />上一个作品</button>
          <button type="button" class="button tonal small" :disabled="navigating" @click="goWork(1)">下一个作品<Icon name="right" :size="20" /></button>
        </nav>
        <Transition name="info-fade" mode="out-in"><div :key="work.id">
        <span class="eyebrow">ABOUT THIS WORK</span>
        <div class="translated-block">
          <div v-if="sourceVisible" class="text-line">
            <span v-if="translatedVisible" class="line-tag">原文</span>
            <h2>{{ work.title }}</h2>
            <p class="work-author">
              <button v-if="work.author && onlineAuthor" type="button" class="author-link" title="查看创作者主页" @click="emit('openAuthor', work)">{{ work.author }}</button>
              <button v-else-if="work.author" type="button" class="author-link" title="按这个作者搜索" @click="emit('searchAuthor', work.author)">{{ work.author }}</button>
              <span v-else>{{ work.sourceName }}</span>
            </p>
          </div>
          <div v-if="translatedVisible" class="text-line translated">
            <span class="line-tag">译文</span>
            <h2>{{ translation?.fields.title || work.title }}</h2>
            <p class="work-author">
              <button v-if="work.author && onlineAuthor" type="button" class="author-link" title="查看创作者主页" @click="emit('openAuthor', work)">{{ translation?.fields.author || work.author }}</button>
              <button v-else-if="work.author" type="button" class="author-link" title="按原文作者搜索" @click="emit('searchAuthor', work.author)">{{ translation?.fields.author || work.author }}</button>
              <span v-else>{{ work.sourceName }}</span>
            </p>
          </div>
        </div>
        <div class="translation-toolbar">
          <button class="button tonal small translate-button" type="button" :disabled="translating || !hasTranslatable" :title="translation ? '重新翻译这组作品' : '翻译标题、作者、标签与描述'" @click="translate(Boolean(translation))">
            <Icon :name="translating ? 'refresh' : 'sparkle'" :class="{ spinning: translating }" :size="17" />
            {{ translating ? '翻译中…' : translation ? '重新翻译' : 'AI 翻译' }}
          </button>
          <button v-if="translation" class="button text small display-toggle" type="button" :title="`当前：${displayLabel}，点击切换`" @click="cycleTranslationDisplay">
            <Icon :name="translationDisplay === 'translated' ? 'sparkle' : translationDisplay === 'source' ? 'info' : 'images'" :size="17" />
            {{ displayLabel }}
          </button>
        </div>
        <div v-if="canTranslateManga" class="translation-toolbar manga-toolbar">
          <div class="manga-translate-actions">
            <button class="button tonal small" type="button" :disabled="mangaBusy" :title="mangaResult ? '重新识别并翻译图片' : '识别图中日文并回填中文'" @click="chooseMangaTranslation">
              <Icon :name="mangaBusy ? 'refresh' : 'translate'" :class="{ spinning: mangaBusy }" :size="17" />
              {{ mangaBusy ? '图片翻译中…' : mangaResult ? '重新翻译' : '翻译图片' }}
            </button>
          </div>
          <button v-if="mangaResult" class="button text small display-toggle" type="button" @click="mangaMode = mangaMode === 'translated' ? 'source' : 'translated'">
            <Icon :name="mangaMode === 'translated' ? 'image' : 'translate'" :size="17" />
            {{ mangaMode === 'translated' ? '查看原图' : '查看译图' }}
          </button>
        </div>
        <div v-if="mangaScopeOpen && !mangaBusy" class="manga-scope-menu" role="menu" aria-label="选择漫画翻译范围">
          <button type="button" role="menuitem" @click="runMangaTranslation('page', Boolean(mangaResult))">{{ mangaResult ? '重新翻译本页' : '翻译本页' }}</button>
          <button type="button" role="menuitem" @click="runMangaTranslation('work', Boolean(mangaResult))">{{ mangaResult ? '重新翻译整部' : '翻译整部' }} · {{ mangaPageAssets.length }} 张</button>
        </div>
        <p v-if="mangaBusy && mangaJob?.stage" class="manga-progress" role="status">
          <span class="spinner" />当前进度：{{ mangaJob.stage }}
        </p>
        <div v-if="mangaFailures.length" class="inline-error translation-error-box failure-list" role="alert">
          <Icon name="warning" :size="19" />
          <div>
            <p>有 {{ mangaFailures.length }} 张图片翻译失败：</p>
            <p v-for="item in mangaFailures" :key="item.assetId">{{ item.page }} · {{ item.message }}</p>
          </div>
        </div>
        <p v-else-if="mangaError" class="inline-error translation-error-box" role="alert">
          <Icon name="warning" :size="19" />
          <span>图片翻译失败：{{ mangaError }}</span>
        </p>
        <p v-if="mangaResult && mangaMode === 'translated'" class="translation-meta" role="status">
          本页识别 {{ mangaResult.regions.length }} 处 · {{ mangaResult.model }} · {{ mangaResult.cached ? '来自缓存' : '刚刚生成' }}
        </p>
        <p v-if="translationError" class="inline-error translation-error-box" role="alert">
          <Icon name="warning" :size="19" />
          <span>AI 翻译失败：{{ translationError }}</span>
        </p>
        <p v-if="translation?.cached" class="translation-meta" role="status">来自服务端缓存的译文 · {{ translation.model }}</p>
        <p v-else-if="translation" class="translation-meta" role="status">由 {{ translation.model }} 翻译于 {{ new Date(translation.createdAt).toLocaleString('zh-CN') }}</p>
        <dl><div><dt>来源</dt><dd>{{ work.sourceName }}</dd></div><div><dt>日期</dt><dd>{{ new Date(work.date).toLocaleDateString('zh-CN') }}</dd></div><div><dt>作品编号</dt><dd>{{ work.externalId }}</dd></div><div><dt>内容</dt><dd>{{ work.count }} 项媒体</dd></div></dl>
        <div v-if="tagRows.length" class="tag-list" aria-label="作品标签"><template v-for="(tag, i) in tagRows" :key="i"><button type="button" class="tag-chip" title="按这个标签搜索" @click="emit('searchTag', tag.original)"><span>#{{ tag.primary }}</span><span v-if="tag.secondary" class="tag-divider">/</span><span v-if="tag.secondary">#{{ tag.secondary }}</span></button></template></div>
        <h3>作品描述</h3>
        <p v-if="sourceVisible" class="description">{{ detail?.description || '这组作品暂时没有文字描述。' }}</p>
        <p v-if="translatedVisible && translation?.fields.description" class="description translated"><span v-if="sourceVisible" class="line-tag">译文</span>{{ translation.fields.description }}</p>
        <section v-if="mangaResult?.regions.length" class="manga-lines" aria-label="图片翻译对照">
          <h3>图片译文对照</h3>
          <ol>
            <li v-for="region in mangaResult.regions" :key="region.id">
              <span>{{ region.source }}</span>
              <strong>{{ region.translation }}</strong>
            </li>
          </ol>
        </section>
        <a v-if="detail?.originalUrl" class="button outlined small" :href="detail.originalUrl" target="_blank" rel="noopener noreferrer">前往原作品<Icon name="external" :size="18" /></a>
        <div v-if="isVideo && asset?.origin !== 'pixiv'" class="compatibility-panel"><p>遇到黑屏或只有声音？</p><button class="button tonal small" :disabled="converting || compatible" @click="makeCompatible"><Icon name="video" :size="18" />{{ compatible ? '已切换兼容版本' : converting ? '正在处理…' : '生成兼容版本' }}</button><span v-if="convertMessage" role="status">{{ convertMessage }}</span><small>生成的文件只保存在缓存中，原文件保持不变。</small></div>
        <WorkRecommendations :work="work" :cloud-enabled="cloudEnabled" @open="(target, listKey) => emit('openRelated', target, listKey)" @favorite="emit('favorite', $event)" @cloud-favorite="emit('cloudFavorite', $event)" @notice="emit('notice', $event)" />
      </div></Transition></aside>
    </div>
  </main>
</template>

<style scoped>
.viewer-controls { flex-wrap: wrap; gap: 6px 12px; padding: 6px 12px; }
.viewer-media-info { flex-shrink: 0; white-space: nowrap; }
.viewer-actions { min-width: 0; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
.viewer-actions .icon-button { flex-shrink: 0; }
.viewer-actions .cloud-favorite.selected { color: var(--primary); background: var(--primary-container); }
</style>
