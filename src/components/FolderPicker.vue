<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { DirectoryEntry, DirectoryListing } from '../../shared/types'
import { api } from '../api'
import Icon from './Icon.vue'

const props = defineProps<{ initialPath?: string; shortcuts?: DirectoryEntry[] }>()
const emit = defineEmits<{ close: []; select: [directory: DirectoryEntry] }>()
const dialog = ref<HTMLDialogElement>()
const breadcrumb = ref<HTMLElement>()
const listing = ref<DirectoryListing>({ path: null, parent: null, breadcrumbs: [], directories: [] })
const loading = ref(false)
const error = ref('')
const filter = ref('')
let controller: AbortController | undefined
let attemptedPath: string | undefined
const visible = computed(() => listing.value.directories.filter(entry => entry.name.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase())))
const current = computed(() => listing.value.breadcrumbs.at(-1))

async function browse(directory?: string) {
  controller?.abort()
  const active = new AbortController()
  controller = active
  attemptedPath = directory
  loading.value = true; error.value = ''; filter.value = ''
  try {
    const result = await api<DirectoryListing>(`/directories${directory ? `?path=${encodeURIComponent(directory)}` : ''}`, { signal: active.signal })
    if (controller !== active) return
    listing.value = result
    await nextTick()
    breadcrumb.value?.scrollTo({ left: breadcrumb.value.scrollWidth })
  } catch (e) {
    if (!active.signal.aborted) error.value = (e as Error).message
  } finally { if (controller === active) loading.value = false }
}
function select() {
  if (!loading.value && !error.value && current.value) {
    emit('select', current.value)
    dialog.value?.close()
  }
}
function backdrop(event: MouseEvent) {
  if (event.target !== dialog.value || !dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.value.close()
}
onMounted(() => { dialog.value?.showModal(); void browse(props.initialPath || undefined) })
onUnmounted(() => controller?.abort())
</script>

<template>
  <dialog ref="dialog" class="folder-picker" aria-labelledby="folder-picker-title" @close="emit('close')" @click="backdrop">
    <header class="picker-heading"><span class="picker-symbol"><Icon name="folder-open" :size="26" /></span><div><h2 id="folder-picker-title">选择媒体文件夹</h2><p>浏览运行服务的电脑，手机上也能直接选择。</p></div><button type="button" class="icon-button" aria-label="关闭文件夹选择器" @click="dialog?.close()"><Icon name="close" /></button></header>
    <div class="picker-navigation">
      <button type="button" class="icon-button" aria-label="返回上一级" :disabled="loading || (!listing.path && !error)" @click="browse(listing.parent || undefined)"><Icon name="arrow-left" :size="20" /></button>
      <nav ref="breadcrumb" class="folder-breadcrumbs" aria-label="当前文件夹路径"><button type="button" :aria-current="listing.path ? undefined : 'location'" @click="browse()"><Icon name="monitor" :size="18" />此电脑</button><template v-for="(part, index) in listing.breadcrumbs" :key="part.path"><Icon name="right" :size="15" /><button type="button" :title="part.path" :aria-current="index === listing.breadcrumbs.length - 1 ? 'location' : undefined" @click="browse(part.path)">{{ part.name }}</button></template></nav>
    </div>
    <div v-if="!listing.path && shortcuts?.length" class="folder-shortcuts"><span>已添加的目录</span><button v-for="shortcut in shortcuts" :key="shortcut.path" type="button" class="button tonal small" :title="shortcut.path" @click="browse(shortcut.path)"><Icon name="folder" :size="16" />{{ shortcut.name }}</button></div>
    <div class="picker-filter"><Icon name="search" :size="19" /><input v-model="filter" aria-label="筛选当前文件夹" placeholder="筛选当前层级的文件夹" :disabled="loading || !!error" /><button v-if="filter" type="button" class="icon-button small-icon" aria-label="清空文件夹筛选" @click="filter = ''"><Icon name="close" :size="17" /></button><span v-else>{{ listing.directories.length }} {{ listing.path ? '个文件夹' : '个磁盘' }}</span></div>
    <div class="folder-list" :aria-busy="loading" role="region" aria-label="文件夹列表">
      <div v-if="loading" class="picker-state" role="status"><span class="spinner" /><p>正在读取文件夹…</p></div>
      <div v-else-if="error" class="picker-state picker-error" role="alert"><Icon name="warning" :size="34" /><p>{{ error }}</p><div><button type="button" class="button text small" @click="browse()">返回此电脑</button><button type="button" class="button tonal small" @click="browse(attemptedPath)">重试</button></div></div>
      <template v-else>
        <button v-for="entry in visible" :key="entry.path" type="button" class="folder-entry" :aria-label="`打开 ${entry.name}`" @click="browse(entry.path)"><span class="folder-entry-icon"><Icon :name="listing.path ? 'folder' : 'monitor'" :size="23" /></span><span>{{ entry.name }}</span><Icon name="right" :size="19" /></button>
        <div v-if="!visible.length" class="picker-state"><Icon :name="filter ? 'search' : 'folder-open'" :size="36" /><p>{{ filter ? '没有匹配的文件夹' : listing.path ? '这里没有子文件夹' : '暂未找到可访问的磁盘' }}</p><small v-if="!filter && listing.path">可以直接选择当前文件夹，里面的媒体会在扫描时读取。</small><button v-if="filter" type="button" class="button text small" @click="filter = ''">清除筛选</button></div>
      </template>
    </div>
    <footer class="picker-footer"><div class="picker-selection"><span>当前选择</span><strong :title="listing.path || ''">{{ listing.path || '请先打开一个磁盘或文件夹' }}</strong></div><div class="picker-actions"><button type="button" class="button text" @click="dialog?.close()">取消</button><button type="button" class="button filled" :disabled="loading || !!error || !current" @click="select"><Icon name="check" :size="18" />选择此文件夹</button></div></footer>
  </dialog>
</template>

<style scoped>
.folder-picker{width:min(660px,calc(100vw - 40px));height:min(660px,calc(100dvh - 64px));max-width:none;max-height:none;border-radius:26px;overflow:hidden;padding:0}
.folder-picker[open]{display:flex;flex-direction:column}
.picker-heading{display:flex;align-items:center;gap:13px;padding:25px 24px 21px;flex-shrink:0}
.picker-symbol{display:grid;place-items:center;width:48px;height:48px;border-radius:16px;background:var(--primary-container);color:var(--primary);flex-shrink:0}
.picker-heading>div{flex:1;min-width:0}.picker-heading h2{font-size:20px;font-weight:600}.picker-heading p{margin-top:7px;font-size:11px;color:var(--muted);line-height:1.7}.picker-heading>.icon-button{align-self:flex-start}
.picker-navigation{display:flex;align-items:center;gap:6px;padding:0 18px 12px;border-bottom:1px solid var(--outline);flex-shrink:0}
.folder-breadcrumbs{display:flex;align-items:center;gap:3px;overflow-x:auto;min-width:0;flex:1;scrollbar-width:thin}
.folder-breadcrumbs button{display:flex;align-items:center;gap:7px;white-space:nowrap;background:transparent;color:var(--muted);border-radius:8px;padding:10px 8px;font-size:12px;max-width:240px;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;min-height:40px}
.folder-breadcrumbs button:hover{background:var(--surface-high)}.folder-breadcrumbs button[aria-current]{color:var(--primary);font-weight:600}.folder-breadcrumbs>.icon{color:var(--muted)}
.folder-shortcuts{display:flex;align-items:center;gap:8px;padding:14px 24px 0;overflow:auto;flex-shrink:0}.folder-shortcuts>span{font-size:10px;color:var(--muted);white-space:nowrap}.folder-shortcuts .button{max-width:220px;overflow:hidden;flex-shrink:0}
.picker-filter{display:flex;align-items:center;gap:9px;background:var(--surface-low);border:1px solid var(--outline);border-radius:12px;margin:15px 24px 10px;padding:0 12px;flex-shrink:0;color:var(--muted)}
.picker-filter input{min-width:0;flex:1;border:0;background:transparent;height:43px;font-size:12px;color:var(--text)}.picker-filter:focus-within{border-color:var(--primary)}.picker-filter>span{font-size:10px;white-space:nowrap}
.folder-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 14px 10px;margin:0 8px;scrollbar-gutter:stable}
.folder-entry{display:flex;align-items:center;gap:12px;width:100%;min-height:53px;border-radius:12px;padding:8px 12px;background:transparent;text-align:left;font-size:13px}
.folder-entry:hover,.folder-entry:focus-visible{background:var(--surface-high)}.folder-entry:focus-visible{outline-offset:-3px}.folder-entry>span:nth-child(2){flex:1;min-width:0;overflow-wrap:anywhere}.folder-entry>.icon{color:var(--muted)}.folder-entry-icon{width:34px;height:34px;display:grid;place-items:center;flex-shrink:0;color:var(--primary);background:var(--surface-high);border-radius:10px}
.picker-state{min-height:180px;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:24px;text-align:center;color:var(--muted);font-size:13px}.picker-state small{font-size:11px;line-height:1.8}.picker-state>div{display:flex;gap:6px}.picker-error>p{color:var(--danger)}
.picker-footer{flex-shrink:0;border-top:1px solid var(--outline);padding:18px 24px 20px;background:var(--surface-low)}.picker-selection{display:flex;flex-direction:column;gap:6px;min-width:0}.picker-selection>span{font-size:10px;color:var(--muted)}.picker-selection strong{font-size:12px;font-weight:500;overflow-wrap:anywhere;max-height:55px;overflow:auto;line-height:1.7}.picker-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}
@media(max-width:700px){.folder-picker{width:calc(100vw - 20px);height:min(680px,calc(100dvh - 30px));border-radius:22px}.picker-heading{padding:20px 16px 16px;gap:10px}.picker-symbol{width:40px;height:40px;border-radius:13px}.picker-heading h2{font-size:18px}.picker-heading p{font-size:10px}.picker-heading>.icon-button{width:36px;height:40px}.picker-navigation{padding-inline:10px}.picker-filter{margin:12px 16px 9px}.picker-filter input{font-size:16px}.picker-filter input::placeholder{font-size:12px}.folder-list{padding-inline:6px}.folder-entry{padding-inline:10px;min-height:54px}.picker-footer{padding:15px 18px 18px}.folder-shortcuts{padding-inline:16px}.picker-state{padding:16px;min-height:130px}}
</style>
