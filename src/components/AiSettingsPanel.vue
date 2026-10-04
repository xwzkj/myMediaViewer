<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AiConnectionResult, AiSettings } from '../../shared/types'
import { DEFAULT_APPEND_PROMPT } from '../../shared/prompts'
import Icon from './Icon.vue'
import { api } from '../api'

const emit = defineEmits<{ notice: [message: string] }>()

const settings = ref<AiSettings | null>(null)
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const loadingModels = ref(false)
const models = ref<string[]>([])
const modelsOpen = ref(false)
const error = ref('')
const testResult = ref<AiConnectionResult | null>(null)
const paramsText = ref('{}')
const showKey = ref(false)
// 界面展示与编辑使用“秒”，保存与请求时换算为毫秒
const timeoutSeconds = ref(120)
const pipelineMode = ref<AiSettings['mangaPipelineMode']>('streaming')
const concurrency = ref(3)

const paramsExample = '{\n  "reasoning_effort": "low",\n  "thinking": { "type": "disabled" },\n  "thinking_budget": 1024,\n  "temperature": 0.3\n}'

onMounted(async () => {
  try {
    const data = await api<AiSettings>('/ai/settings')
    apply(data)
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
})

function apply(data: AiSettings) {
  settings.value = data
  paramsText.value = JSON.stringify(data.params || {}, null, 2)
  timeoutSeconds.value = Math.max(5, Math.round((data.timeoutMs || 120000) / 1000))
  pipelineMode.value = data.mangaPipelineMode || 'streaming'
  concurrency.value = Math.min(10, Math.max(1, data.mangaConcurrency || 3))
}

function parseParams(): Record<string, unknown> {
  const text = paramsText.value.trim()
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('需要是 JSON 对象')
  return parsed as Record<string, unknown>
}

// 内置系统提示词不可编辑；用户只能改要追加的那段，按钮用于还原默认追加内容。
function restoreAppendPrompt() {
  if (settings.value) settings.value.appendPrompt = DEFAULT_APPEND_PROMPT
}

function buildPayload() {
  const current = settings.value
  if (!current) throw new Error('设置未加载')
  const params = parseParams()
  const sec = Number(timeoutSeconds.value)
  const timeoutMs = Number.isFinite(sec) ? Math.min(600, Math.max(5, Math.round(sec))) * 1000 : 120000
  return {
    ...current,
    params,
    timeoutMs,
    mangaPipelineMode: pipelineMode.value,
    mangaConcurrency: Math.min(10, Math.max(1, Math.round(Number(concurrency.value) || 3))),
  }
}

async function save() {
  error.value = ''
  let payload: ReturnType<typeof buildPayload>
  try {
    payload = buildPayload()
  } catch (e) {
    error.value = `自定义参数格式有误：${(e as Error).message}`
    return
  }
  saving.value = true; testResult.value = null
  try {
    const next = await api<AiSettings>('/ai/settings', { method: 'PUT', body: JSON.stringify(payload) })
    apply(next)
    emit('notice', 'AI 翻译设置已保存')
  } catch (e) { error.value = (e as Error).message }
  finally { saving.value = false }
}

async function test() {
  error.value = ''; testResult.value = null
  let payload: ReturnType<typeof buildPayload>
  try {
    payload = buildPayload()
  } catch (e) {
    error.value = `自定义参数格式有误：${(e as Error).message}`
    return
  }
  testing.value = true
  try {
    // 携带目前表单中填写的最新内容发起测试，无需先点击保存
    testResult.value = await api<AiConnectionResult>('/ai/test', { method: 'POST', body: JSON.stringify(payload) })
    emit('notice', '模型响应正常')
  } catch (e) { error.value = (e as Error).message }
  finally { testing.value = false }
}

async function loadModels() {
  error.value = ''; modelsOpen.value = true
  let payload: ReturnType<typeof buildPayload>
  try {
    payload = buildPayload()
  } catch (e) {
    error.value = `自定义参数格式有误：${(e as Error).message}`
    return
  }
  loadingModels.value = true
  try {
    // 携带目前表单填写的 baseUrl 和 apiKey 获取模型列表
    const data = await api<{ items: string[] }>('/ai/models', { method: 'POST', body: JSON.stringify(payload) })
    models.value = data.items
    if (!models.value.length) error.value = '接口没有返回可用的模型'
  } catch (e) { error.value = (e as Error).message; models.value = [] }
  finally { loadingModels.value = false }
}

function pickModel(model: string) {
  if (settings.value) settings.value.model = model
  modelsOpen.value = false
}
</script>

<template>
  <section class="settings-section">
    <div class="section-heading"><div><h3>AI 翻译</h3><p>连接 OpenAI 兼容接口，翻译标题、作者、标签、描述与漫画气泡。</p></div><Icon name="sparkle" /></div>
    <p v-if="loading" class="helper"><Icon name="refresh" class="spinning" :size="16" />正在读取设置…</p>
    <form v-else-if="settings" class="ai-form" @submit.prevent="save">
      <label class="field">接口地址<input v-model="settings.baseUrl" required placeholder="https://api.openai.com/v1" spellcheck="false" autocomplete="off" /><span>可填到 /v1 或完整的 /chat/completions 地址。</span></label>
      <label class="field">API Token<div class="key-field"><input v-model="settings.apiKey" :type="showKey ? 'text' : 'password'" placeholder="sk-…" spellcheck="false" autocomplete="off" /><button type="button" class="button text small" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button></div><span>保存在服务端 data/ai.json，不会发送到其他设备。</span></label>
      <div class="field">模型名称<div class="model-field"><input v-model="settings.model" required placeholder="例如 gpt-4o-mini" spellcheck="false" autocomplete="off" /><button type="button" class="button outlined small" :disabled="loadingModels" @click="loadModels"><Icon name="refresh" :class="{ spinning: loadingModels }" :size="17" />{{ loadingModels ? '正在获取…' : '获取模型列表' }}</button></div><div v-if="modelsOpen" class="model-list"><p v-if="loadingModels">正在向接口请求模型列表…</p><template v-else><button v-for="model in models" :key="model" type="button" class="model-option" :class="{ active: model === settings.model }" @click="pickModel(model)">{{ model }}</button><p v-if="!models.length">没有获取到模型，可手动填写名称。</p></template></div></div>
      <label class="field">目标语言<input v-model="settings.targetLanguage" maxlength="40" placeholder="简体中文" /></label>
      <label class="field">自定义参数<textarea v-model="paramsText" rows="6" spellcheck="false" :placeholder="paramsExample" /><span>JSON 对象，会原样合并进请求体。可用来关闭思考、设置思考等级或思考预算，例如 reasoning_effort、thinking、thinking_budget。</span></label>
      <div class="field prompt-field"><div class="prompt-head"><span>追加系统提示词</span><button type="button" class="button text small" @click="restoreAppendPrompt">恢复默认</button></div><textarea v-model="settings.appendPrompt" rows="4" spellcheck="false" placeholder="现在开始工作" /><span>内置翻译提示词不可编辑，这段内容会追加在它之后，中间空两行（标题/标签/描述与漫画翻译都生效）。留空表示不追加。</span></div>
      <label class="field">超时时间（秒）<input v-model.number="timeoutSeconds" type="number" min="5" max="600" step="5" /><span>默认 120 秒，范围 5 - 600 秒。</span></label>
      <div class="field">
        <span>漫画翻译流水线</span>
        <div class="pipeline-options">
          <label class="pipeline-option" :class="{ active: pipelineMode === 'sequential' }">
            <input v-model="pipelineMode" name="manga-pipeline" type="radio" value="sequential" />
            <span class="pipeline-copy">
              <span class="pipeline-name">逐页处理</span>
              <span class="pipeline-desc">一页走完识别与翻译再处理下一页。内存占用最低，适合单页翻译。</span>
            </span>
          </label>
          <label class="pipeline-option" :class="{ active: pipelineMode === 'merged' }">
            <input v-model="pipelineMode" name="manga-pipeline" type="radio" value="merged" />
            <span class="pipeline-copy">
              <span class="pipeline-name">先批量识别，再合并翻译</span>
              <span class="pipeline-desc">整部先做本地检测与 OCR，再把所有文本合并成尽量少的几次请求。请求数最少，但失败会牵连整批。</span>
            </span>
          </label>
          <label class="pipeline-option" :class="{ active: pipelineMode === 'parallel' }">
            <input v-model="pipelineMode" name="manga-pipeline" type="radio" value="parallel" />
            <span class="pipeline-copy">
              <span class="pipeline-name">先批量识别，再并发翻译</span>
              <span class="pipeline-desc">识别阶段同上，之后每页各发一个请求并按并发数同时进行。失败只影响单页。</span>
            </span>
          </label>
          <label class="pipeline-option" :class="{ active: pipelineMode === 'streaming' }">
            <input v-model="pipelineMode" name="manga-pipeline" type="radio" value="streaming" />
            <span class="pipeline-copy">
              <span class="pipeline-name">边识别边并发翻译</span>
              <span class="pipeline-desc">速度最快。每识别完一张就排入翻译队列，同时继续识别下一张。翻译达到并发上限时等待空位，失败只影响单页。</span>
            </span>
          </label>
        </div>
        <label v-if="pipelineMode === 'parallel' || pipelineMode === 'streaming'" class="concurrency-field">并发数<input v-model.number="concurrency" type="number" min="1" max="10" step="1" /><span>同时进行的翻译请求数，1 - 10，默认 3。接口限流时调小。</span></label>
      </div>
      <label class="manga-auto-setting">
        <input v-model="settings.mangaAutoShowTranslated" type="checkbox" />
        <span><strong>自动显示已有译图</strong><small>打开或切换图片时，自动加载当前目标语言的已有译图；没有译图时显示原图。设置保存在服务端，所有设备共用。</small></span>
      </label>
      <div class="ai-actions">
        <button type="button" class="button tonal" :disabled="testing || saving" @click="test"><Icon name="sparkle" :size="18" />{{ testing ? '正在测试…' : '测试连接' }}</button>
        <button class="button filled" :disabled="saving || testing"><Icon name="check" :size="18" />{{ saving ? '正在保存…' : '保存设置' }}</button>
      </div>
      <p v-if="testResult" class="ai-result" role="status"><Icon name="success" :size="17" />模型 {{ testResult.model }} 在 {{ testResult.elapsed }} ms 内回复：{{ testResult.reply || '（空回复）' }}</p>
      <p v-if="error" class="inline-error" role="alert"><Icon name="warning" :size="19" />{{ error }}</p>
    </form>
  </section>
</template>
