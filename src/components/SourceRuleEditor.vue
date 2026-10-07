<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { SourceRules, SourcePreview, FileRule, MetadataFields } from '../../shared/types'
import { sourcePreset, customRules } from '../../shared/source-presets'
import { ruleIssues, scriptIssues, issueLocation } from '../../shared/source-diagnostics'
import SourceAiPanel from './SourceAiPanel.vue'
import SourceCodeEditor from './SourceCodeEditor.vue'
import FileRuleControl from './FileRuleControl.vue'
import { api } from '../api'
const props = defineProps<{ modelValue: SourceRules; folder: string; name: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [SourceRules]; 'preview-errors': [boolean]; busy: [boolean]; invalid: [boolean] }>()
const preview = ref<SourcePreview | null>(null), error = ref(''), loading = ref(false), overrides = ref(''), overrideError = ref('')
const calculating = ref<number | null>(null)
const jsIssues = computed(() => scriptIssues(props.modelValue.script))
const invalid = computed(() => !!(overrideError.value || jsIssues.value.length || [props.modelValue.media,...props.modelValue.metadata].some(r => ruleIssues(r).length)))
watch(invalid, v => emit('invalid',v), {immediate:true})
watch(() => props.modelValue.typeOverrides, v => { overrides.value = Object.entries(v).map(([ext, kind]) => `${ext}=${kind}`).join(', '); overrideError.value = '' }, {immediate:true,deep:true})
watch(() => JSON.stringify([props.modelValue, props.folder]), () => { preview.value = null; error.value = ''; emit('preview-errors', false) })
function update(patch: Partial<SourceRules>) { emit('update:modelValue', {...props.modelValue,...patch}) }
function applyPreset(value: string) { emit('update:modelValue', value === 'custom' ? customRules() : sourcePreset(value as 'pixiv' | 'telegram')) }
function metadataRule(index: number, rule: FileRule) { update({metadata:props.modelValue.metadata.map((r,i) => i === index ? rule : r)}) }
function pathExample() {
  const rules = customRules()
  rules.media = {mode:'template', target:'relativePath', pattern:'{author}/{id}_{title}/{page}.{ext}',caseSensitive:false}
  rules.metadata = []
  rules.script = `export async function extract(input) {\n  // captures 来自媒体规则，不需要任何元文件。\n  const fields = input.media[0]?.captures || {};\n  return { title: fields.title || input.id, author: fields.author || "" };\n}`
  emit('update:modelValue',rules)
}
function changeOverrides() {
  const entries = overrides.value.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split('=').map(p => p.trim()))
  if (entries.some(parts => parts.length !== 2 || !/^[a-z0-9]+$/.test(parts[0]) || !['image','video','animation'].includes(parts[1]))) {overrideError.value = '格式：webm=animation, mp4=video'; return}
  overrideError.value = ''; update({typeOverrides:Object.fromEntries(entries)})
}
async function test() {
  if (invalid.value) return
  loading.value = true; emit('busy',true); preview.value = null; error.value = ''
  try {
    preview.value = await api<SourcePreview>('/sources/preview', {method:'POST',body:JSON.stringify({name:props.name || '预览',path:props.folder,rules:props.modelValue})})
    emit('preview-errors',!!(preview.value.errors.length || preview.value.groups.some(g=>g.error)))
  } catch (e) {error.value=(e as Error).message; emit('preview-errors',true)}
  finally {loading.value=false;emit('busy',false)}
}
async function calculate(index: number) {
  const current=preview.value
  if(!current?.token || calculating.value !== null)return
  const group=current.groups[index]
  calculating.value=index;emit('busy',true);delete group.error;delete group.result
  try {
    const result=await api<{result:MetadataFields}>('/sources/preview/calculate',{method:'POST',body:JSON.stringify({token:current.token,index})})
    if(preview.value===current)group.result=result.result
  } catch(e){if(preview.value===current)group.error=(e as Error).message}
  finally {
    calculating.value=null;emit('busy',false)
    if(preview.value===current)emit('preview-errors',!!(current.errors.length || current.groups.some(g=>g.error)))
  }
}
</script>
<template>
  <fieldset class="source-rule-editor" :disabled="disabled || loading">
    <legend>文件分组与元信息</legend>
    <div class="preset-actions"><span>套用预设</span><button type="button" class="button text small" @click="applyPreset('pixiv')">Pixiv</button><button type="button" class="button text small" @click="applyPreset('telegram')">Telegram</button><button type="button" class="button text small" @click="applyPreset('custom')">自定义</button><button type="button" class="button text small" @click="pathExample">目录 / 文件名示例</button></div>
    <p class="helper">套用示例会替换规则和脚本。更改分组 ID 或范围可能产生新作品身份，旧收藏不会自动映射。</p>
    <SourceAiPanel :folder="folder" :rules="modelValue" :disabled="disabled || loading" @apply="emit('update:modelValue',$event)" @busy="emit('busy',$event)" />
    <section class="rule-guide">
      <h4>规则如何决定分组</h4>
      <p>规则从文件名或相对路径中提取字段。<code>id</code> 相同的媒体归为同一组；<code>page</code> 决定组内页码。作者、标题等其他字段保存在 <code>captures</code>，由脚本生成元信息。</p>
      <p>例如 <code>画师A/123_夏日/0.jpg</code>：选择「相对路径」，规则写 <code>{author}/{id}_{title}/{page}.{ext}</code>，提取结果为 <code>author="画师A", id="123", title="夏日", page="0", ext="jpg"</code>。</p>
      <table><thead><tr><th>匹配对象</th><th>本例实际匹配文本</th></tr></thead><tbody><tr><td>文件名</td><td><code>0.jpg</code></td></tr><tr><td>相对路径</td><td><code>画师A/123_夏日/0.jpg</code></td></tr><tr><td>相对目录路径</td><td><code>画师A/123_夏日</code></td></tr><tr><td>直属目录名</td><td><code>123_夏日</code></td></tr></tbody></table>
      <p>路径从所选来源目录内部开始，统一用 <code>/</code>，不填写盘符。根目录直属文件的目录文本为空。所有规则都要求完整匹配；模板字段不跨越 <code>/</code>，任意深度路径请用高级正则。</p>
      <p><code>{id}</code> 决定分组；<code>{page}</code> 决定页码；<code>{sequence}</code> 用于收藏顺序；<code>{ext}</code> 是扩展名；<code>{author}</code>、<code>{title}</code> 等自定义字段交给脚本，不会自动覆盖元信息。</p>
      <p><strong>模板：</strong><code>{id}[_p{page}].{ext}</code> 同时匹配 <code>123.jpg</code> 和 <code>123_p2.jpg</code>。<code>[…]</code> 表示可选，其他字符按原样匹配；字面 <code>[</code> 写作 <code>\[</code>。字段名不可重复。页码/序号只能是非负整数。</p>
      <p><strong>正则：</strong><code>(?&lt;id&gt;\d+)(?:_p(?&lt;page&gt;\d+))?\.(?&lt;ext&gt;jpg|png)</code>；<code>\d+</code> 表示数字，<code>(?&lt;名字&gt;…)</code> 提取字段，<code>(?:…)?</code> 表示可选。不要加 <code>/…/i</code> 外壳。</p>
    </section>
    <div class="rule-grid">
      <label class="field">分组范围<select :value="modelValue.scope" @change="update({scope:($event.target as HTMLSelectElement).value as SourceRules['scope']})"><option value="source">整个来源合并同 ID</option><option value="directory">按文件所在子目录隔离</option></select></label>
      <label class="field">重复文件处理<select :value="modelValue.duplicates" @change="update({duplicates:($event.target as HTMLSelectElement).value as SourceRules['duplicates']})"><option value="all">保留全部</option><option value="page">同类型同页择优</option></select><span>同页动画优先 WebM，其次取最新修改文件；没有页码时不折叠。</span></label>
    </div>
    <h4>1. 媒体分组规则</h4>
    <FileRuleControl :model-value="modelValue.media" label="媒体命名规则" :disabled="disabled || loading" @update:model-value="update({media:$event})" />
    <label class="field">缺失页码的默认值（留空则保留独立文件）<input type="number" min="0" :value="modelValue.media.defaultPage ?? ''" @input="update({media:{...modelValue.media,defaultPage:($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value)}})" /></label>
    <h4>2. 元文件规则（可选）</h4>
    <p class="helper">只从目录/文件名提取元信息时，删除全部元文件规则即可。若有 JSON/TXT 等元文件，用相同 id 关联；只读取匹配到的本组文件。元文件规则优先，请避免过宽的目录规则把媒体本身当成元文件。</p>
    <div v-for="(rule,index) in modelValue.metadata" :key="index" class="metadata-rule-block">
      <div class="rule-row"><strong>元文件规则 {{ index + 1 }}</strong><button type="button" class="button text small" @click="update({metadata:modelValue.metadata.filter((_,i)=>i!==index)})">删除</button></div>
      <FileRuleControl :model-value="rule" :label="`元文件规则 ${index+1}`" :disabled="disabled || loading" @update:model-value="metadataRule(index,$event)" />
    </div>
    <button type="button" class="button text small" :disabled="modelValue.metadata.length >= 16" @click="update({metadata:[...modelValue.metadata,{mode:'template',pattern:'{id}.txt',caseSensitive:false}]})">＋ 添加元文件规则</button>
    <label class="field">媒体类型覆盖<input v-model="overrides" placeholder="webm=animation, mp4=video" @input="changeOverrides" /><span>可选类型：image / video / animation。留空按扩展名识别。</span></label>
    <p v-if="overrideError" class="editor-error" role="alert">{{ overrideError }}</p>
    <h4>3. 元信息提取脚本</h4>
    <p class="helper">脚本每组执行一次，接收下面的 input 对象，返回标题、作者等字段。媒体没有元文件时 files 为空数组，仍可从 media 的路径和 captures 提取元信息。输入 <code>input.</code> 或 <code>input.media[0].</code> 查看字段补全；Ctrl+Space 手动唤起。Tab 缩进，Shift+Tab 反缩进；Esc 后再按 Tab 可移出编辑器。</p>
    <details class="rule-help" open><summary>完整输入结构（所有字段只读）</summary><pre class="input-contract">interface ScriptInput {
  id: string;                   // 规则提取的本组 ID
  directory: string;            // 分组相对目录；全来源合并时为 ""
  media: MediaFile[];            // 本组媒体描述，不含文件内容
  files: MetadataFile[];         // 仅本组匹配到的元文件，可为空
}
interface MediaFile {
  filename: string;              // 如 "0.jpg"
  relativePath: string;          // 如 "画师A/123_夏日/0.jpg"，统一 / 分隔
  directory: string;             // 如 "画师A/123_夏日"；根目录文件为 ""
  directoryName: string;         // 如 "123_夏日"；根目录文件为 ""
  extension: string;             // 如 "jpg"，小写且不含点
  size: number;                  // 文件字节数
  modified: number;              // 修改时间，Unix 毫秒时间戳
  captures: Record&lt;string, string&gt;; // 命名捕获；未命中的可选字段不存在
  page?: number;                 // 页码，已转为非负安全整数
  sequence?: number;             // 收藏序号，已转为非负安全整数
}
interface MetadataFile extends MediaFile {
  text: string;                  // 解码后的元文件全文
}</pre><p>没有绝对路径、媒体内容或文件访问接口。可以直接用 <code>input.media[0].relativePath.split('/')</code> 解析目录，不必额外设置元文件规则。同组不同文件的 captures 可能不同，脚本自行选择或合并。</p></details>
    <SourceCodeEditor :model-value="modelValue.script" language="javascript" label="元信息提取脚本" :media-rule="modelValue.media" :metadata-rules="modelValue.metadata" :disabled="disabled || loading" :issues="jsIssues" @update:model-value="update({script:$event})" />
    <p v-for="(issue,index) in jsIssues" :key="index" class="editor-error" role="alert">{{ issueLocation(modelValue.script,issue) }}</p>
    <details class="rule-help"><summary>脚本输入、输出和安全限制</summary>
      <p>入口：<code>export async function extract(input)</code>。返回对象可包含 <code>title, author, description, date, originalUrl</code> 字符串和 <code>tags: string[]</code>，全部可选。date 必须是有效日期，originalUrl 仅接受 HTTP(S)。编辑器只做语法检查，运行错误需在分组预览中点击「计算脚本结果」检查。</p>
      <p>输入只读；不提供文件系统、联网、npm 模块或定时器。每组执行预算 1 秒、硬截止 2 秒、内存 64 MiB。最多 64 个元文件、单个 2 MiB、总计 8 MiB。文件名/目录字段不增加任何读取权限。</p>
    </details>
    <button type="button" class="button outlined" :disabled="!folder || loading || invalid" @click="test">{{loading ? '正在安全预览…' : '用真实文件预览'}}</button>
    <p class="helper">最多枚举 5,000 个文件、显示 20 组。预览只分组和展示捕获字段，不读取元文件内容、不运行脚本。展开分组后点击按钮，才计算该组结果。预览不保存配置或索引。</p>
  </fieldset>
  <p v-if="error" class="inline-error" role="alert">{{error}}</p>
  <section v-if="preview" class="source-preview" aria-label="分组预览">
    <p>已枚举 {{preview.enumerated}} 个文件，展示 {{preview.groups.length}} 组{{preview.truncated ? '（截断样本）' : ''}}</p>
    <p v-if="!preview.groups.length">没有匹配的媒体分组：请对照上方匹配对象与完整路径示例。</p>
    <p v-for="message in preview.errors" :key="message" class="editor-error">{{message}}</p>
    <details v-for="(group,index) in preview.groups" :key="`${group.directory}/${group.id}`" :open="index===0">
      <summary>{{group.directory ? `${group.directory} / ` : ''}}{{group.id}} · {{group.media.length}} 个媒体 / {{group.metadata.length}} 个元文件</summary>
      <div><strong>媒体</strong><pre>{{group.media.join('\n')}}</pre><strong>元文件</strong><pre>{{group.metadata.join('\n') || '无（仅使用文件/目录字段）'}}</pre><strong>逐文件捕获字段</strong><pre>{{JSON.stringify(group.captures,null,2)}}</pre><strong>脚本结果</strong><button type="button" class="button tonal small" :disabled="disabled || calculating !== null" @click="calculate(index)">{{calculating===index ? '正在计算…' : group.result || group.error ? '重新计算脚本结果' : '计算脚本结果'}}</button><p v-if="group.error" class="editor-error" role="alert">{{group.error}}</p><pre v-else-if="group.result">{{JSON.stringify(group.result,null,2)}}</pre><p v-else>尚未计算。点击上方按钮仅执行这一组脚本。</p></div>
    </details>
  </section>
</template>
