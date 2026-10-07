<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LibraryStatus } from '../../shared/types'
import { createStatusPoller } from '../status-poller'
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

const poller = createStatusPoller(
  () => api<LibraryStatus>('/status'),
  value => { status.value = value; error.value = ''; loading.value = false },
  e => { error.value = (e as Error).message; loading.value = false },
)
const refresh = poller.refresh

function close() {
  const from = typeof route.query.from === 'string' ? route.query.from : '/'
  router.replace(from)
}

onMounted(poller.start)
onBeforeUnmount(poller.stop)
</script>

<template>
  <SettingsContent v-if="status" :status="status" @close="close" @changed="refresh" @notice="notice" />
  <div v-else-if="loading" class="route-state"><span class="spinner" />正在读取媒体库设置…</div>
  <div v-else class="route-state error-state"><Icon name="warning" :size="30" /><p>{{ error }}</p><button class="button filled" @click="refresh">重试</button></div>
  <AppNotice :notice="toast" @dismiss="dismiss" @action="runAction" />
</template>
