<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LibraryStatus } from '../../shared/types'
import { api } from '../api'
import Icon from '../components/Icon.vue'
import AppNotice from '../components/AppNotice.vue'
import { useNotice } from '../use-notice'
import SettingsContent from '../components/SettingsContent.vue'

const route = useRoute()
const router = useRouter()
const status = ref<LibraryStatus | null>(null)
const loading = ref(true)
const error = ref('')
const { toast, notice, dismiss, runAction } = useNotice()

async function refresh() {
  try {
    status.value = await api<LibraryStatus>('/status')
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function close() {
  const from = typeof route.query.from === 'string' ? route.query.from : '/'
  router.replace(from)
}

onMounted(refresh)
</script>

<template>
  <SettingsContent v-if="status" :status="status" @close="close" @changed="refresh" @notice="notice" />
  <div v-else-if="loading" class="route-state"><span class="spinner" />正在读取媒体库设置…</div>
  <div v-else class="route-state error-state"><Icon name="warning" :size="30" /><p>{{ error }}</p><button class="button filled" @click="refresh">重试</button></div>
  <AppNotice :notice="toast" @dismiss="dismiss" @action="runAction" />
</template>
