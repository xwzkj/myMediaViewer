<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { LibraryStatus } from '../../shared/types'
import { createStatusPoller } from '../status-poller'
import { api } from '../api'
import { usePageRoute } from '../use-page-route'
import { returnFromPage } from '../navigation'
import Icon from '../components/Icon.vue'
import AppNotice from '../components/AppNotice.vue'
import { useNotice } from '../use-notice'
import SettingsContent from '../components/SettingsContent.vue'

defineOptions({ name: 'SettingsPage' })

const router = useRouter()
// helper 快照：失活后只读自己的 from，不读别的页面 query。
const { route: pageRoute, active: pageActive } = usePageRoute()
const route = pageRoute
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
  void returnFromPage(router, route.value)
}

// KeepAlive 初挂即触发 onActivated：主入口只从这里 start。
// onMounted 仅作非 KeepAlive 直挂兜底（测试/SSR 无 activated）。
// 初挂时 mounted 先于 activated 触发，两者共享 activeEntry 去重，
// 保证 generation 只推进一次，避免首屏 run 被错位丢弃而永久 loading。
let activeEntry = false
onMounted(() => {
  if (activeEntry || !pageActive.value) return
  activeEntry = true
  poller.start()
})
onActivated(() => {
  if (activeEntry || !pageActive.value) return
  activeEntry = true
  poller.start()
})
onDeactivated(() => { activeEntry = false; poller.stop(); dismiss() })
onBeforeUnmount(poller.stop)
</script>

<template>
  <SettingsContent v-if="status" :status="status" @close="close" @changed="refresh" @notice="notice" />
  <div v-else-if="loading" class="route-state"><span class="spinner" />正在读取媒体库设置…</div>
  <div v-else class="route-state error-state"><Icon name="warning" :size="30" /><p>{{ error }}</p><button class="button filled" @click="refresh">重试</button></div>
  <AppNotice :notice="toast" @dismiss="dismiss" @action="runAction" />
</template>
