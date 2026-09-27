<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { WorkDetail, Work } from '../../shared/types'
import { api, formatSize, kindLabel } from '../api'
import Icon from './Icon.vue'

const props = defineProps<{ work: Work }>()
const emit = defineEmits<{ close: []; favorite: [work: Work]; notice: [message: string]; searchTag: [tag: string]; searchAuthor: [author: string]; navigate: [direction: number, auto?: boolean] }>()
const dialog = ref<HTMLDialogElement>()
const stage = ref<HTMLElement>()
const video = ref<HTMLVideoElement>()
const detail = ref<WorkDetail | null>(null)
const index = ref(0)
const error = ref('')
const mediaError = ref(false)
const zoom = ref(false)
const showInfo = ref(true)
const slideshow = ref(false)
const converting = ref(false)
const convertMessage = ref('')
const compatible = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
let conversionTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const asset = computed(() => detail.value?.assets[index.value])
const isVideo = computed(() => asset.value && (asset.value.kind === 'video' || asset.value.extension === 'webm'))
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
// 打开查看器时锁住底层页面滚动，避免穿透到作品列表。
let previousOverflow = ''
let previousPadding = ''
onMounted(async () => {
  dialog.value?.showModal()
  previousOverflow = document.body.style.overflow
  previousPadding = document.body.style.paddingRight
  const gap = window.innerWidth - document.documentElement.clientWidth
  document.body.style.overflow = 'hidden'
  if (gap > 0) document.body.style.paddingRight = `${gap}px`
  await load()
  timer = setInterval(() => { if (slideshow.value && !isVideo.value && !zoom.value) next(1, true) }, 4500)
})
// 滑动切换到别的作品后重新取详情，并回到第一张。
watch(() => props.work.id, () => { index.value = 0; zoom.value = false; mediaError.value = false; compatible.value = false; converting.value = false; convertMessage.value = ''; void load() })
onUnmounted(() => { disposed = true; clearInterval(timer); clearTimeout(conversionTimer); document.body.style.overflow = previousOverflow; document.body.style.paddingRight = previousPadding })
watch(index, () => { zoom.value = false; mediaError.value = false; compatible.value = false; converting.value = false; convertMessage.value = ''; clearTimeout(conversionTimer) })
watch(slideshow, value => { if (value && isVideo.value) void video.value?.play().catch(() => {}) })
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
// 往回切换作品时，载入完成后停在最后一页。
let startAtLast = false
function gestureMode(target: EventTarget | null): 'page' | 'work' | 'ignore' {
  if (!(target instanceof Element)) return 'ignore'
  // 放大后的图片要能自由平移，交给浏览器处理。
  if (target.closest('.media-stage')) return zoom.value ? 'ignore' : 'page'
  if (target.closest('.filmstrip') || target.closest('button,a,input,select,textarea')) return 'ignore'
  return 'work'
}
function startGesture(target: EventTarget | null, x: number, y: number, id: number) {
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
// 触屏用 touch 事件，滑到视频画面上也能收到（视频控件不会把它吞掉）。
function touchStart(event: TouchEvent) {
  const touch = event.changedTouches[0]
  if (touch) startGesture(event.target, touch.clientX, touch.clientY, touch.identifier)
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
function stageClick() { if (!suppressClick) zoom.value = !zoom.value }
function selectPage(target: number) {
  slide.value = target >= index.value ? 1 : -1
  index.value = target
}
function keyboard(event: KeyboardEvent) {
  if ((event.target as HTMLElement).matches('input,textarea,video')) return
  if (event.key === 'ArrowRight') { event.preventDefault(); next(1) }
  if (event.key === 'ArrowLeft') { event.preventDefault(); next(-1) }
}
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.value?.requestFullscreen() }
  catch { emit('notice', '这个浏览器暂不支持全屏') }
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
</script>

<template>
  <dialog ref="dialog" class="viewer-dialog" aria-labelledby="viewer-title" @close="emit('close')" @keydown="keyboard" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerCancel" @touchstart.passive="touchStart" @touchmove.passive="touchMove" @touchend="touchEnd" @touchcancel="touchCancel">
    <header class="viewer-toolbar"><button class="icon-button" aria-label="关闭查看器" @click="dialog?.close()"><Icon name="close" /></button><div class="viewer-title"><h2 id="viewer-title">{{ work.title }}</h2><span>{{ work.author || work.sourceName }}</span></div><span class="viewer-counter">{{ index + 1 }} / {{ detail?.assets.length || work.count }}</span><button class="icon-button" :class="{ selected: work.favorite }" :aria-label="work.favorite ? '取消收藏' : '收藏作品'" :aria-pressed="work.favorite" @click="emit('favorite', work)"><Icon :name="work.favorite ? 'heart-filled' : 'heart'" /></button><button class="icon-button" :class="{ selected: showInfo }" aria-label="作品信息" :aria-pressed="showInfo" @click="showInfo = !showInfo"><Icon name="info" /></button></header>
    <div class="viewer-content" :class="{ 'without-info': !showInfo }">
      <div class="viewer-main">
        <div ref="stage" class="media-stage" :class="{ zoomed: zoom }" :style="dragX ? { transform: `translateX(${dragX}px)`, transition: 'none' } : undefined">
          <Transition :name="slideName" mode="out-in">
            <div :key="mediaKey" class="media-frame">
              <p v-if="error" class="inline-error">{{ error }}</p><div v-else-if="!asset" class="loading-state"><span class="spinner" />正在打开作品…</div>
              <template v-else>
                <video v-if="isVideo" ref="video" :key="mediaUrl" :src="mediaUrl" :poster="asset.thumbnail" controls playsinline preload="metadata" :autoplay="slideshow || asset.kind === 'animation'" :muted="asset.kind === 'animation'" :loop="asset.kind === 'animation' && !slideshow" @error="mediaError = true" @ended="slideshow && next(1, true)" />
                <img v-else :key="asset.id" :src="asset.url" draggable="false" :alt="`${work.title}，第 ${index + 1} 张`" @click="stageClick" @error="mediaError = true" />
                <div v-if="mediaError" class="media-error"><Icon name="warning" :size="32" /><p>{{ isVideo ? '浏览器无法播放这个视频' : '无法读取这张图片' }}</p><button v-if="isVideo" class="button tonal" :disabled="converting" @click="makeCompatible">{{ converting ? '正在处理…' : '生成兼容版本' }}</button></div>
              </template>
            </div>
          </Transition>
          <button v-if="!zoom && (detail?.assets.length || 0) > 1" class="viewer-arrow previous" aria-label="上一张" @click="next(-1)"><Icon name="left" :size="32" /></button><button v-if="!zoom && (detail?.assets.length || 0) > 1" class="viewer-arrow next" aria-label="下一张" @click="next(1)"><Icon name="right" :size="32" /></button>
        </div>
        <div class="viewer-controls"><span>{{ asset ? `${kindLabel(asset.kind)} · ${formatSize(asset.size)}` : '' }}</span><div><button class="icon-button" :aria-label="slideshow ? '停止自动翻页' : '自动翻页'" :aria-pressed="slideshow" @click="slideshow = !slideshow"><Icon :name="slideshow ? 'pause' : 'play'" :size="22" /></button><button class="icon-button" aria-label="全屏" @click="fullscreen"><Icon name="fullscreen" :size="22" /></button><a v-if="asset" class="icon-button" :href="asset.url" target="_blank" rel="noopener" aria-label="打开原文件"><Icon name="external" :size="22" /></a></div></div>
        <div v-if="(detail?.assets.length || 0) > 1" class="filmstrip"><button v-for="(item, i) in detail?.assets" :key="item.id" :class="{ active: index === i }" :aria-label="`第 ${i + 1} 项`" :aria-pressed="index === i" @click="selectPage(i)"><img :src="item.thumbnail" loading="lazy" alt="" /><span>{{ i + 1 }}</span></button></div>
      </div>
      <aside v-if="showInfo" class="work-info"><Transition name="info-fade" mode="out-in"><div :key="work.id"><span class="eyebrow">ABOUT THIS WORK</span><h2>{{ work.title }}</h2><p class="work-author"><button v-if="work.author" type="button" class="author-link" title="按这个作者搜索" @click="emit('searchAuthor', work.author)">{{ work.author }}</button><span v-else>{{ work.sourceName }}</span></p><dl><div><dt>来源</dt><dd>{{ work.sourceName }}</dd></div><div><dt>日期</dt><dd>{{ new Date(work.date).toLocaleDateString('zh-CN') }}</dd></div><div><dt>作品编号</dt><dd>{{ work.externalId }}</dd></div><div><dt>内容</dt><dd>{{ work.count }} 项媒体</dd></div></dl><div v-if="work.tags.length" class="tag-list" aria-label="作品标签"><button v-for="tag in work.tags" :key="tag" type="button" class="tag-chip" title="按这个标签搜索" @click="emit('searchTag', tag)">#{{ tag }}</button></div><h3>作品描述</h3><p class="description">{{ detail?.description || '这组作品暂时没有文字描述。' }}</p><a v-if="detail?.originalUrl" class="button outlined small" :href="detail.originalUrl" target="_blank" rel="noopener noreferrer">前往原作品<Icon name="external" :size="18" /></a><div v-if="isVideo" class="compatibility-panel"><p>遇到黑屏或只有声音？</p><button class="button tonal small" :disabled="converting || compatible" @click="makeCompatible"><Icon name="video" :size="18" />{{ compatible ? '已切换兼容版本' : converting ? '正在处理…' : '生成兼容版本' }}</button><span v-if="convertMessage" role="status">{{ convertMessage }}</span><small>生成的文件只保存在缓存中，原文件保持不变。</small></div></div></Transition></aside>
    </div>
  </dialog>
</template>
