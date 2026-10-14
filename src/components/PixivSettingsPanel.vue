<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PixivSettings, PixivStatus } from '../../shared/types'
import Icon from './Icon.vue'
import AppSelect from './AppSelect.vue'
import { api } from '../api'
import { appEvents } from '../events'

const emit = defineEmits<{ notice: [message: string] }>()
const settings = ref<PixivSettings | null>(null)
const status = ref<PixivStatus | null>(null)
const token = ref('')
const showToken = ref(false)
const loading = ref(true)
const saving = ref(false)
const clearing = ref(false)
const error = ref('')

const cacheText = computed(() => {
  const cache = status.value?.cache
  if (!cache) return '正在读取缓存…'
  return `${formatBytes(cache.bytes)} / ${formatBytes(cache.limitBytes)} · ${cache.files} 个文件`
})

onMounted(load)

function formatBytes(value: number) {
  return value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`
}

async function load() {
  loading.value = true; error.value = ''
  try {
    const [nextSettings, nextStatus] = await Promise.all([
      api<PixivSettings>('/pixiv/settings'),
      api<PixivStatus>('/pixiv/status'),
    ])
    settings.value = nextSettings
    status.value = nextStatus
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}

async function save() {
  if (!settings.value) return
  saving.value = true; error.value = ''
  try {
    const payload: Record<string, unknown> = {
      localMode: settings.value.localMode,
      defaultBookmarkRestrict: settings.value.defaultBookmarkRestrict,
      autoBookmarkTags: settings.value.autoBookmarkTags,
      cacheLimitMb: settings.value.cacheLimitMb,
    }
    if (token.value.trim()) payload.refreshToken = token.value.trim()
    settings.value = await api<PixivSettings>('/pixiv/settings', { method: 'PUT', body: JSON.stringify(payload) })
    token.value = ''
    await load()
    appEvents.emit('pixiv:auth-changed', {
      configured: settings.value.configured,
      localMode: settings.value.localMode,
      accountId: settings.value.account?.id,
    })
    emit('notice', settings.value.configured ? 'Pixiv 设置已保存' : '设置已保存，尚未连接 Pixiv 账号')
  } catch (e) { error.value = (e as Error).message }
  finally { saving.value = false }
}

async function disconnect() {
  saving.value = true; error.value = ''
  try {
    await api('/pixiv/account', { method: 'DELETE' })
    token.value = ''
    await load()
    appEvents.emit('pixiv:auth-changed', {
      configured: settings.value?.configured ?? false,
      localMode: settings.value?.localMode ?? false,
      accountId: settings.value?.account?.id,
    })
    emit('notice', '已断开 Pixiv 账号，云端缓存和镜像未被删除')
  } catch (e) { error.value = (e as Error).message }
  finally { saving.value = false }
}

async function clearCache(days: number | null, all = false) {
  clearing.value = true; error.value = ''
  try {
    const result = await api<{ removed: number; bytes: number }>('/pixiv/cache/clear', {
      method: 'POST',
      body: JSON.stringify(all ? { all: true } : { olderThanDays: days }),
    })
    await load()
    emit('notice', `已清理 ${result.removed} 个云端缓存文件`)
  } catch (e) { error.value = (e as Error).message }
  finally { clearing.value = false }
}
</script>

<template>
  <section class="settings-section">
    <div class="section-heading"><div><h3>Pixiv 云服务</h3><p>服务端保存 refresh_token，提供云搜索、云推荐、云收藏与资源缓存。</p></div><Icon name="cloud" /></div>
    <p v-if="loading" class="helper"><Icon name="refresh" class="spinning" :size="16" />正在读取 Pixiv 设置…</p>
    <form v-else-if="settings" class="pixiv-form" @submit.prevent="save">
      <label class="menu-row pixiv-toggle"><span>本地模式</span><span class="fuzzy-toggle"><input v-model="settings.localMode" type="checkbox" :disabled="!settings.configured" /><span class="mini-switch" /><span>{{ settings.localMode ? '已开启' : '已关闭' }}</span></span></label>
      <p class="helper">未登录时自动开启本地模式；登录后自动关闭，也可手动开启以暂停云功能。</p>
      <div class="pixiv-account" :class="{ connected: settings.configured }">
        <Icon :name="settings.configured ? 'success' : 'warning'" :size="20" />
        <div><strong>{{ settings.account?.name || '未连接 Pixiv 账号' }}</strong><small v-if="settings.account">@{{ settings.account.account }} · UID {{ settings.account.id }}<template v-if="settings.account.premium"> · Premium</template></small><small v-else>填写 refresh_token 后由服务端验证并保存。</small></div>
      </div>
      <label class="field">refresh_token<div class="key-field"><input v-model="token" :type="showToken ? 'text' : 'password'" autocomplete="off" spellcheck="false" :placeholder="settings.configured ? '已配置；留空表示不修改' : '粘贴 Pixiv refresh_token'" /><button type="button" class="button text small" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button></div><span>token 只发送到服务端保存，接口不回传明文。</span></label>
      <details class="token-help"><summary>如何获取 refresh_token？</summary><p>本应用不自建 Pixiv 登录页。可在信任的 Pixiv OAuth / PKCE 第三方客户端或取 token 工具中完成一次登录，再从返回的 OAuth token 响应里复制 <code>refresh_token</code>。不要填写 <code>access_token</code>，它约一小时后就会失效。</p></details>
      <fieldset class="bookmark-settings"><legend>收藏选项</legend>
        <div class="bookmark-destination">
          <div class="bookmark-destination-copy"><span>默认收藏到</span><small>点击云端收藏按钮时，直接使用此选项。</small></div>
          <AppSelect v-model="settings.defaultBookmarkRestrict" label="默认收藏到" :options="[{ value: 'private', label: '私密收藏夹' }, { value: 'public', label: '公开收藏夹' }]" />
        </div>
        <label class="menu-row pixiv-toggle"><span>自动附加收藏标签</span><span class="fuzzy-toggle"><input v-model="settings.autoBookmarkTags" type="checkbox" /><span class="mini-switch" /><span>{{ settings.autoBookmarkTags ? '优先原文，最多 10 个' : '已关闭' }}</span></span></label>
      </fieldset>
      <label class="field">云端缓存上限（MB）<input v-model.number="settings.cacheLimitMb" type="number" min="128" max="1048576" step="128" /><span>默认 15360 MB；按最后访问时间自动 LRU 淘汰。</span></label>
      <div class="cache-card"><div><span>当前缓存</span><strong>{{ cacheText }}</strong></div><div class="cache-actions"><button type="button" class="button tonal small" :disabled="clearing" @click="clearCache(7)">清理 7 天前</button><button type="button" class="button tonal small" :disabled="clearing" @click="clearCache(30)">清理 30 天前</button><button type="button" class="button tonal small" :disabled="clearing" @click="clearCache(90)">清理 90 天前</button><button type="button" class="button danger small" :disabled="clearing" @click="clearCache(null, true)">全部清空</button></div></div>
      <p v-if="error" class="inline-error" role="alert"><Icon name="warning" :size="18" />{{ error }}</p>
      <div class="form-actions"><button v-if="settings.configured" type="button" class="button text" :disabled="saving" @click="disconnect">断开账号</button><button class="button filled" :disabled="saving"><Icon :name="saving ? 'refresh' : 'check'" :class="{ spinning: saving }" :size="18" />{{ saving ? '正在保存…' : '保存 Pixiv 设置' }}</button></div>
    </form>
  </section>
</template>

<style scoped>
.pixiv-form { display: grid; gap: 14px; }
.bookmark-settings { min-width: 0; display: grid; gap: 14px; margin: 0; padding: 16px; border: 1px solid var(--outline); border-radius: 13px; }
.bookmark-settings legend { padding: 0 6px; color: var(--text); font-size: 12px; font-weight: 600; }
.bookmark-destination { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; }
.bookmark-destination-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.bookmark-destination-copy > span { color: var(--text); font-size: 12px; font-weight: 600; }
.bookmark-destination-copy > small { color: var(--muted); font-size: 10px; line-height: 1.6; }
.bookmark-destination > .app-select { flex: 0 0 160px; min-width: 0; }
.pixiv-toggle { padding: 0; }
.pixiv-toggle:hover { background: transparent; }
.settings-section { border-top: 1px solid var(--outline); }
.token-help { padding: 12px 14px; border: 1px solid var(--outline); border-radius: 12px; background: var(--surface-low); color: var(--muted); font-size: 10px; line-height: 1.8; }
.token-help summary { color: var(--text); cursor: pointer; font-weight: 600; }
.token-help p { margin: 9px 0 0; }
.token-help code { color: var(--primary); }
.pixiv-account { display: flex; align-items: center; gap: 11px; padding: 13px 14px; border: 1px solid var(--outline); border-radius: 13px; background: var(--surface-low); }
.pixiv-account.connected { border-color: color-mix(in srgb, var(--primary) 55%, var(--outline)); }
.pixiv-account > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pixiv-account small { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.cache-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px; border: 1px solid var(--outline); border-radius: 13px; background: var(--surface-low); }
.cache-card > div:first-child { display: flex; flex-direction: column; gap: 4px; }
.cache-card span { color: var(--muted); font-size: 10px; }
.cache-actions { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
@media (max-width: 700px) { .cache-card { align-items: stretch; flex-direction: column; } .cache-actions { justify-content: flex-start; } }
@media (max-width: 480px) { .bookmark-destination { align-items: stretch; flex-direction: column; gap: 9px; } .bookmark-destination > .app-select { flex-basis: auto; width: 100%; } }
</style>
