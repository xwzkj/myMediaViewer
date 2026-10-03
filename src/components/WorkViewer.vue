<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, onUnmounted, watch } from 'vue'
import type { AiTranslateFields, AiTranslateResult, MangaJob, MangaPageResult, WorkDetail, Work } from '../../shared/types'
import { Viewer } from 'v-viewer'
import { api, formatSize, kindLabel } from '../api'
import Icon from './Icon.vue'
import { drawMangaRegion } from '../manga-layout'
import { vReleaseVideo, releaseVideos } from '../video-lifecycle'
import type { Notice, NoticeAction } from '../use-notice'

const props = defineProps<{ work: Work }>()
const emit = defineEmits<{ close: []; favorite: [work: Work]; notice: [message: string, action?: NoticeAction, tone?: Notice['tone']]; searchTag: [tag: string]; searchAuthor: [author: string]; navigate: [direction: number, auto?: boolean] }>()
const root = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const video = ref<HTMLVideoElement>()
onBeforeUnmount(() => { if (root.value) releaseVideos(root.value) })
const detail = ref<WorkDetail | null>(null)
const index = ref(0)
const error = ref('')
const mediaError = ref(false)
const previewing = ref(false)
const slideshow = ref(false)
const converting = ref(false)
const convertMessage = ref('')
const compatible = ref(false)
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
const translationDisplay = ref<TranslationDisplay>('both')
const translationDisplayLabels: Record<TranslationDisplay, string> = { source: '仅原文', translated: '仅译文', both: '原文 + 译文' }
const translationDisplayOrder: TranslationDisplay[] = ['both', 'translated', 'source']
let timer: ReturnType<typeof setInterval> | undefined
let conversionTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const asset = computed(() => detail.value?.assets[index.value])
const isVideo = computed(() => asset.value && (asset.value.kind === 'video' || asset.value.extension === 'webm'))
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
const mediaUrl = computed(() => compatible.value ? `/api/assets/${asset.value?.id}/compatible` : asset.value?.url)

async function load() {
  detail.value = null
  error.value = ''
  try {
    detail.value = await api<WorkDetail>(`/works/${encodeURIComponent(props.work.id)}`)
    if (startAtLast) index.value = Math.max(0, (detail.value?.assets.length || 1) - 1)
  } catch (e) { error.value = (e as Error).message }
  startAtLast = false
}
// 切换分 P / 作品时丢弃旧图翻译状态，后台任务即使稍后完成也不会覆盖当前页面。
function resetManga() {
  mangaToken++
  clearTimeout(mangaTimer)
  mangaTimer = undefined
  mangaJob.value = null
  mangaResults.value = {}
  mangaMode.value = 'source'
  mangaError.value = ''
  mangaScopeOpen.value = false
}
onMounted(async () => {
  await load()
  if (disposed) return
  timer = setInterval(() => { if (slideshow.value && !isVideo.value && !previewing.value) next(1, true) }, 4500)
})
// 滑动切换到别的作品后重新取详情，并回到第一张。
watch(() => props.work.id, () => { index.value = 0; destroyPreview(); mediaError.value = false; compatible.value = false; converting.value = false; convertMessage.value = ''; translation.value = null; translationError.value = ''; translationDisplay.value = 'both'; resetManga(); void load() })
onUnmounted(() => { disposed = true; destroyPreview(); clearInterval(timer); clearTimeout(conversionTimer); clearTimeout(mangaTimer) })
watch(index, async () => {
  destroyPreview()
  mediaError.value = false
  compatible.value = false
  converting.value = false
  convertMessage.value = ''
  clearTimeout(conversionTimer)
  mangaError.value = ''
  mangaScopeOpen.value = false
  await nextTick()
  mangaMode.value = mangaResult.value ? 'translated' : 'source'
  if (mangaResult.value) void drawMangaResult()
})
// v-if 切换会让 canvas 重新挂载；只要译图、显示模式或 canvas 实例变化，就重新绘制一次。
watch([mangaMode, () => mangaResult.value?.key, () => mangaCanvas.value], async ([mode, key, canvas]) => {
  if (mode !== 'translated' || !key || !canvas) return
  await nextTick()
  void drawMangaResult()
})
watch(slideshow, value => { if (value && isVideo.value) void video.value?.play().catch(() => {}) })
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
const sourceVisible = computed(() => translationDisplay.value !== 'translated')
const translatedVisible = computed(() => translationDisplay.value !== 'source' && Boolean(translation.value))
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
// 分 P 到头后继续滑动就切换作品：往后进入下一组的第 1 页，往回停在上一组的最后一页。
function goWork(direction: number, auto = false) {
  startAtLast = direction < 0
  slide.value = direction
  emit('navigate', direction, auto)
}
function next(direction: number, auto = false) {
  const count = detail.value?.assets.length || 0
  if (!count) return
  const target = index.value + direction
  if (target < 0 || target >= count) { goWork(direction, auto); return }
  slide.value = direction
  index.value = target
}
// 手势：在图片 / 视频区域左右滑动切换分 P，在信息区等其他位置左右滑动切换上一个 / 下一个作品。
const dragX = ref(0)
// 切换分 P 或作品时的滑动方向，用来决定动画从哪边进出。
const slide = ref(1)
const mediaKey = computed(() => `${props.work.id}:${asset.value?.id || (error.value ? 'error' : 'loading')}`)
const slideName = computed(() => slide.value >= 0 ? 'media-next' : 'media-prev')
let gesture: { pointerId: number; startX: number; startY: number; mode: 'page' | 'work' | 'ignore' } | null = null
let suppressClick = false
// viewer.js 浮层实例，以及给它提供图片的隐藏节点。
let preview: InstanceType<typeof Viewer> | undefined
let previewToken: HTMLDivElement | undefined
let previewDestroying = false
// 往回切换作品时，载入完成后停在最后一页。
let startAtLast = false
function gestureMode(target: EventTarget | null): 'page' | 'work' | 'ignore' {
  if (!(target instanceof Element)) return 'ignore'
  // viewer.js 浮层里的手势交给它自己处理。
  if (target.closest('.viewer-container')) return 'ignore'
  if (target.closest('.media-stage')) return 'page'
  if (target.closest('.filmstrip') || target.closest('button,a,input,select,textarea')) return 'ignore'
  return 'work'
}
function startGesture(target: EventTarget | null, x: number, y: number, id: number) {
  if (previewing.value) return
  gesture = { pointerId: id, startX: x, startY: y, mode: gestureMode(target) }
  dragX.value = 0
}
function moveGesture(id: number, x: number, y: number) {
  if (!gesture || gesture.pointerId !== id || gesture.mode !== 'page') return
  const dx = x - gesture.startX
  const dy = y - gesture.startY
  if (Math.abs(dy) > Math.abs(dx)) { dragX.value = 0; return }
  dragX.value = Math.max(-110, Math.min(110, dx))
}
function endGesture(id: number, x: number, y: number) {
  if (!gesture || gesture.pointerId !== id) return
  const { mode, startX, startY } = gesture
  gesture = null
  dragX.value = 0
  const dx = x - startX
  const dy = y - startY
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return
  const direction = dx < 0 ? 1 : -1
  // 媒体区域滑到分 P 尽头后会继续切换作品；其他区域直接切换作品。
  if (mode === 'page') next(direction)
  else if (mode === 'work') goWork(direction)
  suppressClick = true
  setTimeout(() => { suppressClick = false }, 350)
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
function pointerCancel() { gesture = null; dragX.value = 0 }
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
function touchCancel() { gesture = null; dragX.value = 0 }
// 点按图片交给 viewer.js 打开浮层，缩放、拖动、双击、捏合都由它负责。
function openPreview() {
  if (suppressClick || !asset.value) return
  const host = root.value
  if (!host) return
  destroyPreview()
  const token = document.createElement('div')
  token.style.display = 'none'
  const image = document.createElement('img')
  // 译图以 Canvas 叠加呈现，预览时把同一份结果编码进去，避免看到未回填的原图。
  image.src = mangaResult.value && mangaMode.value === 'translated' && mangaCanvas.value
    ? mangaCanvas.value.toDataURL('image/png')
    : asset.value.url
  image.alt = props.work.title
  token.appendChild(image)
  // 放大预览挂在作品页内，随页面卸载一起清理。
  host.appendChild(token)
  previewToken = token
  previewing.value = true
  const instance = new Viewer(token, {
    container: host,
    zIndex: 2200,
    navbar: false,
    title: false,
    fullscreen: false,
    keyboard: true,
    backdrop: true,
    movable: true,
    zoomable: true,
    rotatable: true,
    scalable: true,
    zoomOnWheel: true,
    zoomRatio: 0.3,
    zoomOnTouch: true,
    zoomOnGesture: true,
    slideOnTouch: false,
    toggleOnDblclick: true,
    tooltip: true,
    toolbar: { zoomIn: true, zoomOut: true, oneToOne: true, reset: true, rotateLeft: true, rotateRight: true, prev: false, next: false, play: false, flipHorizontal: true, flipVertical: true },
    hidden: () => { previewing.value = false; setTimeout(() => { if (!previewing.value) destroyPreview() }, 0) }
  })
  preview = instance
  instance.show()
  bindBackdropClose(host)
}
// 点浮层空白处关闭，拖动过图片时不触发。
function bindBackdropClose(host: HTMLElement) {
  const overlay = host.querySelector<HTMLElement>('.viewer-container')
  if (!overlay) return
  let start: { x: number; y: number } | null = null
  overlay.addEventListener('pointerdown', event => { start = { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY } })
  overlay.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as HTMLElement
    const moved = start ? Math.abs(event.clientX - start.x) > 6 || Math.abs(event.clientY - start.y) > 6 : false
    start = null
    if (moved) return
    if (target.classList.contains('viewer-container') || target.classList.contains('viewer-canvas')) destroyPreview()
  })
}
function destroyPreview() {
  if (previewDestroying) return
  previewDestroying = true
  try { preview?.destroy() } catch { /* 浮层可能已经关闭 */ }
  preview = undefined
  previewToken?.remove()
  previewToken = undefined
  previewing.value = false
  previewDestroying = false
}
function selectPage(target: number) {
  slide.value = target >= index.value ? 1 : -1
  index.value = target
}
function keyboard(event: KeyboardEvent) {
  if (previewing.value) return
  if ((event.target as HTMLElement).matches('input,textarea,video')) return
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
    if (translationDisplay.value === 'source') translationDisplay.value = 'both'
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
  let firstPoll = true
  mangaError.value = ''
  clearTimeout(mangaTimer)
  async function handle(job: MangaJob) {
    if (disposed || token !== mangaToken) return
    mangaJob.value = job

    const incoming = job.results || (job.result && job.currentAssetId ? [{ assetId: job.currentAssetId, result: job.result }] : [])
    for (const item of incoming) mangaResults.value[item.assetId] = item.result

    const currentResult = asset.value ? mangaResults.value[asset.value.id] : undefined
    if (currentResult) mangaMode.value = 'translated'
    if (job.state === 'ready') {
      await nextTick()
      if (currentResult) void drawMangaResult()
      if (job.failed?.length) {
        emit('notice', `已完成 ${job.results?.length || 0}/${job.total} 张漫画翻译，${job.failed.length} 张失败：${job.failed[0].message}`, undefined, 'error')
      } else if (scope === 'work') {
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
      emit('notice', `图片翻译失败：${mangaError.value}`, undefined, 'error')
      return
    }
    const delay = firstPoll ? 50 : job.state === 'queued' ? 1200 : 800
    firstPoll = false
    mangaTimer = setTimeout(async () => {
      try { await handle(await api<MangaJob>(`/ai/manga/jobs/${job.id}`)) }
      catch (e) {
        if (token === mangaToken) mangaError.value = (e as Error).message
      }
    }, delay)
  }
  try {
    await handle(await api<MangaJob>('/ai/manga/translate', {
      method: 'POST',
      body: JSON.stringify({ assetIds: pageIds, force }),
    }))
  } catch (e) {
    if (token === mangaToken) mangaError.value = (e as Error).message
  }
}

async function drawMangaResult() {
  const result = mangaResult.value
  const canvas = mangaCanvas.value
  if (!result || !canvas || !result.width || !result.height) return
  const image = new Image()
  image.decoding = 'async'
  image.src = result.baseUrl
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('译图底图加载失败'))
    })
  } catch (e) {
    mangaError.value = (e as Error).message
    return
  }
  canvas.width = result.width
  canvas.height = result.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, result.width, result.height)
  for (const region of result.regions) drawMangaRegion(ctx, region)
}

// 点击按钮在“原文 + 译文 / 仅原文 / 仅译文”之间循环。
function cycleTranslationDisplay() {
  const at = translationDisplayOrder.indexOf(translationDisplay.value)
  translationDisplay.value = translationDisplayOrder[(at + 1) % translationDisplayOrder.length]
}
async function makeCompatible() {
  if (!asset.value) return
  const id = asset.value.id
  converting.value = true
  convertMessage.value = '正在准备兼容版本…'
  async function handle(job: { state: string; message?: string }) {
    if (disposed || id !== asset.value?.id) return
    if (job.state === 'ready') { compatible.value = true; mediaError.value = false; converting.value = false; convertMessage.value = '正在播放兼容版本'; return }
    if (job.state === 'failed') { converting.value = false; convertMessage.value = job.message || '转换失败'; return }
    convertMessage.value = job.state === 'queued' ? '已加入处理队列…' : '正在生成兼容版本，完成后会自动切换…'
    conversionTimer = setTimeout(async () => {
      try { await handle(await api(`/assets/${id}/convert`)) }
      catch (e) { converting.value = false; convertMessage.value = (e as Error).message }
    }, 2000)
  }
  try { await handle(await api(`/assets/${id}/convert`, { method: 'POST' })) }
  catch (e) { converting.value = false; convertMessage.value = (e as Error).message }
}
function closeRoot() {
  if (root.value) releaseVideos(root.value)
  emit('close')
}
</script>

<template>
  <main ref="root" class="viewer-page" :aria-label="work.title" @keydown="keyboard" @click.capture="suppressGestureClick" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerCancel" @touchstart.passive="touchStart" @touchmove.passive="touchMove" @touchend="touchEnd" @touchcancel="touchCancel">
    <div class="viewer-content">
      <div class="viewer-main">
        <div ref="stage" class="media-stage" :style="dragX ? { transform: `translateX(${dragX}px)`, transition: 'none' } : undefined">
          <Transition :name="slideName" mode="out-in" @before-leave="releaseVideos">
            <div :key="mediaKey" class="media-frame">
              <p v-if="error" class="inline-error">{{ error }}</p><div v-else-if="!asset" class="loading-state"><span class="spinner" />正在打开作品…</div>
              <template v-else>
                <video v-if="isVideo" v-release-video ref="video" :key="mediaUrl" :src="mediaUrl" :poster="asset.thumbnail" controls playsinline preload="metadata" :autoplay="slideshow || asset.kind === 'animation'" :muted="asset.kind === 'animation'" :loop="asset.kind === 'animation' && !slideshow" @error="mediaError = true" @ended="slideshow && next(1, true)" />
                <canvas v-else-if="mangaResult && mangaMode === 'translated' && mangaResult.regions.length" :key="mangaResult.key" ref="mangaCanvas" class="manga-canvas" :width="mangaResult.width" :height="mangaResult.height" :aria-label="`${work.title}，第 ${index + 1} 张的漫画译图`" @click="openPreview" />
                <img v-else :key="asset.id" :src="asset.url" draggable="false" :alt="`${work.title}，第 ${index + 1} 张`" @click="openPreview" @error="mediaError = true" />
                <div v-if="mediaError" class="media-error"><Icon name="warning" :size="32" /><p>{{ isVideo ? '浏览器无法播放这个视频' : '无法读取这张图片' }}</p><button v-if="isVideo" class="button tonal" :disabled="converting" @click="makeCompatible">{{ converting ? '正在处理…' : '生成兼容版本' }}</button></div>
              </template>
            </div>
          </Transition>
          <button v-if="(detail?.assets.length || 0) > 1" class="viewer-arrow previous" aria-label="上一张" @click="next(-1)"><Icon name="left" :size="32" /></button><button v-if="(detail?.assets.length || 0) > 1" class="viewer-arrow next" aria-label="下一张" @click="next(1)"><Icon name="right" :size="32" /></button>
        </div>
        <div class="viewer-controls"><span>{{ asset ? `${kindLabel(asset.kind)} · ${formatSize(asset.size)}` : '' }}</span><div><button class="icon-button" :class="{ selected: work.favorite }" :aria-label="work.favorite ? '取消收藏' : '收藏作品'" :aria-pressed="work.favorite" @click="emit('favorite', work)"><Icon :name="work.favorite ? 'heart-filled' : 'heart'" :size="20" /></button><button class="icon-button" :aria-label="slideshow ? '停止自动翻页' : '自动翻页'" :aria-pressed="slideshow" @click="slideshow = !slideshow"><Icon :name="slideshow ? 'pause' : 'play'" :size="22" /></button><button class="icon-button" aria-label="全屏" @click="fullscreen"><Icon name="fullscreen" :size="22" /></button><button class="icon-button" aria-label="返回上一页" @click="closeRoot"><Icon name="left" :size="22" /></button></div></div>
        <div v-if="(detail?.assets.length || 0) > 1" class="filmstrip"><button v-for="(item, i) in detail?.assets" :key="item.id" :class="{ active: index === i }" :aria-label="`第 ${i + 1} 项`" :aria-pressed="index === i" @click="selectPage(i)"><img :src="item.thumbnail" loading="lazy" alt="" /><span>{{ i + 1 }}</span></button></div>
      </div>
            <aside class="work-info"><Transition name="info-fade" mode="out-in"><div :key="work.id">
        <span class="eyebrow">ABOUT THIS WORK</span>
        <div class="translated-block">
          <div v-if="sourceVisible" class="text-line">
            <span v-if="translatedVisible" class="line-tag">原文</span>
            <h2>{{ work.title }}</h2>
            <p class="work-author">
              <button v-if="work.author" type="button" class="author-link" title="按这个作者搜索" @click="emit('searchAuthor', work.author)">{{ work.author }}</button>
              <span v-else>{{ work.sourceName }}</span>
            </p>
          </div>
          <div v-if="translatedVisible" class="text-line translated">
            <span class="line-tag">译文</span>
            <h2>{{ translation?.fields.title || work.title }}</h2>
            <p class="work-author">
              <button v-if="work.author" type="button" class="author-link" title="按原文作者搜索" @click="emit('searchAuthor', work.author)">{{ translation?.fields.author || work.author }}</button>
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
        <div v-if="isVideo" class="compatibility-panel"><p>遇到黑屏或只有声音？</p><button class="button tonal small" :disabled="converting || compatible" @click="makeCompatible"><Icon name="video" :size="18" />{{ compatible ? '已切换兼容版本' : converting ? '正在处理…' : '生成兼容版本' }}</button><span v-if="convertMessage" role="status">{{ convertMessage }}</span><small>生成的文件只保存在缓存中，原文件保持不变。</small></div>
      </div></Transition></aside>
    </div>
  </main>
</template>
