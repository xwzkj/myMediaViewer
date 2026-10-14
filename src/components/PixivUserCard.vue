<script setup lang="ts">
import { ref } from 'vue'
import type { PixivUserSummary } from '../../shared/types'
import Icon from './Icon.vue'
defineProps<{ user: PixivUserSummary }>()
defineEmits<{ open: [user: PixivUserSummary] }>()
const avatarFailed = ref(false)
</script>

<template>
  <article class="user-card" :data-user-id="user.id">
    <button class="user-open" @click="$emit('open', user)" :aria-label="`查看画师 ${user.name} 的主页`">
      <div class="user-avatar">
        <img v-if="user.avatarUrl && !avatarFailed" :src="user.avatarUrl" :alt="`${user.name} 的头像`" loading="lazy" decoding="async" @error="avatarFailed = true" />
        <div v-else class="user-placeholder" aria-hidden="true"><Icon name="gallery" :size="36" /></div>
      </div>
      <div class="user-copy">
        <h3 :title="user.name">{{ user.name }}</h3>
        <p class="user-account">{{ user.account ? `@${user.account}` : `UID ${user.id}` }}</p>
        <p v-if="user.comment" class="user-comment" :title="user.comment">{{ user.comment }}</p>
        <p v-if="user.isFollowed" class="user-followed">已关注</p>
      </div>
    </button>
  </article>
</template>

<style scoped>
.user-card { overflow: hidden; border: 1px solid var(--outline); border-radius: 14px; background: var(--card); }
.user-card:hover { border-color: var(--primary); }
.user-open { display: flex; gap: 12px; align-items: flex-start; width: 100%; padding: 12px; text-align: left; background: transparent; }
.user-avatar { flex-shrink: 0; width: 56px; height: 56px; overflow: hidden; border-radius: 50%; background: var(--surface-high); }
.user-avatar img { width: 100%; height: 100%; object-fit: cover; }
.user-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--muted); }
.user-copy { min-width: 0; flex: 1; }
.user-copy h3 { margin: 0; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.user-account { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.user-comment { display: -webkit-box; margin: 6px 0 0; overflow: hidden; color: var(--muted); font-size: 11px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.user-followed { margin: 6px 0 0; color: var(--primary); font-size: 11px; }
</style>
