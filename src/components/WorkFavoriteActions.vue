<script setup lang="ts">
import type { Work } from '../../shared/types'
import Icon from './Icon.vue'

defineProps<{ work: Work; cloudEnabled?: boolean }>()
defineEmits<{ favorite: [work: Work]; cloudFavorite: [work: Work] }>()
</script>

<template>
  <div v-if="work.hasLocal !== false || (cloudEnabled && work.pixivId)" class="favorite-actions" role="group" aria-label="作品收藏">
    <button v-if="work.hasLocal !== false" type="button" class="favorite-action local" :class="{ selected: work.favorite }" :title="work.favorite ? '取消本地收藏' : '加入本地收藏'" :aria-label="work.favorite ? '取消本地收藏' : '加入本地收藏'" :aria-pressed="work.favorite" @click="$emit('favorite', work)"><Icon :name="work.favorite ? 'heart-filled' : 'heart'" :size="18" /></button>
    <button v-if="cloudEnabled && work.pixivId" type="button" class="favorite-action cloud" :class="{ selected: work.cloudBookmark?.bookmarked }" :title="work.cloudBookmark?.bookmarked ? '取消 Pixiv 云端收藏' : '加入 Pixiv 云端收藏'" :aria-label="work.cloudBookmark?.bookmarked ? '取消 Pixiv 云端收藏' : '加入 Pixiv 云端收藏'" :aria-pressed="work.cloudBookmark?.bookmarked === true" @click="$emit('cloudFavorite', work)"><Icon :name="work.cloudBookmark?.bookmarked ? 'cloud-heart' : 'cloud'" :size="18" /></button>
  </div>
</template>

<style scoped>
.favorite-actions { display: inline-flex; flex-shrink: 0; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--outline); border-radius: 9px; background: var(--surface-low); }
.favorite-action { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border-radius: 6px; background: transparent; color: var(--muted); transition: background .15s, color .15s; }
.favorite-action :deep(.icon) { width: 16px; height: 16px; }
.favorite-action:hover { background: var(--surface-high); color: var(--text); }
.favorite-action.local.selected { background: #f5e6e4; color: #9a555e; }
.favorite-action.cloud.selected { background: var(--primary-container); color: var(--primary); }
:global(:root[data-theme=dark]) .favorite-action.local.selected { background: #543337; color: #e6b9b9; }
</style>
