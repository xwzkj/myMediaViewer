<script setup lang="ts">
import type { Notice } from '../use-notice'
import Icon from './Icon.vue'

defineProps<{ notice: Notice | null }>()
defineEmits<{ dismiss: []; action: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="toast">
      <div v-if="notice" class="snackbar" :class="{ error: notice.tone === 'error' }" :role="notice.tone === 'error' ? 'alert' : 'status'">
        <Icon :name="notice.tone === 'error' ? 'warning' : 'success'" :size="20" />
        <span>{{ notice.message }}</span>
        <button v-if="notice.action" class="toast-action" type="button" @click="$emit('action')">{{ notice.action.label }}</button>
        <button class="icon-button" aria-label="关闭提示" @click="$emit('dismiss')"><Icon name="close" :size="18" /></button>
      </div>
    </Transition>
  </Teleport>
</template>
