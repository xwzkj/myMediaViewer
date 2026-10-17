<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import type { SourceRules, SourceAiResult, SourceAiStreamEvent, SourceAiToolCall, SourceAiDirectoryRead, SourceAiPreviewSummary, SourceAiQuestion, SourceAiSample, SourcePreview } from '../../shared/types'
import { isBlankSourceRules } from '../../shared/source-presets'
import { AI_THINKING_OPTIONS, asAiThinkingLevel, aiThinkingLabel, type AiThinkingLevel } from '../../shared/ai-thinking'
import { toon } from '../../shared/toon'
import { api } from '../api'
import Icon from './Icon.vue'
import AppSelect from './AppSelect.vue'
import MarkdownText from './MarkdownText.vue'

const props = defineProps<{ folder: string; rules: SourceRules; disabled?: boolean }>()
const emit = defineEmits<{ apply: [SourceRules]; busy: [boolean] }>()

// 一轮 = 用户消息 + 后续的助手文本/思维链/工具行/提问 + 这一轮自己的结果卡片，互不影响。
interface Turn {
  role: 'user' | 'assistant' | 'tool' | 'question'
  text: string
  /** 模型原始流式文本，用于剔除直接吐出来的 JSON。 */
  raw?: string
  /** 已经跟过工具调用的段落不再续写，下一段模型文本另起一条。 */
  sealed?: boolean
  /** 思维链：边流边显示，答案开始后自动折叠。 */
  reasoning?: string
  reasoningOpen?: boolean
  /** 用户手动开合过思维链后不再自动折叠。 */
  reasoningTouched?: boolean
  /** 思维链自己那根滚动条的跟随状态：和外层一样，往上滚就停。 */
  reasoningAuto?: boolean
  reasoningOverflow?: boolean
  tool?: SourceAiToolCall
  result?: SourceAiResult
  applied?: boolean
  applyNote?: string
  preview?: SourcePreview
  previewError?: string
  previewLoading?: boolean
  /** ask_user 抛出的问题与用户的回答。 */
  question?: SourceAiQuestion
  answer?: string
  answering?: boolean
  answerError?: string
  manual?: string
}

const THINKING_KEY = 'myMediaViewer:source-ai-thinking'
const thinkingLevel = ref<AiThinkingLevel>(asAiThinkingLevel(readThinking()))
watch(thinkingLevel, level => { try { localStorage.setItem(THINKING_KEY, level) } catch { /* 隐私模式下写入失败无所谓 */ } })

function readThinking(): string | null {
  try { return localStorage.getItem(THINKING_KEY) } catch { return null }
}

const conversationId = ref('')
const message = ref('')
// 「不使用自定义参数」默认勾选：直接跳过 settings.params，让模型用自身默认行为。
const ignoreCustomParams = ref(true)
const loading = ref(false)
const error = ref('')
const turns = ref<Turn[]>([])
const composer = ref<HTMLTextAreaElement | null>(null)
const timeline = ref<HTMLElement | null>(null)
const lastRequest = ref('')
const streamStatus = ref('')
const autoScroll = ref(true)
const overflowing = ref(false)
// 首轮带上目录树样本，模型就不用先花一次 read_directory 往返。样本 5 分钟过期，用前按时间戳续期。
const sampleToken = ref('')
const sampleAt = ref(0)
const sendsConfig = computed(() => !isBlankSourceRules(props.rules))
const canSend = computed(() => Boolean(props.folder && !loading.value && !props.disabled))
const isFirstTurn = computed(() => turns.value.length === 0)
const showScrollButton = computed(() => !autoScroll.value && overflowing.value)
const thinkingOptions = AI_THINKING_OPTIONS.map(option => ({ value: option.value, label: option.label }))
let revision = 0
let abortController: AbortController | null = null
let previewChain: Promise<void> = Promise.resolve()
let scrolling = false

function forget() {
  if (conversationId.value) void api(`/sources/ai/chat/${encodeURIComponent(conversationId.value)}`, { method: 'DELETE' }).catch(() => {})
}

function reset() {
  abortController?.abort()
  abortController = null
  forget()
  revision++
  conversationId.value = ''
  turns.value = []
  error.value = ''
  lastRequest.value = ''
  streamStatus.value = ''
  autoScroll.value = true
  overflowing.value = false
  sampleToken.value = ''
  sampleAt.value = 0
}

watch(() => props.folder, reset)
onBeforeUnmount(() => {
  abortController?.abort()
  revision++
  forget()
})

function cancel() {
  if (!loading.value) return
  revision++
  abortController?.abort()
  abortController = null
  loading.value = false
  error.value = '已取消本轮任务。可以修改要求后继续。'
  emit('busy', false)
}

// ——— 自动滚动：跟到底部；用户往上滚就停下并显示回到底部的箭头 ———
function scrollToEnd() {
  const element = timeline.value
  if (!element) return
  scrolling = true
  element.scrollTop = element.scrollHeight
  measureOverflow()
  requestAnimationFrame(() => { scrolling = false; syncAutoScroll() })
}
function measureOverflow() {
  const element = timeline.value
  if (element) overflowing.value = element.scrollHeight - element.clientHeight > 24
}
function syncAutoScroll() {
  const element = timeline.value
  if (!element) return
  measureOverflow()
  // 程序滚动和用户滚动都走这里：只要回到接近底部就恢复自动滚动。
  autoScroll.value = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
}
function queueScroll(force = false) {
  if (force) autoScroll.value = true
  else if (!autoScroll.value) return
  void nextTick(() => { scrollToEnd(); measureOverflow() })
}
function onTimelineScroll() {
  if (scrolling) return
  syncAutoScroll()
}
function onTimelineWheel(event: WheelEvent) {
  // 鼠标往上滚就是打断自动滚动。
  if (event.deltaY < 0) autoScroll.value = false
}
function resumeAutoScroll() {
  autoScroll.value = true
  void nextTick(scrollToEnd)
}

// ——— 思维链内层滚动条：同一套逻辑，只是状态挂在这条消息自己身上 ———
const reasoningEls = new WeakMap<Turn, HTMLElement>()
const reasoningProgrammatic = new WeakSet<Turn>()

function registerReasoning(turn: Turn, element: unknown) {
  if (element instanceof HTMLElement) {
    reasoningEls.set(turn, element)
    void nextTick(() => measureReasoning(turn))
  } else {
    reasoningEls.delete(turn)
  }
}

function measureReasoning(turn: Turn) {
  const element = reasoningEls.get(turn)
  if (!element) return
  turn.reasoningOverflow = element.scrollHeight - element.clientHeight > 24
  // 程序滚动和用户滚动都走这里：只要回到接近底部就恢复自动滚动。
  turn.reasoningAuto = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
}

function queueReasoningScroll(turn: Turn, force = false) {
  if (force) turn.reasoningAuto = true
  else if (turn.reasoningAuto === false) return
  void nextTick(() => {
    const element = reasoningEls.get(turn)
    if (!element) return
    reasoningProgrammatic.add(turn)
    element.scrollTop = element.scrollHeight
    requestAnimationFrame(() => { reasoningProgrammatic.delete(turn); measureReasoning(turn) })
  })
}

function onReasoningScroll(turn: Turn) {
  if (reasoningProgrammatic.has(turn)) return
  measureReasoning(turn)
}

function onReasoningWheel(turn: Turn, event: WheelEvent) {
  const element = reasoningEls.get(turn)
  // 内层还能滚就自己处理，不要把外层的自动滚动也一起打断；滚到顶后自然链到外层。
  if (element && element.scrollHeight - element.clientHeight > 1) event.stopPropagation()
  // 鼠标往上滚就是打断自动滚动。
  if (event.deltaY < 0) turn.reasoningAuto = false
}

function resumeReasoning(turn: Turn) {
  queueReasoningScroll(turn, true)
}

/** 现在成果走提交工具、正文照常写人话；这里只兜住仍把 JSON 直接吐进正文的模型。 */
function visibleAssistantText(raw: string): string {
  const json = raw.indexOf('{"')
  return (json >= 0 ? raw.slice(0, json) : raw).trim()
}

/** 生成完成后自动用真实文件预览一次，结果挂在这一轮自己的卡片上。 */
function runPreview(turn: Turn) {
  const result = turn.result
  if (!result) return
  turn.previewLoading = true
  turn.previewError = ''
  const rules = JSON.parse(JSON.stringify(result.rules)) as SourceRules
  previewChain = previewChain.then(async () => {
    try {
      turn.preview = await api<SourcePreview>('/sources/preview', {
        method: 'POST',
        body: JSON.stringify({ name: '预览', path: props.folder, rules }),
      })
    } catch (e) {
      turn.previewError = (e as Error).message
    } finally {
      turn.previewLoading = false
      queueScroll()
    }
  })
}

function retryPreview(turn: Turn) {
  if (turn.previewLoading) return
  runPreview(turn)
}

async function send() {
  if (!canSend.value) return
  const request = message.value
  const version = revision
  lastRequest.value = request
  loading.value = true
  error.value = ''
  streamStatus.value = '连接 AI…'
  emit('busy', true)
  const start = turns.value.length
  turns.value.push({ role: 'user', text: request || '（空消息：让 AI 自主探索目录）' })
  message.value = ''
  queueScroll(true)
  abortController = new AbortController()

  const assistantTurn = (): Turn => {
    for (let index = turns.value.length - 1; index >= start; index--) {
      const turn = turns.value[index]
      if (turn.role === 'assistant' && !turn.result && !turn.sealed) return turn
    }
    const created: Turn = { role: 'assistant', text: '' }
    turns.value.push(created)
    return created
  }
  const addDelta = (text: string) => {
    const turn = assistantTurn()
    turn.raw = (turn.raw || '') + text
    turn.text = visibleAssistantText(turn.raw)
    // 正文开始了，思维链自动收起，别一直占着屏幕。
    if (turn.reasoning && !turn.reasoningTouched) turn.reasoningOpen = false
    queueScroll()
  }
  const addReasoning = (text: string) => {
    const turn = assistantTurn()
    turn.reasoning = (turn.reasoning || '') + text
    if (!turn.reasoningTouched) turn.reasoningOpen = true
    queueScroll()
    queueReasoningScroll(turn)
  }
  const sealAssistantTurn = () => {
    for (let index = turns.value.length - 1; index >= start; index--) {
      const turn = turns.value[index]
      if (turn.role === 'assistant' && !turn.result && !turn.sealed) {
        turn.sealed = true
        if (turn.reasoning && !turn.reasoningTouched) turn.reasoningOpen = false
        break
      }
    }
  }
  const startToolCall = (call?: SourceAiToolCall) => {
    if (!call) return
    sealAssistantTurn()
    // 提问单独成卡：它需要用户操作，不该混在工具行里。
    turns.value.push({ role: call.name === 'ask_user' ? 'question' : 'tool', text: '', tool: { ...call, status: 'running' } })
    queueScroll()
  }
  const askQuestion = (question?: SourceAiQuestion) => {
    if (!question) return
    for (let index = turns.value.length - 1; index >= start; index--) {
      const turn = turns.value[index]
      if (turn.role === 'question' && !turn.question) {
        turn.question = question
        queueScroll(true)
        return
      }
    }
    turns.value.push({ role: 'question', text: '', question, tool: { id: question.id, name: 'ask_user', arguments: {}, status: 'running' } })
    queueScroll(true)
  }
  const finishToolCall = (call?: SourceAiToolCall) => {
    if (!call) return
    for (let index = turns.value.length - 1; index >= start; index--) {
      const turn = turns.value[index]
      const current = turn.tool
      if ((turn.role !== 'tool' && turn.role !== 'question') || !current || current.status !== 'running') continue
      if ((current.id && call.id && current.id === call.id) || current.name === call.name) {
        turn.tool = { ...call }
        // 回答同时回填到提问卡片上，用户能立刻看到自己选了什么。
        if (turn.role === 'question') turn.answer = String((call.result as { answer?: string })?.answer ?? turn.answer ?? '')
        queueScroll()
        return
      }
    }
    turns.value.push({ role: 'tool', text: '', tool: { ...call } })
    queueScroll()
  }
  const finishResult = (result: SourceAiResult) => {
    conversationId.value = result.conversationId
    const turn = assistantTurn()
    turn.result = result
    turn.raw = undefined
    if (turn.reasoning && !turn.reasoningTouched) turn.reasoningOpen = false
    if (!turn.text.trim()) turn.text = result.explanation || '已生成完整规则与脚本。'
    queueScroll()
    runPreview(turn)
  }

  const sample = conversationId.value ? '' : await ensureSample()
  try {
    const response = await fetch('/api/sources/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        path: props.folder,
        conversationId: conversationId.value || undefined,
        message: request,
        ignoreCustomParams: ignoreCustomParams.value,
        thinkingLevel: thinkingLevel.value,
        ...(sample ? { sampleToken: sample } : {}),
        ...(sendsConfig.value ? { currentRules: props.rules } : {}),
      }),
      signal: abortController.signal,
    })
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || `请求失败（${response.status}）`) }
    if (!response.body) throw new Error('服务端没有返回流')
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
    const consume = (raw: string) => {
      if (!raw.trim() || version !== revision) return
      const event = JSON.parse(raw) as SourceAiStreamEvent
      if (event.type === 'status') streamStatus.value = event.message || ''
      else if (event.type === 'reasoning_delta') addReasoning(event.text || '')
      else if (event.type === 'assistant_delta') addDelta(event.text || '')
      else if (event.type === 'tool_call') startToolCall(event.call)
      else if (event.type === 'tool_result') finishToolCall(event.call)
      else if (event.type === 'question') askQuestion(event.question)
      else if (event.type === 'result') finishResult(event.result)
      else if (event.type === 'error') throw new Error(event.message)
    }
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      const chunks = buffer.split(/\r?\n\r?\n/)
      buffer = chunks.pop() || ''
      for (const chunk of chunks) {
        const data = chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
        if (data) consume(data)
      }
    }
    if (buffer) {
      const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
      if (data) consume(data)
    }
    const result = turns.value.slice(start).find(turn => turn.result)?.result
    if (!result) throw new Error('流式响应未返回规则结果')
    if (version !== revision) {
      void api(`/sources/ai/chat/${encodeURIComponent(result.conversationId)}`, { method: 'DELETE' }).catch(() => {})
      return
    }
    if (turns.value.length > 48) turns.value.splice(0, turns.value.length - 48)
  } catch (e) {
    if (version === revision && (e as Error).name !== 'AbortError') {
      error.value = (e as Error).message
      message.value = request
    }
  } finally {
    if (version === revision) {
      abortController = null
      loading.value = false
      streamStatus.value = ''
      emit('busy', false)
      queueScroll()
    }
  }
}

function retry() {
  if (lastRequest.value) message.value = lastRequest.value
  error.value = ''
  nextTick(() => composer.value?.focus())
}

function continueEditing() {
  message.value = '请基于刚才的结果继续修改：'
  nextTick(() => {
    composer.value?.focus()
    composer.value?.setSelectionRange(message.value.length, message.value.length)
  })
}

function apply(turn: Turn) {
  if (!turn.result || turn.applied || props.disabled) return
  emit('apply', JSON.parse(JSON.stringify(turn.result.rules)))
  turn.applied = true
  turn.applyNote = '已应用到编辑器；尚未保存。请先用真实文件预览确认，再保存规则。'
}

function handleMessageKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
  if (event.shiftKey) return
  if (!canSend.value) return
  event.preventDefault()
  void send()
}

function toolTitle(call?: SourceAiToolCall) {
  if (!call) return '工具调用'
  if (call.name === 'read_directory') return `读取目录 ${String(call.arguments?.path ?? '.')}`
  if (call.name === 'preview_rules') return '试跑规则自检'
  if (call.name === 'ask_user') return '询问用户'
  if (call.name === 'submit_rules') return '提交规则'
  return call.name || '工具调用'
}

/** 折叠状态也显示模型这次调用的目的。 */
function toolReason(call?: SourceAiToolCall) {
  const reason = call?.reason || (typeof call?.arguments?.reason === 'string' ? call.arguments.reason : '')
  return String(reason || '').trim()
}

function toolDetail(call?: SourceAiToolCall) {
  if (!call) return ''
  if (call.status === 'error') return call.error || '调用失败'
  if (call.name === 'read_directory') {
    const read = call.result as SourceAiDirectoryRead | undefined
    if (call.status === 'running' || !read) return `offset ${String(call.arguments?.offset ?? 0)} · ${String(call.arguments?.length ?? '')} 项`
    return `${read.entries.length}/${read.total} 项${read.hasMore ? ' · 还有下一页' : ''}`
  }
  if (call.name === 'preview_rules') {
    const summary = call.result as SourceAiPreviewSummary | undefined
    if (call.status === 'running' || !summary) return '正在真实目录上试跑…'
    return `命中 ${summary.matched} 个媒体 · 分成 ${summary.groupCount} 组`
  }
  return ''
}

function toolStatus(call?: SourceAiToolCall) {
  if (!call) return ''
  return call.status === 'error' ? '失败' : call.status === 'running' ? '进行中' : '完成'
}

/** 展开后的输入：模型实际传进来的参数（TOON，和回给模型的数据同一种格式）。 */
function toolInput(call?: SourceAiToolCall) {
  const args = call?.arguments || {}
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null)
  return entries.length ? toon(args) : '（没有参数）'
}

/** 展开后的输出：原样显示真正回给模型的文本。 */
function toolOutput(call?: SourceAiToolCall) {
  if (!call) return ''
  if (call.text) return call.text
  if (call.status === 'error') return call.error || '调用失败'
  return call.result === undefined ? '（等待返回…）' : toon(call.result)
}

function onReasoningToggle(turn: Turn, event: Event) {
  const open = (event.target as HTMLDetailsElement).open
  // 程序自己改 open 也会触发 toggle（自动展开/收起），只有和记录不一致时才算用户手动操作。
  if (open === Boolean(turn.reasoningOpen)) return
  turn.reasoningTouched = true
  turn.reasoningOpen = open
}

/** 首轮向服务端要一份目录树样本；5 分钟过期，快过期时重新取。 */
async function ensureSample(): Promise<string> {
  if (sampleToken.value && Date.now() - sampleAt.value < 4 * 60_000) return sampleToken.value
  try {
    const sample = await api<SourceAiSample>('/sources/ai/sample', { method: 'POST', body: JSON.stringify({ path: props.folder }) })
    sampleToken.value = sample.token
    sampleAt.value = Date.now()
    return sample.token
  } catch {
    // 取不到样本不影响本轮：模型会自己用 read_directory 读。
    return ''
  }
}

/** 把用户的回答送回挂起的提问，模型那边会接着跑。 */
async function answerQuestion(turn: Turn, value: string) {
  const id = turn.question?.id
  const answer = value.trim()
  if (!id || !answer || turn.answer || turn.answering) return
  turn.answering = true
  turn.answerError = ''
  try {
    await api('/sources/ai/chat/answer', { method: 'POST', body: JSON.stringify({ questionId: id, answer }) })
    turn.answer = answer
  } catch (e) {
    turn.answerError = (e as Error).message
  } finally {
    turn.answering = false
  }
}

function previewGroups(preview?: SourcePreview) {
  return (preview?.groups || []).slice(0, 8)
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <section class="source-ai-panel" aria-labelledby="source-ai-title">
    <header class="agent-header">
      <div class="agent-mark"><Icon name="sparkle" :size="19" /></div>
      <div class="agent-heading">
        <div class="agent-title-row"><h3 id="source-ai-title">规则 Agent</h3><span class="agent-badge">SOURCE AI</span></div>
        <p>会按需读取目录名称、试跑规则自检分组，再给出规则与脚本</p>
      </div>
      <span class="agent-thinking">思考 {{ aiThinkingLabel(thinkingLevel) }}</span>
      <button v-if="turns.length" type="button" class="button text small clear-button" :disabled="disabled || loading" @click="reset">新对话</button>
    </header>

    <div v-if="isFirstTurn" class="agent-welcome">
      <p class="welcome-title">从你的目录开始</p>
      <p>留空发送即可让它先自己看一遍目录；也可以直接描述命名规律。它只读取文件和目录名称，用候选规则试跑分组，不读取媒体内容、不执行脚本。生成后会自动用真实文件预览一次。</p>
    </div>

    <div v-if="turns.length || loading" class="timeline-shell">
      <div ref="timeline" class="ai-timeline" role="log" aria-label="规则生成对话" aria-live="polite" @scroll="onTimelineScroll" @wheel="onTimelineWheel">
        <template v-for="(turn, index) in turns" :key="index">
          <article v-if="turn.role === 'user'" class="timeline-item timeline-user">
            <div class="timeline-avatar"><Icon name="edit" :size="14" /></div>
            <div class="timeline-body"><div class="timeline-meta"><strong>你</strong></div><p class="timeline-text">{{ turn.text }}</p></div>
          </article>

          <details v-else-if="turn.role === 'tool'" class="tool-line" :class="`tool-${turn.tool?.status || 'running'}`">
            <summary>
              <Icon :name="turn.tool?.name === 'preview_rules' ? 'eye' : 'folder-open'" :size="14" />
              <span class="tool-title">{{ toolTitle(turn.tool) }}</span>
              <span v-if="toolReason(turn.tool)" class="tool-reason">{{ toolReason(turn.tool) }}</span>
              <span v-if="toolDetail(turn.tool)" class="tool-detail">{{ toolDetail(turn.tool) }}</span>
              <span class="tool-status">{{ toolStatus(turn.tool) }}</span>
              <Icon name="down" :size="13" class="tool-caret" />
            </summary>
            <div class="tool-io">
              <p class="tool-part-title">输入</p>
              <pre>{{ toolInput(turn.tool) }}</pre>
              <p class="tool-part-title">输出</p>
              <pre>{{ toolOutput(turn.tool) }}</pre>
            </div>
          </details>

          <section v-else-if="turn.role === 'question'" class="ask-card" :class="{ answered: turn.answer }">
            <div class="ask-head"><Icon name="help" :size="15" /><strong>需要你确认</strong><span v-if="turn.answering" class="ask-pending">正在提交…</span></div>
            <p class="ask-question">{{ turn.question?.question || '模型想确认一个细节…' }}</p>
            <p v-if="turn.question?.why" class="ask-why">{{ turn.question.why }}</p>
            <div v-if="turn.question && !turn.answer" class="ask-options">
              <button v-for="(option, optionIndex) in turn.question.options" :key="optionIndex" type="button" class="ask-option" :disabled="turn.answering" @click="answerQuestion(turn, option.summary)">
                <span class="ask-option-head"><strong>{{ option.summary }}</strong><span v-if="optionIndex === 0" class="ask-recommend">推荐</span></span>
                <span class="ask-option-desc">{{ option.description }}</span>
              </button>
            </div>
            <div v-if="turn.question && !turn.answer" class="ask-manual">
              <input v-model="turn.manual" type="text" maxlength="2000" placeholder="也可以自己输入答案…" :disabled="turn.answering" @keydown.enter.prevent="answerQuestion(turn, turn.manual || '')" />
              <button type="button" class="button filled small" :disabled="turn.answering || !(turn.manual || '').trim()" @click="answerQuestion(turn, turn.manual || '')">回答</button>
            </div>
            <p v-if="turn.answer" class="ask-answer"><Icon name="check" :size="13" />已回答：{{ turn.answer }}</p>
            <p v-if="turn.answerError" class="editor-error ask-error">{{ turn.answerError }}</p>
          </section>

          <article v-else class="timeline-item timeline-assistant">
            <div class="timeline-avatar"><Icon name="sparkle" :size="14" /></div>
            <div class="timeline-body">
              <div class="timeline-meta"><strong>助手</strong><span v-if="turn.result">{{ turn.result.model }}</span></div>

              <details v-if="turn.reasoning" class="reasoning-block" :open="turn.reasoningOpen" @toggle="onReasoningToggle(turn, $event)">
                <summary>
                  <Icon name="bulb" :size="13" />
                  <span>思考过程</span>
                  <span v-if="loading && index === turns.length - 1" class="reasoning-live">思考中…</span>
                  <span class="reasoning-size">{{ turn.reasoning.length }} 字</span>
                  <Icon name="down" :size="13" class="reasoning-caret" />
                </summary>
                <pre :ref="element => registerReasoning(turn, element)" @scroll="onReasoningScroll(turn)" @wheel="onReasoningWheel(turn, $event)">{{ turn.reasoning }}</pre>
                <button v-if="turn.reasoningOverflow && turn.reasoningAuto === false" type="button" class="reasoning-restore" aria-label="回到思考过程末尾并继续自动滚动" title="回到末尾" @click="resumeReasoning(turn)"><Icon name="arrow-down" :size="13" /></button>
              </details>

              <MarkdownText v-if="turn.text" class="timeline-text" :text="turn.text" />

              <section v-if="turn.result" class="round-result" aria-label="本轮生成结果">
                <div class="result-header">
                  <div class="result-title"><Icon name="folder-open" :size="15" /><div><strong>规则与脚本</strong><span>{{ turn.result.model }}</span></div></div>
                  <button type="button" class="button tonal small" :disabled="disabled || turn.applied" @click="apply(turn)"><Icon name="check" :size="15" />{{ turn.applied ? '已应用' : '应用结果' }}</button>
                </div>

                <p class="result-preview">
                  <Icon name="eye" :size="13" />
                  <template v-if="turn.previewLoading">正在用真实文件预览…</template>
                  <template v-else-if="turn.previewError">自动预览失败：{{ turn.previewError }} <button type="button" class="button text small" :disabled="disabled" @click="retryPreview(turn)">重试预览</button></template>
                  <template v-else-if="turn.preview">已枚举 {{ turn.preview.enumerated }} 个文件 · 分成 {{ turn.preview.groups.length }} 组{{ turn.preview.truncated ? '（截断样本）' : '' }}{{ turn.preview.errors.length ? ` · ${turn.preview.errors.length} 条错误` : '' }}</template>
                  <template v-else>使用真实文件预览可确认分组效果</template>
                </p>
                <p v-if="turn.applyNote" class="result-note">{{ turn.applyNote }}</p>
                <p v-if="turn.result.contextTrimmed" class="result-note">较早轮次已从 AI 上下文中移除，保留近期对话。</p>

                <details v-if="turn.preview?.groups.length" class="result-details round-preview">
                  <summary>查看分组预览（{{ turn.preview.groups.length }} 组）<Icon name="down" :size="14" /></summary>
                  <div class="preview-groups">
                    <div v-for="group in previewGroups(turn.preview)" :key="`${group.directory}/${group.id}`" class="preview-group">
                      <strong>{{ group.directory ? `${group.directory} / ` : '' }}{{ group.id }}</strong>
                      <span>{{ group.media.length }} 个媒体<template v-if="group.metadata.length"> · {{ group.metadata.length }} 个元文件</template></span>
                      <pre>{{ group.media.slice(0, 4).join('\n') }}{{ group.media.length > 4 ? '\n…' : '' }}</pre>
                    </div>
                    <p v-if="turn.preview.groups.length > 8" class="result-note">只显示前 8 组，其余 {{ turn.preview.groups.length - 8 }} 组请用编辑器里的完整预览查看。</p>
                  </div>
                </details>

                <details class="result-details">
                  <summary>查看完整规则与脚本 <Icon name="down" :size="14" /></summary>
                  <pre>{{ json({ ...turn.result.rules, script: undefined }) }}</pre>
                  <pre class="script-preview">{{ turn.result.rules.script }}</pre>
                </details>

                <div class="result-actions"><button type="button" class="button text small" :disabled="disabled" @click="continueEditing">继续修改</button></div>
              </section>
            </div>
          </article>
        </template>

        <article v-if="loading" class="timeline-item timeline-assistant timeline-loading">
          <div class="timeline-avatar"><Icon name="sparkle" :size="14" /></div>
          <div class="timeline-body"><div class="timeline-meta"><strong>助手</strong><span class="streaming-dot"><i /><i /><i /></span></div><p class="timeline-text timeline-pending">{{ streamStatus || '正在读取目录并生成规则…' }}</p></div>
        </article>
      </div>
      <button v-if="showScrollButton" type="button" class="scroll-restore" aria-label="回到底部并继续自动滚动" title="回到底部" @click="resumeAutoScroll"><Icon name="arrow-down" :size="17" /></button>
    </div>

    <p v-if="error" class="editor-error ai-error" role="alert">{{ error }}</p>

    <div class="composer-shell" :class="{ active: loading }">
      <textarea ref="composer" v-model="message" aria-label="AI 规则生成要求" rows="2" maxlength="4000" :disabled="disabled" :placeholder="isFirstTurn ? '描述要如何分组、提取标题和作者…（留空让它自己看目录）' : '继续提要求，例如：页码从 1 开始，作者取目录名…'" @keydown="handleMessageKeydown" />
      <div class="composer-footer">
        <div class="composer-options">
          <div class="thinking-select" :title="`思考深度：${aiThinkingLabel(thinkingLevel)}`"><AppSelect compact :model-value="thinkingLevel" label="思考深度" :disabled="disabled" :options="thinkingOptions" @update:model-value="thinkingLevel = $event" /></div>
          <label class="composer-option"><input v-model="ignoreCustomParams" type="checkbox" :disabled="disabled" />不使用自定义参数</label>
        </div>
        <span class="composer-hint">Enter 发送 · Shift + Enter 换行</span>
        <button v-if="loading" type="button" class="button outlined small" @click="cancel"><Icon name="pause" :size="15" />取消</button>
        <button v-else type="button" class="button filled small send-button" :disabled="!canSend" @click="send"><Icon name="arrow-right" :size="16" />{{ conversationId ? '继续' : '启动任务' }}</button>
      </div>
    </div>

    <div v-if="error" class="composer-recovery"><button type="button" class="button text small" :disabled="disabled" @click="retry">重试上一条</button></div>
  </section>
</template>

<style scoped>
.source-ai-panel{min-width:0;margin:16px 0 20px;padding:0;border:1px solid var(--outline);border-radius:16px;background:var(--surface);font-size:12px;line-height:1.65;overflow:hidden}
.agent-header{display:flex;align-items:center;gap:11px;padding:15px 16px;border-bottom:1px solid var(--outline);background:var(--surface-low)}
.agent-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--primary-container);color:var(--on-container);flex-shrink:0}.agent-heading{min-width:0;flex:1}.agent-title-row{display:flex;align-items:center;gap:7px}.agent-title-row h3{font-size:13px;font-weight:650}.agent-badge{font-size:8px;letter-spacing:1px;color:var(--primary);font-weight:700}.agent-heading p{margin:2px 0 0;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-thinking{flex-shrink:0;font-size:10px;color:var(--muted);background:var(--surface-high);border-radius:20px;padding:4px 9px}.clear-button{flex-shrink:0}
.agent-welcome{margin:18px 18px 10px;padding:14px 15px;border-radius:11px;background:var(--surface-low);color:var(--muted)}.agent-welcome p{margin:0}.agent-welcome .welcome-title{color:var(--text);font-size:12px;font-weight:650;margin-bottom:4px}
.timeline-shell{position:relative}
.ai-timeline{max-height:440px;overflow:auto;padding:16px 18px 6px;overscroll-behavior:contain}
.timeline-item{display:flex;gap:9px;margin:0 0 14px;min-width:0}.timeline-avatar{width:25px;height:25px;display:grid;place-items:center;flex-shrink:0;border-radius:8px;background:var(--surface-high);color:var(--muted)}.timeline-user .timeline-avatar{background:var(--primary-container);color:var(--on-container)}.timeline-assistant .timeline-avatar{background:var(--primary);color:var(--on-primary)}.timeline-body{min-width:0;flex:1}.timeline-meta{display:flex;align-items:center;gap:8px;min-height:25px;font-size:10px;color:var(--muted)}.timeline-meta strong{color:var(--text);font-size:11px}.timeline-text{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}.timeline-pending{color:var(--muted)}
.scroll-restore{position:absolute;right:16px;bottom:12px;z-index:2;width:32px;height:32px;display:grid;place-items:center;border-radius:50%;border:1px solid var(--outline);background:var(--card);color:var(--primary);box-shadow:0 4px 14px #0002;transition:transform .16s}.scroll-restore:hover{transform:translateY(-2px)}
.tool-line{margin:0 0 8px 34px;border:1px solid var(--outline);border-radius:8px;background:var(--surface-low);overflow:hidden}
.tool-line summary{display:flex;align-items:center;gap:6px;padding:5px 9px;cursor:pointer;list-style:none;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden}
.tool-line summary::-webkit-details-marker{display:none}
.tool-line .tool-title{color:var(--text);flex-shrink:0}.tool-line .tool-reason{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text);opacity:.72}.tool-line .tool-detail{flex-shrink:0;overflow:hidden;text-overflow:ellipsis}.tool-line .tool-status{margin-left:auto;flex-shrink:0;font-size:10px}.tool-line .tool-caret{flex-shrink:0;transition:transform .16s}.tool-line[open] .tool-caret{transform:rotate(180deg)}
.tool-io{border-top:1px solid var(--outline);padding:8px 9px 9px}
.tool-complete .tool-status{color:var(--primary)}.tool-error .tool-status{color:var(--danger)}
.tool-part-title{margin:0 0 4px;font-size:10px;color:var(--muted);letter-spacing:.4px}
.tool-io pre{margin:0 0 8px;padding:7px 8px;border-radius:7px;background:var(--surface-high);max-height:170px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.65 Consolas,monospace;color:var(--text)}
.tool-io pre:last-child{margin-bottom:0}
.reasoning-block{position:relative;margin:2px 0 8px;border:1px dashed var(--outline);border-radius:9px;background:color-mix(in srgb,var(--surface-low) 70%,transparent);overflow:hidden}
.reasoning-block summary{display:flex;align-items:center;gap:6px;padding:5px 9px;cursor:pointer;list-style:none;font-size:10px;color:var(--muted)}
.reasoning-block summary::-webkit-details-marker{display:none}
.reasoning-block .reasoning-live{color:var(--primary);animation:blink 1.4s infinite}
.reasoning-block .reasoning-size{margin-left:auto}.reasoning-block .reasoning-caret{transition:transform .16s}
.reasoning-block[open] .reasoning-caret{transform:rotate(180deg)}
.reasoning-block pre{margin:0;padding:0 9px 8px;max-height:190px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:10.5px/1.7 Consolas,monospace;color:var(--muted)}
.reasoning-restore{position:absolute;right:7px;bottom:7px;width:24px;height:24px;display:grid;place-items:center;border-radius:50%;border:1px solid var(--outline);background:var(--card);color:var(--primary);box-shadow:0 3px 10px #0002;transition:transform .15s}
.reasoning-restore:hover{transform:translateY(-1px)}
.ask-card{margin:0 0 12px 34px;border:1px solid var(--primary);border-radius:12px;background:var(--card);padding:10px 12px}
.ask-card.answered{border-color:var(--outline);background:var(--surface-low)}
.ask-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--primary)}.ask-card.answered .ask-head{color:var(--muted)}.ask-pending{margin-left:auto;color:var(--muted);font-size:10px}
.ask-question{margin:6px 0 0;font-size:12px;font-weight:600;color:var(--text)}
.ask-why{margin:3px 0 0;font-size:10px;color:var(--muted)}
.ask-options{display:grid;gap:6px;margin-top:9px}
.ask-option{display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;cursor:pointer;border:1px solid var(--outline);border-radius:9px;background:var(--surface);padding:7px 9px;font:inherit;color:var(--text);transition:border-color .15s,background .15s}
.ask-option:hover:not(:disabled){border-color:var(--primary);background:var(--primary-container)}
.ask-option:disabled{cursor:default;opacity:.6}
.ask-option-head{display:flex;align-items:center;gap:6px;font-size:11.5px}
.ask-recommend{font-size:9px;color:var(--on-container);background:var(--primary-container);border-radius:20px;padding:1px 6px}
.ask-option-desc{font-size:10px;color:var(--muted);line-height:1.5}
.ask-manual{display:flex;gap:6px;margin-top:8px}
.ask-manual input{flex:1;min-width:0;border:1px solid var(--outline);border-radius:8px;background:var(--surface);padding:6px 9px;font:inherit;font-size:11px;color:var(--text)}
.ask-manual input:focus-visible{outline:2px solid var(--primary);outline-offset:-1px}
.ask-answer{display:flex;align-items:center;gap:5px;margin:8px 0 0;font-size:11px;color:var(--primary)}
.ask-error{margin:6px 0 0}
.round-result{margin:9px 0 0;border:1px solid var(--primary);border-radius:12px;background:var(--primary-container);color:var(--on-container);padding:10px 11px}
.result-header{display:flex;align-items:center;justify-content:space-between;gap:10px}.result-title{display:flex;align-items:center;gap:8px;min-width:0}.result-title>div{display:flex;flex-direction:column;min-width:0}.result-title strong{font-size:12px}.result-title span{font-size:9px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.result-preview{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:9px 0 0;font-size:10px;opacity:.85}
.result-note{margin:6px 0 0;font-size:10px;opacity:.75}
.result-details{margin-top:9px;border-top:1px solid color-mix(in srgb,var(--primary) 28%,transparent);padding-top:7px}.result-details summary{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px}.result-details summary .icon{margin-left:auto}
.preview-groups{margin-top:8px;display:grid;gap:7px;max-height:210px;overflow:auto}
.preview-group{background:color-mix(in srgb,var(--surface) 58%,transparent);border-radius:8px;padding:7px 9px}.preview-group strong{display:block;font-size:11px}.preview-group span{font-size:9px;opacity:.7}
.result-actions{display:flex;justify-content:flex-end;margin-top:8px}
.source-ai-panel pre{margin:0;max-height:190px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:color-mix(in srgb,var(--surface) 58%,transparent);padding:9px;border-radius:7px;color:var(--text);font:11px/1.6 Consolas,monospace}
.result-details pre{margin-top:8px}
.timeline-loading{margin-bottom:10px}.streaming-dot{display:inline-flex;gap:3px}.streaming-dot i{width:4px;height:4px;border-radius:50%;background:var(--primary);animation:blink 1.2s infinite}.streaming-dot i:nth-child(2){animation-delay:.18s}.streaming-dot i:nth-child(3){animation-delay:.36s}@keyframes blink{0%,60%,100%{opacity:.25}30%{opacity:1}}
.ai-error{margin:2px 18px 8px}
.composer-shell{margin:10px 14px 14px;border:1px solid var(--outline);border-radius:12px;background:var(--surface-low);transition:border-color .18s,box-shadow .18s}
.composer-shell.active{border-color:var(--primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--primary) 11%,transparent)}
.composer-shell textarea{display:block;width:100%;box-sizing:border-box;resize:vertical;min-height:52px;padding:11px 12px 5px;border:0;background:transparent;color:var(--text);font-size:12px;line-height:1.6}
/* 输入框和外壳都不做焦点高亮：这里显式压掉 .source-rule-editor 的通用 focus 样式。 */
.composer-shell textarea:focus,.composer-shell textarea:focus-visible{outline:none;box-shadow:none;border:0;border-color:transparent}
.composer-shell textarea::placeholder{color:var(--muted)}
.composer-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 8px 8px}
.composer-options{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-right:auto;min-width:0}
.thinking-select{width:104px;flex-shrink:0}
.composer-option{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:10px;white-space:nowrap}.composer-option input{accent-color:var(--primary)}
.composer-hint{font-size:9px;color:var(--muted);opacity:.8}.send-button{min-width:88px}.composer-recovery{margin:-9px 16px 8px;text-align:right}
@media(max-width:600px){.agent-header{padding:13px}.agent-thinking{display:none}.ai-timeline{padding-inline:13px}.agent-welcome{margin-inline:13px}.composer-shell{margin-inline:10px}.composer-hint{display:none}.tool-line{margin-left:0}}
</style>
