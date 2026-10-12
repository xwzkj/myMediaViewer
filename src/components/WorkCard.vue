<script setup lang="ts">
import { ref } from 'vue'
import type { Work } from '../../shared/types'
import Icon from './Icon.vue'
import { kindLabel } from '../api'
const props = defineProps<{ work: Work; cloudEnabled?: boolean }>()
defineEmits<{ open: [work: Work]; favorite: [work: Work]; cloudFavorite: [work: Work] }>()
const failed = ref(false)
</script>

<template>
  <article class="work-card" :data-work-id="work.id">
    <button class="card-open" @click="$emit('open', work)" :aria-label="`查看 ${work.title}`">
      <div class="card-art">
        <img v-if="!failed" :src="work.cover" :alt="work.title" loading="lazy" decoding="async" @error="failed = true" />
        <div v-else class="card-placeholder"><Icon :name="work.kind" :size="44" /><span>预览暂不可用</span></div>
        <div class="card-topline"><span class="source-badge">{{ work.sourceName }}</span><span v-if="work.hasLocal === false" class="source-badge cloud-badge">云端</span><span v-if="work.approximate" class="source-badge">近似匹配</span></div>
        <div class="media-badge"><Icon :name="work.kind === 'image' ? 'images' : work.kind" :size="15" /><span>{{ work.count > 1 ? work.count : kindLabel(work.kind) }}</span></div>
        <div v-if="work.kind !== 'image'" class="card-play"><Icon :name="work.kind === 'video' ? 'play' : 'animation'" :size="28" /></div>
      </div>
      <div class="card-copy"><h3 :title="work.title">{{ work.title }}</h3><p>{{ work.author || work.sourceName }}<span>·</span>{{ new Date(work.date).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' }) }}</p></div>
    </button>
    <div class="card-favorites"><button v-if="work.hasLocal !== false" class="icon-button card-favorite" :class="{ selected: work.favorite }" @click="$emit('favorite', work)" :aria-label="work.favorite ? '取消本地收藏' : '加入本地收藏'" :aria-pressed="work.favorite"><Icon :name="work.favorite ? 'heart-filled' : 'heart'" :size="20" /></button><button v-if="props.cloudEnabled && work.pixivId" class="icon-button card-favorite cloud-favorite" :class="{ selected: work.cloudBookmark?.bookmarked }" @click="$emit('cloudFavorite', work)" :aria-label="work.cloudBookmark?.bookmarked ? '取消 Pixiv 云端收藏' : '加入 Pixiv 云端收藏'" :aria-pressed="work.cloudBookmark?.bookmarked === true"><Icon :name="work.cloudBookmark?.bookmarked ? 'cloud-heart' : 'cloud'" :size="20" /></button></div>
  </article>
</template>

<style scoped>
.card-favorites { position: absolute; right: 0; bottom: 12px; display: flex; flex-direction: column; gap: 2px; z-index: 2; }
.card-favorites .card-favorite { position: static !important; }
.card-favorites .cloud-favorite.selected { color: #4c9ee8; }
.cloud-badge { background: #dbeaff !important; color: #28699f !important; }
</style>
