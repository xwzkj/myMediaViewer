<script setup lang="ts">
import { ref } from 'vue'
import type { Work } from '../../shared/types'
import Icon from './Icon.vue'
import WorkFavoriteActions from './WorkFavoriteActions.vue'
import WorkMediaBadge from './WorkMediaBadge.vue'
defineProps<{ work: Work; cloudEnabled?: boolean }>()
defineEmits<{ open: [work: Work]; favorite: [work: Work]; cloudFavorite: [work: Work]; openAuthor: [work: Work] }>()
const failed = ref(false)
</script>

<template>
  <article class="work-card" :data-work-id="work.id">
    <button class="card-open" @click="$emit('open', work)" :aria-label="`查看 ${work.title}`">
      <div class="card-art">
        <img v-if="!failed" :src="work.cover" :alt="work.title" loading="lazy" decoding="async" @error="failed = true" />
        <div v-else class="card-placeholder"><Icon :name="work.kind" :size="44" /><span>预览暂不可用</span></div>
        <div class="card-topline"><span class="source-badge">{{ work.sourceName }}</span><span v-if="work.hasLocal === false" class="source-badge cloud-badge">云端</span><span v-if="work.approximate" class="source-badge">近似匹配</span></div>
        <WorkMediaBadge :work="work" />
        <div v-if="work.kind !== 'image'" class="card-play"><Icon :name="work.kind === 'video' ? 'play' : 'animation'" :size="28" /></div>
      </div>
    </button>
    <div class="card-copy">
      <button type="button" class="card-title" @click="$emit('open', work)" :aria-label="`查看 ${work.title}`"><h3 :title="work.title">{{ work.title }}</h3></button>
      <div class="card-bottom"><p><button v-if="work.pixivUserId && (work.hasLocal === false || work.origin === 'pixiv' || work.id.startsWith('pixiv:'))" type="button" class="card-author link" :title="work.author || work.sourceName" @click="$emit('openAuthor', work)">{{ work.author || work.sourceName }}</button><span v-else class="card-author" :title="work.author || work.sourceName">{{ work.author || work.sourceName }}</span><span class="card-date">{{ new Date(work.date).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' }) }}</span></p><WorkFavoriteActions :work="work" :cloud-enabled="cloudEnabled" @favorite="$emit('favorite', $event)" @cloud-favorite="$emit('cloudFavorite', $event)" /></div>
    </div>
  </article>
</template>

<style scoped>
.card-copy { padding: 12px; min-height: 88px; }
.card-title { display: block; width: 100%; padding: 0; text-align: left; background: transparent; }
.card-title:hover { color: var(--primary); }
.card-author.link { padding: 0; color: inherit; text-align: left; background: transparent; cursor: pointer; }
.card-author.link:hover { color: var(--primary); text-decoration: underline; }
.card-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.card-bottom p { min-width: 0; margin: 0; flex: 1; }
.card-bottom p span { display: block; margin: 0; overflow: hidden; text-overflow: ellipsis; }
.card-date { margin-top: 4px !important; font-size: 9px; opacity: .8; }
@media (max-width: 700px) { .card-copy { padding: 11px 10px; } .card-bottom { gap: 5px; } }
.cloud-badge { background: #dbeaff !important; color: #28699f !important; }
</style>
