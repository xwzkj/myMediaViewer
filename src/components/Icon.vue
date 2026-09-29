<script setup lang="ts">
import { computed } from 'vue'
import {
  mdiViewGalleryOutline, mdiHeartOutline, mdiHeart, mdiImageMultipleOutline, mdiPlayCircleOutline,
  mdiMotionPlayOutline, mdiMagnify, mdiClose, mdiPlus, mdiFolderOutline, mdiCogOutline,
  mdiRefresh, mdiWeatherNight, mdiWhiteBalanceSunny, mdiArrowRight, mdiArrowLeft,
  mdiChevronLeft, mdiChevronRight, mdiChevronDown, mdiCheck, mdiDotsHorizontal,
  mdiArrowTopRight, mdiInformationOutline, mdiFullscreen, mdiDownload, mdiPause, mdiPlay,
  mdiPencilOutline, mdiTrashCanOutline, mdiLan, mdiCheckCircleOutline, mdiAlertCircleOutline,
  mdiSortVariant, mdiTuneVariant, mdiImageOutline, mdiAutoFix, mdiMenu, mdiMonitor,
  mdiContentCopy, mdiFolderPlusOutline, mdiLeaf, mdiFolderOpenOutline, mdiCloudOffOutline, mdiTagOutline,
  mdiTranslate,
} from '@mdi/js'

const props = defineProps<{ name: string; size?: number }>()
const icons: Record<string, string> = {
  gallery: mdiViewGalleryOutline, heart: mdiHeartOutline, 'heart-filled': mdiHeart,
  images: mdiImageMultipleOutline, video: mdiPlayCircleOutline, animation: mdiMotionPlayOutline,
  search: mdiMagnify, close: mdiClose, plus: mdiPlus, folder: mdiFolderOutline,
  settings: mdiCogOutline, refresh: mdiRefresh, moon: mdiWeatherNight, sun: mdiWhiteBalanceSunny,
  'arrow-right': mdiArrowRight, 'arrow-left': mdiArrowLeft, left: mdiChevronLeft, right: mdiChevronRight,
  down: mdiChevronDown, check: mdiCheck, more: mdiDotsHorizontal, external: mdiArrowTopRight,
  info: mdiInformationOutline, fullscreen: mdiFullscreen, download: mdiDownload,
  pause: mdiPause, play: mdiPlay, edit: mdiPencilOutline, delete: mdiTrashCanOutline,
  lan: mdiLan, success: mdiCheckCircleOutline, warning: mdiAlertCircleOutline,
  sort: mdiSortVariant, tune: mdiTuneVariant, image: mdiImageOutline, sparkle: mdiAutoFix,
  menu: mdiMenu, monitor: mdiMonitor, copy: mdiContentCopy, 'folder-plus': mdiFolderPlusOutline,
  leaf: mdiLeaf, 'folder-open': mdiFolderOpenOutline, offline: mdiCloudOffOutline, tag: mdiTagOutline,
  translate: mdiTranslate,
}
const icon = computed(() => icons[props.name] || mdiImageOutline)
</script>

<template><svg class="icon" :width="size || 24" :height="size || 24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path :d="icon" /></svg></template>
