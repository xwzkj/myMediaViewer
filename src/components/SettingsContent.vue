<script setup lang="ts">
import { ref, computed } from 'vue'
import type { DirectoryEntry, LibraryStatus, Source } from '../../shared/types'
import SourceRuleEditor from './SourceRuleEditor.vue'
import { customRules, sourcePreset } from '../../shared/source-presets'
import Icon from './Icon.vue'
import FolderPicker from './FolderPicker.vue'
import AiSettingsPanel from './AiSettingsPanel.vue'
import { api } from '../api'

const props = defineProps<{ status: LibraryStatus | null }>()
const emit = defineEmits<{ close: []; changed: []; notice: [message: string] }>()
const editing = ref<string | null>(null)
const formVisible = ref(false)
const name = ref('')
const folder = ref('')
const rules = ref(customRules())
const previewErrors = ref(false)
const acceptPreviewErrors = ref(false)
const previewBusy = ref(false)
const invalidRules = ref(false)
const error = ref('')
const saving = ref(false)
const deleting = ref<string | null>(null)
const pickerVisible = ref(false)
const busy = computed(() => saving.value || previewBusy.value || props.status?.scan.running)
const shortcuts = computed(() => props.status?.sources.map(source => ({ name: source.name, path: source.path })) || [])
function edit(source?: Source) {
  editing.value = source?.id || null
  name.value = source?.name || ''
  folder.value = source?.path || ''
  rules.value = source?.rules ? JSON.parse(JSON.stringify(source.rules)) : source && source.kind !== 'custom' ? sourcePreset(source.kind) : customRules()
  previewErrors.value = false; acceptPreviewErrors.value = false; invalidRules.value = false
  error.value = ''; deleting.value = null; formVisible.value = true
  if (!source) pickerVisible.value = true
}
function chooseFolder(directory: DirectoryEntry) {
  folder.value = directory.path
  if (!name.value.trim()) name.value = directory.name.slice(0, 60)
  error.value = ''
}
async function save() {
  if (previewBusy.value || invalidRules.value) return
  if (!folder.value) { error.value = '请先选择一个媒体文件夹'; pickerVisible.value = true; return }
  if (previewErrors.value && !acceptPreviewErrors.value) { error.value = '预览存在错误，请修复或勾选仍然保存'; return }
  saving.value = true; error.value = ''
  try {
    await api(`/sources${editing.value ? `/${editing.value}` : ''}`, { method: editing.value ? 'PUT' : 'POST', body: JSON.stringify({ name: name.value, path: folder.value, rules: rules.value }) })
    formVisible.value = false; emit('changed'); emit('notice', '目录已保存，正在整理作品')
  } catch (e) { error.value = (e as Error).message }
  finally { saving.value = false }
}
async function remove(id: string) {
  saving.value = true; error.value = ''
  try {
    await api(`/sources/${id}`, { method: 'DELETE' })
    deleting.value = null; emit('changed'); emit('notice', '已移除目录，原始文件未改动')
  } catch (e) { error.value = (e as Error).message }
  finally { saving.value = false }
}
</script>

<template>
  <main class="settings-page" aria-labelledby="settings-title">
    <header class="settings-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2 id="settings-title">媒体库设置</h2></div><button class="icon-button" aria-label="返回上一页" @click="emit('close')"><Icon name="left" /></button></header>
    <div class="settings-body">
      <section>
        <div class="section-heading"><div><h3>媒体目录</h3><p>连接文件夹，让散落的收藏井然有序。</p></div><button class="button tonal small" @click="edit()" :disabled="busy"><Icon name="plus" :size="18" />添加目录</button></div>
        <div v-if="!status?.sources.length && !formVisible" class="directory-empty"><Icon name="folder-plus" :size="40" /><p>还没有添加媒体目录</p><span>添加运行服务的电脑上的文件夹即可开始。</span></div>
        <div v-for="source in status?.sources" :key="source.id" class="source-item">
          <div class="source-item-main"><span class="source-symbol"><Icon name="folder" /></span><div class="source-text"><h4>{{ source.name }} <span class="tiny-badge">{{ source.rules?.preset ? `${source.rules.preset} 预设` : '自定义规则' }}</span></h4><p :title="source.path">{{ source.path }}</p><span class="source-meta" :class="{ 'error-text': !source.online }">{{ source.online ? `${source.works} 组作品` : '目录离线 · 已保留索引' }}</span></div><button class="icon-button" :disabled="busy" :aria-label="`编辑 ${source.name}`" @click="edit(source)"><Icon name="edit" :size="20" /></button><button class="icon-button" :disabled="busy" :aria-label="`移除 ${source.name}`" @click="deleting = source.id"><Icon name="delete" :size="20" /></button></div>
          <div v-if="deleting === source.id" class="delete-confirm"><p>移除这个目录及它的收藏记录？原始文件会保留。</p><div><button class="button text small" @click="deleting = null">取消</button><button class="button danger small" :disabled="busy" @click="remove(source.id)">移除目录</button></div></div>
        </div>
        <form v-if="formVisible" class="source-form" @submit.prevent="save">
          <h4>{{ editing ? '编辑媒体目录' : '添加媒体目录' }}</h4>
          <label class="field">目录名称<input v-model="name" required maxlength="60" placeholder="例如：我的插画收藏" autofocus /></label>
          <div class="field folder-field"><span id="media-folder-label">媒体文件夹</span><button type="button" class="folder-choice" :disabled="busy" aria-labelledby="media-folder-label selected-folder-path" @click="pickerVisible = true"><Icon name="folder-open" :size="23" /><span id="selected-folder-path" :class="{ 'folder-placeholder': !folder }">{{ folder || '点击浏览并选择文件夹' }}</span><span class="folder-choice-action">{{ folder ? '更改' : '浏览' }}<Icon name="right" :size="17" /></span></button><span>选择这台电脑上的文件夹，里面的媒体会自动整理。</span></div>
          <SourceRuleEditor v-model="rules" :folder="folder" :name="name" :disabled="!!busy" @busy="previewBusy = $event" @invalid="invalidRules = $event" @preview-errors="previewErrors = $event; acceptPreviewErrors = false" />
          <label v-if="previewErrors" class="helper"><input v-model="acceptPreviewErrors" type="checkbox" />预览存在错误，仍然保存（失败的元信息将使用默认值）</label>
          <div class="form-actions"><button type="button" class="button text" @click="formVisible = false">取消</button><button class="button filled" :disabled="busy || invalidRules || !folder || (previewErrors && !acceptPreviewErrors)"><Icon name="check" :size="18" />{{ saving ? '正在保存…' : '保存并扫描' }}</button></div>
        </form>
        <p v-if="error" class="inline-error" role="alert"><Icon name="warning" :size="20" />{{ error }}</p>
        <p v-if="status?.scan.running" class="helper"><Icon name="refresh" class="spinning" :size="16" />{{ status.scan.phase }} · {{ status.scan.files }} 个文件</p>
      </section>
      <section class="settings-section"><div class="section-heading"><div><h3>在其他设备上访问</h3><p>同一 Wi-Fi 下，在浏览器中打开以下地址。</p></div><Icon name="lan" /></div><div class="network-addresses"><code v-for="address in status?.addresses" :key="address">{{ address }}</code><p v-if="!status?.addresses.length">暂未检测到局域网地址。</p></div><p class="helper">保持这台电脑和服务运行。首次连接时，允许 Windows 防火墙的专用网络访问。</p><p class="helper"><Icon :name="status?.publicAccess ? 'warning' : 'success'" :size="16" />{{ status?.publicAccess ? '当前允许公网地址访问，请只在可信网络中开放端口。' : '默认只服务局域网与保留地址。需要公网访问时，把环境变量 ALLOW_PUBLIC_ACCESS 设为 1 再重启服务。' }}</p></section>
      <AiSettingsPanel @notice="emit('notice', $event)" />
      <section class="settings-section"><div class="section-heading"><div><h3>视频兼容性</h3><p>优先播放原文件，必要时生成兼容版本。</p></div><span class="status-chip" :class="{ unavailable: !status?.ffmpeg }"><Icon :name="status?.ffmpeg ? 'success' : 'warning'" :size="17" />{{ status?.ffmpeg ? 'FFmpeg 已就绪' : 'FFmpeg 未找到' }}</span></div><p v-if="!status?.ffmpeg" class="helper">将 FFmpeg 加入 PATH，或设置 FFMPEG_PATH 后重启服务，即可生成视频封面和兼容版本。</p></section>
      <section v-if="status?.scan.errors.length" class="settings-section"><h3>扫描提示</h3><ul class="scan-errors"><li v-for="item in status.scan.errors" :key="item">{{ item }}</li></ul></section>
      <footer class="settings-footer"><Icon name="leaf" :size="18" />拾光 · 让喜欢的，留在身边。<span>v0.1.0</span></footer>
    </div>
  </main>
  <FolderPicker v-if="pickerVisible" :initial-path="folder" :shortcuts="shortcuts" @select="chooseFolder" @close="pickerVisible = false" />
</template>
