<script setup lang="ts">
import { ref, watch } from 'vue'
import type { SourceRules, SourcePreview } from '../../shared/types'
import { sourcePreset, customRules } from '../../shared/source-presets'
import { api } from '../api'
const props = defineProps<{ modelValue: SourceRules; folder: string; name: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [SourceRules]; 'preview-errors': [boolean]; busy: [boolean]; invalid: [boolean] }>()
const preview = ref<SourcePreview | null>(null)
const error = ref(''), loading = ref(false), overrides = ref('')
watch(() => props.modelValue.typeOverrides, v => { overrides.value = Object.entries(v).map(([ext, kind]) => `${ext}=${kind}`).join(', ') }, { immediate: true, deep: true })
watch(() => JSON.stringify([props.modelValue, props.folder]), () => { preview.value = null; error.value = ''; emit('preview-errors', false) })
function update(patch: Partial<SourceRules>) { emit('update:modelValue', { ...props.modelValue, ...patch }) }
function applyPreset(value: string) { emit('update:modelValue', value === 'custom' ? customRules() : sourcePreset(value as 'pixiv' | 'telegram')) }
function changeOverrides() {
  const entries = overrides.value.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split('=').map(p => p.trim()))
  if (entries.some(([ext, kind]) => !/^[a-z0-9]+$/.test(ext) || !['image','video','animation'].includes(kind))) { error.value = '类型覆盖格式：webm=animation, mp4=video'; emit('invalid', true); return }
  update({ typeOverrides: Object.fromEntries(entries) }); error.value = ''; emit('invalid', false)
}
async function test() {
  loading.value = true; emit('busy', true); preview.value = null; error.value = ''
  // Snapshot requests; editing is disabled until the sample returns.
  try {
    preview.value = await api<SourcePreview>('/sources/preview', { method: 'POST', body: JSON.stringify({ name: props.name || '预览', path: props.folder, rules: props.modelValue }) })
    emit('preview-errors', !!(preview.value.errors.length || preview.value.groups.some(g => g.error)))
  } catch (e) { error.value = (e as Error).message; emit('preview-errors', true) }
  finally { loading.value = false; emit('busy', false) }
}
</script>

<template>
  <fieldset class="source-rule-editor" :disabled="disabled || loading">
    <legend>文件分组与元信息</legend>
    <div class="preset-actions">
      <span>套用预设</span>
      <button type="button" class="button text small" @click="applyPreset('pixiv')">Pixiv</button>
      <button type="button" class="button text small" @click="applyPreset('telegram')">Telegram</button>
      <button type="button" class="button text small" @click="applyPreset('custom')">空白自定义</button>
    </div>
    <p class="helper">套用预设会替换当前规则和脚本。更改分组 ID 或范围可能产生新作品身份，旧收藏不会自动映射。</p>
    <div class="rule-grid">
      <label class="field">
        分组范围
        <select :value="modelValue.scope" @change="update({ scope: ($event.target as HTMLSelectElement).value as SourceRules['scope'] })">
          <option value="source">整个来源合并</option>
          <option value="directory">按所在子目录隔离</option>
        </select>
        <span>整个来源合并时，所有子文件夹内同 ID 的文件归为一组；子目录隔离时，每个子文件夹独立分组。</span>
      </label>
      <label class="field">
        重复文件处理
        <select :value="modelValue.duplicates" @change="update({ duplicates: ($event.target as HTMLSelectElement).value as SourceRules['duplicates'] })">
          <option value="all">保留全部</option>
          <option value="page">同类型同页择优</option>
        </select>
        <span>保留全部时，同一页的多个文件都会保留；同页择优时，只保留同类型（图片/视频/动画）中最大的一个。</span>
      </label>
    </div>
    <label class="field">
      媒体命名规则
      <span>定义如何从文件名提取分组 ID、页码、序号等信息。支持占位符模板和高级正则两种语法。</span>
    </label>
    <div class="rule-row">
      <select aria-label="媒体规则语法" :value="modelValue.media.mode" @change="update({ media: { ...modelValue.media, mode: ($event.target as HTMLSelectElement).value as 'template' | 'regex' } })">
        <option value="template">占位符模板</option>
        <option value="regex">高级正则</option>
      </select>
      <input aria-label="媒体命名规则" class="rule-pattern" :value="modelValue.media.pattern" @input="update({ media: { ...modelValue.media, pattern: ($event.target as HTMLInputElement).value } })" placeholder="例如：{id}[_p{page}].{ext}" />
      <label><input type="checkbox" :checked="modelValue.media.caseSensitive" @change="update({ media: { ...modelValue.media, caseSensitive: ($event.target as HTMLInputElement).checked } })" />区分大小写</label>
    </div>
    <label class="field">
      缺失页码的默认值
      <input type="number" min="0" :value="modelValue.media.defaultPage ?? ''" @input="update({ media: { ...modelValue.media, defaultPage: ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value) } })" placeholder="留空则保留独立文件" />
      <span>未提取到页码时的回退值。留空则不合并，每个文件作为独立页保留。</span>
    </label>
    <label class="field">
      元文件规则
      <span>定义 TXT、JSON 等元数据文件的命名规则。同一分组 ID 的媒体和元文件会自动关联。可添加多条规则匹配不同格式。</span>
    </label>
    <div v-for="(rule, index) in modelValue.metadata" :key="index" class="rule-row">
      <select :aria-label="`元文件规则 ${index + 1} 语法`" :value="rule.mode" @change="update({ metadata: modelValue.metadata.map((r, i) => i === index ? { ...r, mode: ($event.target as HTMLSelectElement).value as 'template' | 'regex' } : r) })">
        <option value="template">占位符模板</option>
        <option value="regex">高级正则</option>
      </select>
      <input :aria-label="`元文件规则 ${index + 1}`" class="rule-pattern" :value="rule.pattern" @input="update({ metadata: modelValue.metadata.map((r, i) => i === index ? { ...r, pattern: ($event.target as HTMLInputElement).value } : r) })" placeholder="例如：{id}.json" />
      <label><input type="checkbox" :checked="rule.caseSensitive" @change="update({ metadata: modelValue.metadata.map((r, i) => i === index ? { ...r, caseSensitive: ($event.target as HTMLInputElement).checked } : r) })" />区分大小写</label>
      <button type="button" class="button text small" :aria-label="`删除元文件规则 ${index + 1}`" @click="update({ metadata: modelValue.metadata.filter((_, i) => i !== index) })">删除</button>
    </div>
    <button type="button" class="button text small" :disabled="modelValue.metadata.length >= 16" @click="update({ metadata: [...modelValue.metadata, { mode: 'template', pattern: '{id}.txt', caseSensitive: false }] })">＋ 添加元文件规则</button>
    <details class="rule-help">
      <summary>规则语法与脚本接口说明</summary>
      <p><strong>占位符模板语法：</strong></p>
      <p>示例：<code>{id}[_p{page}].{ext}</code>。使用花括号 <code>{}</code> 包裹占位符，中括号 <code>[]</code> 表示可选段。<code>{id}</code> 是必需的分组标识，<code>{page}</code> 和 <code>{sequence}</code> 必须是非负整数，<code>{ext}</code> 匹配扩展名，其他自定义占位符提取任意文本。使用反斜杠 <code>\</code> 转义特殊字符。</p>
      <p><strong>高级正则语法：</strong></p>
      <p>示例：<code>(?&lt;id&gt;\d+)(?:_p(?&lt;page&gt;\d+))?\.(?&lt;ext&gt;jpg|png)</code>。使用命名捕获组 <code>(?&lt;name&gt;...)</code>，必须包含 <code>(?&lt;id&gt;...)</code>。规则完整匹配文件名，不匹配路径。只开放大小写敏感开关，不支持其他标志位。</p>
      <p><strong>脚本接口：</strong></p>
      <p>必须导出 <code>export async function extract(input)</code>。输入对象包含：<code>{ id, directory, media, files }</code>。<code>files</code> 是元文件数组，每项含 <code>filename, relativePath, extension, size, modified, captures, text</code>（已解码的文本内容）。<code>media</code> 是媒体文件描述数组，不含文件内容。<code>directory</code> 在全来源合并时为空字符串。</p>
      <p>返回对象可包含：<code>title</code>（标题）、<code>author</code>（作者）、<code>description</code>（描述）、<code>tags: string[]</code>（标签数组）、<code>date</code>（ISO 日期字符串）、<code>originalUrl</code>（原始链接）。所有字段可选。</p>
      <p><strong>安全限制：</strong></p>
      <p>输入对象深度只读，禁止修改。沙箱内无文件系统、网络、外部模块、定时器和宿主 API。每组独立执行，1 秒执行预算，2 秒硬截止，64 MiB 内存限制。元文件最多 64 个，单个不超过 2 MiB，总计不超过 8 MiB。</p>
    </details>
    <label class="field">
      媒体扩展名类型覆盖
      <input v-model="overrides" placeholder="webm=animation, mp4=video" @change="changeOverrides" />
      <span>自定义扩展名的媒体类型。格式：<code>扩展名=类型</code>，多个用逗号分隔。类型可选：<code>image</code>（图片）、<code>video</code>（视频）、<code>animation</code>（动画）。留空使用默认类型。</span>
    </label>
    <label class="field">
      元信息提取脚本（JavaScript）
      <span>从元文件内容中提取标题、作者、描述等信息。在沙箱内执行，不能访问文件系统和网络。</span>
      <textarea class="source-script" aria-label="元信息提取脚本" spellcheck="false" :value="modelValue.script" @input="update({ script: ($event.target as HTMLTextAreaElement).value })" placeholder="export async function extract(input) {&#10;  return {&#10;    title: '',&#10;    author: '',&#10;    description: '',&#10;    tags: [],&#10;    date: '',&#10;    originalUrl: ''&#10;  };&#10;}" />
    </label>
    <button type="button" class="button outlined" :disabled="!folder || loading" @click="test">{{ loading ? '正在安全预览…' : '用真实文件预览' }}</button>
    <p class="helper">预览功能会在沙箱中安全执行规则和脚本。最多枚举 5,000 个文件、显示 20 组、运行前 5 组脚本。预览不会保存配置、不会修改索引或收藏。</p>
  </fieldset>
  <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  <section v-if="preview" class="source-preview" aria-label="分组预览">
    <p>已枚举 {{ preview.enumerated }} 个文件，展示 {{ preview.groups.length }} 组{{ preview.truncated ? '（已截断，仅为样本）' : '' }}</p>
    <p v-if="!preview.groups.length">没有匹配到媒体分组，请检查规则是否正确。</p>
    <p v-for="message in preview.errors" :key="message" class="inline-error">{{ message }}</p>
    <details v-for="(group, index) in preview.groups" :key="`${group.directory}/${group.id}`" :open="index === 0">
      <summary>{{ group.directory ? `${group.directory} / ` : '' }}{{ group.id }} · {{ group.media.length }} 个媒体 / {{ group.metadata.length }} 个元文件</summary>
      <div>
        <strong>媒体文件</strong>
        <pre>{{ group.media.join('\n') }}</pre>
        <strong>元数据文件</strong>
        <pre>{{ group.metadata.join('\n') || '无' }}</pre>
        <strong>提取结果</strong>
        <p v-if="group.error" class="inline-error">{{ group.error }}</p>
        <pre v-else-if="group.result">{{ JSON.stringify(group.result, null, 2) }}</pre>
        <p v-else style="font-size: 11px; color: var(--muted); padding: 8px 0;">未执行脚本（仅执行前 5 组）。</p>
      </div>
    </details>
  </section>
</template>
