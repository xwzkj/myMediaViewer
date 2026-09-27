<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { WorkDetail, Work } from '../../shared/types'
import { api, formatSize, kindLabel } from '../api'
import Icon from './Icon.vue'

const props = defineProps<{ work: Work }>()
const emit = defineEmits<{ close: []; favorite: [work: Work]; notice: [message: string]; searchTag: [tag: string] }>()
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

onMounted(async () => {
  dialog.value?.showModal()
  try { detail.value = await api<WorkDetail>(`/works/${encodeURIComponent(props.work.id)}`) }
  catch (e) { error.value = (e as Error).message }
  timer = setInterval(() => { if (slideshow.value && !isVideo.value && !zoom.value) next(1) }, 4500)
})
onUnmounted(() => { disposed = true; clearInterval(timer); clearTimeout(conversionTimer) })
watch(index, () => { zoom.value = false; mediaError.value = false; compatible.value = false; converting.value = false; convertMessage.value = ''; clearTimeout(conversionTimer) })
watch(slideshow, value => { if (value && isVideo.value) void video.value?.play().catch(() => {}) })
function next(direction: number) {
  const count = detail.value?.assets.length || 0
  if (count > 1) index.value = (index.value + direction + count) % count
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
  <dialog ref="dialog" class="viewer-dialog" aria-labelledby="viewer-title" @close="emit('close')" @keydown="keyboard">
    <header class="viewer-toolbar"><button class="icon-button" aria-label="关闭查看器" @click="dialog?.close()"><Icon name="close" /></button><div class="viewer-title"><h2 id="viewer-title">{{ work.title }}</h2><span>{{ work.author || work.sourceName }}</span></div><span class="viewer-counter">{{ index + 1 }} / {{ detail?.assets.length || work.count }}</span><button class="icon-button" :class="{ selected: work.favorite }" :aria-label="work.favorite ? '取消收藏' : '收藏作品'" :aria-pressed="work.favorite" @click="emit('favorite', work)"><Icon :name="work.favorite ? 'heart-filled' : 'heart'" /></button><button class="icon-button" :class="{ selected: showInfo }" aria-label="作品信息" :aria-pressed="showInfo" @click="showInfo = !showInfo"><Icon name="info" /></button></header>
    <div class="viewer-content" :class="{ 'without-info': !showInfo }">
      <div class="viewer-main">
        <div ref="stage" class="media-stage" :class="{ zoomed: zoom }">
          <p v-if="error" class="inline-error">{{ error }}</p><div v-else-if="!asset" class="loading-state"><span class="spinner" />正在打开作品…</div>
          <template v-else>
            <video v-if="isVideo" ref="video" :key="mediaUrl" :src="mediaUrl" :poster="asset.thumbnail" controls playsinline preload="metadata" :autoplay="slideshow || asset.kind === 'animation'" :muted="asset.kind === 'animation'" :loop="asset.kind === 'animation' && !slideshow" @error="mediaError = true" @ended="slideshow && next(1)" />
            <img v-else :key="asset.id" :src="asset.url" :alt="`${work.title}，第 ${index + 1} 张`" @click="zoom = !zoom" @error="mediaError = true" />
            <div v-if="mediaError" class="media-error"><Icon name="warning" :size="32" /><p>{{ isVideo ? '浏览器无法播放这个视频' : '无法读取这张图片' }}</p><button v-if="isVideo" class="button tonal" :disabled="converting" @click="makeCompatible">{{ converting ? '正在处理…' : '生成兼容版本' }}</button></div>
            <button v-if="!zoom && (detail?.assets.length || 0) > 1" class="viewer-arrow previous" aria-label="上一张" @click="next(-1)"><Icon name="left" :size="32" /></button><button v-if="!zoom && (detail?.assets.length || 0) > 1" class="viewer-arrow next" aria-label="下一张" @click="next(1)"><Icon name="right" :size="32" /></button>
          </template>
        </div>
        <div class="viewer-controls"><span>{{ asset ? `${kindLabel(asset.kind)} · ${formatSize(asset.size)}` : '' }}</span><div><button class="icon-button" :aria-label="slideshow ? '停止自动翻页' : '自动翻页'" :aria-pressed="slideshow" @click="slideshow = !slideshow"><Icon :name="slideshow ? 'pause' : 'play'" :size="22" /></button><button class="icon-button" aria-label="全屏" @click="fullscreen"><Icon name="fullscreen" :size="22" /></button><a v-if="asset" class="icon-button" :href="asset.url" target="_blank" rel="noopener" aria-label="打开原文件"><Icon name="external" :size="22" /></a></div></div>
        <div v-if="(detail?.assets.length || 0) > 1" class="filmstrip"><button v-for="(item, i) in detail?.assets" :key="item.id" :class="{ active: index === i }" :aria-label="`第 ${i + 1} 项`" :aria-pressed="index === i" @click="index = i"><img :src="item.thumbnail" loading="lazy" alt="" /><span>{{ i + 1 }}</span></button></div>
      </div>
      <aside v-if="showInfo" class="work-info"><span class="eyebrow">ABOUT THIS WORK</span><h2>{{ work.title }}</h2><p class="work-author">{{ work.author || work.sourceName }}</p><dl><div><dt>来源</dt><dd>{{ work.sourceName }}</dd></div><div><dt>日期</dt><dd>{{ new Date(work.date).toLocaleDateString('zh-CN') }}</dd></div><div><dt>作品编号</dt><dd>{{ work.externalId }}</dd></div><div><dt>内容</dt><dd>{{ work.count }} 项媒体</dd></div></dl><div v-if="work.tags.length" class="tag-list" aria-label="作品标签"><button v-for="tag in work.tags" :key="tag" type="button" class="tag-chip" title="按这个标签搜索" @click="emit('searchTag', tag)">#{{ tag }}</button></div><h3>作品描述</h3><p class="description">{{ detail?.description || '这组作品暂时没有文字描述。' }}</p><a v-if="detail?.originalUrl" class="button outlined small" :href="detail.originalUrl" target="_blank" rel="noopener noreferrer">前往原作品<Icon name="external" :size="18" /></a><div v-if="isVideo" class="compatibility-panel"><p>遇到黑屏或只有声音？</p><button class="button tonal small" :disabled="converting || compatible" @click="makeCompatible"><Icon name="video" :size="18" />{{ compatible ? '已切换兼容版本' : converting ? '正在处理…' : '生成兼容版本' }}</button><span v-if="convertMessage" role="status">{{ convertMessage }}</span><small>生成的文件只保存在缓存中，原文件保持不变。</small></div></aside>
    </div>
  </dialog>
</template>
