<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ src: string; alt: string }>()
const root = ref<HTMLElement>()
const image = ref<HTMLImageElement>()
const canvas = ref<HTMLCanvasElement>()
const ready = ref(false)
let observer: ResizeObserver | undefined
let pending = 0

function schedule() {
  cancelAnimationFrame(pending)
  pending = requestAnimationFrame(draw)
}
function draw() {
  const img = image.value, target = canvas.value, box = root.value
  if (!img?.complete || !img.naturalWidth || !target || !box) return
  const width = box.clientWidth, height = box.clientHeight
  if (!width || !height) return
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  const outputWidth = Math.max(1, Math.round(width * dpr))
  const outputHeight = Math.max(1, Math.round(height * dpr))
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight)
  const cropWidth = width / scale, cropHeight = height / scale
  const sx = (img.naturalWidth - cropWidth) / 2, sy = (img.naturalHeight - cropHeight) / 2
  let source: CanvasImageSource = img
  let x = sx, y = sy, w = cropWidth, h = cropHeight
  // Several moderate reductions avoid Chrome's aliasing when a large image is
  // squeezed into a tiny CSS box. The final bitmap matches physical screen pixels.
  while (w > outputWidth * 2 || h > outputHeight * 2) {
    const step = document.createElement('canvas')
    step.width = Math.max(outputWidth, Math.round(w / 2))
    step.height = Math.max(outputHeight, Math.round(h / 2))
    const ctx = step.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, x, y, w, h, 0, 0, step.width, step.height)
    source = step; x = 0; y = 0; w = step.width; h = step.height
  }
  target.width = outputWidth; target.height = outputHeight
  const ctx = target.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, x, y, w, h, 0, 0, outputWidth, outputHeight)
  ready.value = true
}
watch(() => props.src, () => { ready.value = false; schedule() })
onMounted(() => {
  observer = new ResizeObserver(schedule)
  if (root.value) observer.observe(root.value)
  window.addEventListener('resize', schedule)
  schedule()
})
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(pending); window.removeEventListener('resize', schedule) })
</script>

<template>
  <span ref="root" class="smooth-thumbnail">
    <img ref="image" :src="src" :alt="alt" :class="{ resampled: ready }" loading="lazy" decoding="async" @load="schedule" @error="ready = false" />
    <canvas ref="canvas" v-show="ready" aria-hidden="true" />
  </span>
</template>

<style scoped>
.smooth-thumbnail { position: relative; display: block; width: 100%; height: 100%; overflow: hidden; }
.smooth-thumbnail img, .smooth-thumbnail canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
.smooth-thumbnail img.resampled { opacity: 0; }
.smooth-thumbnail canvas { pointer-events: none; }
</style>
