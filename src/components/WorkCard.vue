<script setup lang="ts">
import { ref } from 'vue'
import type { Work } from '../../shared/types'
import Icon from './Icon.vue'
import { kindLabel } from '../api'
defineProps<{ work: Work }>()
defineEmits<{ open: [work: Work]; favorite: [work: Work] }>()
const failed = ref(false)
</script>

<template>
  <article class="work-card" :data-work-id="work.id">
    <button class="card-open" @click="$emit('open', work)" :aria-label="`查看 ${work.title}`">
      <div class="card-art">
        <img v-if="!failed" :src="work.cover" :alt="work.title" loading="lazy" decoding="async" @error="failed = true" />
        <div v-else class="card-placeholder"><Icon :name="work.kind" :size="44" /><span>预览暂不可用</span></div>
        <div class="card-topline"><span class="source-badge">{{ work.sourceKind === 'pixiv' ? 'pixiv' : 'Telegram' }}</span><span v-if="work.approximate" class="source-badge">近似匹配</span></div>
        <div class="media-badge"><Icon :name="work.kind === 'image' ? 'images' : work.kind" :size="15" /><span>{{ work.count > 1 ? work.count : kindLabel(work.kind) }}</span></div>
        <div v-if="work.kind !== 'image'" class="card-play"><Icon :name="work.kind === 'video' ? 'play' : 'animation'" :size="28" /></div>
      </div>
      <div class="card-copy"><h3 :title="work.title">{{ work.title }}</h3><p>{{ work.author || work.sourceName }}<span>·</span>{{ new Date(work.date).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' }) }}</p></div>
    </button>
    <button class="icon-button card-favorite" :class="{ selected: work.favorite }" @click="$emit('favorite', work)" :aria-label="work.favorite ? '取消收藏' : '收藏作品'" :aria-pressed="work.favorite"><Icon :name="work.favorite ? 'heart-filled' : 'heart'" :size="21" /></button>
  </article>
</template>
