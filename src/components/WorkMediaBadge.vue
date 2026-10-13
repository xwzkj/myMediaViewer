<script setup lang="ts">
import type { Work } from '../../shared/types'
import { kindLabel } from '../api'
import Icon from './Icon.vue'

defineProps<{ work: Pick<Work, 'kind' | 'count'>; inline?: boolean }>()
</script>

<template>
  <span class="work-media-badge" :class="{ inline }" :aria-label="work.kind === 'image' ? `${Math.max(1, work.count)} 张图片` : kindLabel(work.kind)"><Icon :name="work.kind === 'image' ? 'images' : work.kind" :size="14" /><span>{{ work.kind === 'image' ? `${Math.max(1, work.count)} 张` : kindLabel(work.kind) }}</span></span>
</template>

<style scoped>
.work-media-badge { position: absolute; bottom: 10px; right: 10px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; border: 1px solid #ffffff30; border-radius: 7px; background: #202820b8; color: #fff; font-size: 10px; line-height: 1.2; font-weight: 500; backdrop-filter: blur(6px); pointer-events: none; }
.work-media-badge.inline { position: static; flex-shrink: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--muted); backdrop-filter: none; white-space: nowrap; }
</style>
