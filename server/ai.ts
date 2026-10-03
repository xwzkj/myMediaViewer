import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { dataDir } from './config.js'
import { db } from './database.js'
import type { AiSettings, AiTranslateFields } from '../shared/types.js'
import { DEFAULT_APPEND_PROMPT, DEFAULT_MANGA_PROMPT, DEFAULT_TRANSLATE_PROMPT, fillPrompt } from '../shared/prompts.js'
import { logRaw, logUpstream } from './log.js'

const settingsPath = path.join(dataDir, 'ai.json')

// 调用方（设置页或翻译接口）能用上的错误，带 HTTP 状态码交给统一错误处理。
export class AiError extends Error {
  statusCode: number
  // 标记这些错误信息可以安全地原样返回给前端，便于用户自行排查配置问题。
  expose = true
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode }
}

const defaults: AiSettings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  targetLanguage: '简体中文',
  appendPrompt: DEFAULT_APPEND_PROMPT,
  // 直接合并进请求体的自定义参数，例如关闭思考、思考等级、思考预算、温度等。
  params: { thinking: { type: 'disabled' } },
  timeoutMs: 120000,
  mangaPipelineMode: 'streaming',
  mangaConcurrency: 3,
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

const MIN_TIMEOUT = 5000
const MAX_TIMEOUT = 600000
function clampTimeout(value: unknown, fallback: number): number {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return fallback
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(ms)))
}

function asParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

// 追加提示词的默认值。旧配置的 systemPrompt 是"替换内置提示词"语义，和现在这个字段不是一回事，
// 因此直接忽略：旧值不再生效，用户可在设置页里重新填写。
function asAppendPrompt(raw: Record<string, unknown>): string {
  return typeof raw.appendPrompt === 'string' ? raw.appendPrompt : DEFAULT_APPEND_PROMPT
}

const PIPELINE_MODES = ['sequential', 'merged', 'parallel', 'streaming'] as const
function asPipelineMode(value: unknown, fallback: AiSettings['mangaPipelineMode']): AiSettings['mangaPipelineMode'] {
  return typeof value === 'string' && (PIPELINE_MODES as readonly string[]).includes(value)
    ? value as AiSettings['mangaPipelineMode']
    : fallback
}

const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 10
function clampConcurrency(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n)))
}

function normalize(input: unknown): AiSettings {
  const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  return {
    baseUrl: asText(raw.baseUrl, defaults.baseUrl) || defaults.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    model: asText(raw.model, defaults.model),
    targetLanguage: asText(raw.targetLanguage, defaults.targetLanguage) || defaults.targetLanguage,
    appendPrompt: asAppendPrompt(raw),
    params: 'params' in raw ? asParams(raw.params) : structuredClone(defaults.params),
    timeoutMs: clampTimeout(raw.timeoutMs, defaults.timeoutMs),
    mangaPipelineMode: asPipelineMode(raw.mangaPipelineMode, defaults.mangaPipelineMode),
    mangaConcurrency: clampConcurrency(raw.mangaConcurrency, defaults.mangaConcurrency),
  }
}

function readSettings(): AiSettings {
  if (!existsSync(settingsPath)) return normalize({})
  try {
    return normalize(JSON.parse(readFileSync(settingsPath, 'utf8')))
  } catch {
    // 配置文件损坏时退回默认值，避免整个服务起不来。
    return normalize({})
  }
}

let current = readSettings()

export function getAiSettings(): AiSettings { return { ...current, params: { ...current.params } } }

export function saveAiSettings(input: unknown): AiSettings {
  const next = normalize(input)
  if (!/^https?:\/\//i.test(next.baseUrl)) throw new AiError('接口地址需要以 http:// 或 https:// 开头')
  writeFileSync(`${settingsPath}.tmp`, JSON.stringify(next, null, 2), 'utf8')
  renameSync(`${settingsPath}.tmp`, settingsPath)
  current = next
  return getAiSettings()
}

// 合并「已保存配置」与「本次请求携带的配置」：只有请求里确实带了某字段才覆盖。
// 这样设置页可以直接用还没保存的表单内容去测试连接、拉取模型列表。
export function mergeAiSettings(input: unknown): AiSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return getAiSettings()
  const raw = input as Record<string, unknown>
  const merged: AiSettings = {
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : current.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : current.apiKey,
    model: typeof raw.model === 'string' ? raw.model.trim() : current.model,
    targetLanguage: typeof raw.targetLanguage === 'string' ? raw.targetLanguage.trim() : current.targetLanguage,
    appendPrompt: typeof raw.appendPrompt === 'string' ? raw.appendPrompt : current.appendPrompt,
    params: 'params' in raw ? asParams(raw.params) : { ...current.params },
    timeoutMs: 'timeoutMs' in raw ? clampTimeout(raw.timeoutMs, current.timeoutMs) : current.timeoutMs,
    mangaPipelineMode: 'mangaPipelineMode' in raw
      ? asPipelineMode(raw.mangaPipelineMode, current.mangaPipelineMode)
      : current.mangaPipelineMode,
    mangaConcurrency: 'mangaConcurrency' in raw
      ? clampConcurrency(raw.mangaConcurrency, current.mangaConcurrency)
      : current.mangaConcurrency,
  }
  if (!/^https?:\/\//i.test(merged.baseUrl)) throw new AiError('接口地址需要以 http:// 或 https:// 开头')
  return merged
}

function configured(override?: unknown, needModel = true): AiSettings {
  const settings = override === undefined ? getAiSettings() : mergeAiSettings(override)
  if (!settings.apiKey) throw new AiError('请先填写 API Token')
  if (needModel && !settings.model) throw new AiError('请先填写模型名称')
  return settings
}

// 兼容两种常见写法：填到 /v1，或直接填完整的 /chat/completions 地址。
function endpoints(baseUrl: string): { chat: string; models: string } {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new AiError('接口地址需要以 http:// 或 https:// 开头')
  if (/\/chat\/completions$/i.test(base)) return { chat: base, models: base.replace(/\/chat\/completions$/i, '/models') }
  if (/\/v1$/i.test(base)) return { chat: `${base}/chat/completions`, models: `${base}/models` }
  return { chat: `${base}/v1/chat/completions`, models: `${base}/v1/models` }
}

function headers(settings: AiSettings): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }
}

function describeHttp(status: number, text: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string }
    detail = parsed.error?.message || parsed.message || ''
  } catch { detail = text.slice(0, 300) }
  const hint = status === 401 || status === 403 ? '，请检查 API Token 是否正确、是否有该模型权限'
    : status === 404 ? '，请检查接口地址与模型名称'
    : status === 429 ? '，请求过于频繁或额度不足'
    : ''
  return `接口返回 ${status}${hint}${detail ? `：${detail}` : ''}`
}

/** 所有对外 AI 请求都从这里走，顺带记一条「用途 + 地址 + 状态 + 耗时」的调用日志。 */
async function requestJson(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Record<string, unknown>> {
  const method = (init.method || 'GET').toUpperCase()
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    logUpstream(label, method, url, null, Date.now() - started)
    const name = (error as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') throw new AiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），可在设置里调大超时时间`, 504)
    // fetch 只给一句「fetch failed」，真正的原因（拒绝连接、DNS 失败等）在 cause 里。
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code || cause?.message
    throw new AiError(`无法连接到接口：${(error as Error).message}${detail ? `（${detail}）` : ''}`, 502)
  }
  const text = await response.text()
  logUpstream(label, method, url, response.status, Date.now() - started)
  if (!response.ok) {
    logRaw(`${label} · 接口返回 ${response.status}`, text)
    throw new AiError(describeHttp(response.status, text), response.status >= 500 ? 502 : 400)
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    return parsed as Record<string, unknown>
  } catch {
    logRaw(`${label} · 响应体不是 JSON 对象`, text)
    throw new AiError('接口返回的内容不是合法的 JSON 对象', 502)
  }
}

function bodyWithParams(params: Record<string, unknown>, base: Record<string, unknown>, keys: string[]): string {
  // 自定义参数先铺开，再写回必须由程序控制、不允许被覆盖的字段。
  const body: Record<string, unknown> = { ...params, ...base }
  for (const key of keys) body[key] = base[key]
  return JSON.stringify(body)
}

export interface AiConnectionResult { reply: string; model: string; elapsed: number }

export async function testAiConnection(override?: unknown): Promise<AiConnectionResult> {
  const settings = configured(override)
  const { chat } = endpoints(settings.baseUrl)
  const started = Date.now()
  const payload = bodyWithParams(settings.params, {
    model: settings.model,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
  }, ['model', 'messages'])
  const label = '测试连接'
  const data = await requestJson(chat, { method: 'POST', headers: headers(settings), body: payload }, settings.timeoutMs, label)
  return { reply: extractContent(data, label).trim().slice(0, 200), model: asText(data.model, settings.model), elapsed: Date.now() - started }
}

export async function listAiModels(override?: unknown): Promise<string[]> {
  // 获取模型列表只需要 baseUrl 和 apiKey，不需要提前选好模型名称
  const settings = configured(override, false)
  const { models } = endpoints(settings.baseUrl)
  const data = await requestJson(models, { headers: headers(settings) }, settings.timeoutMs, '获取模型列表')
  const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
  const ids = items.map(item => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') return asText((item as Record<string, unknown>).id) || asText((item as Record<string, unknown>).name)
    return ''
  }).filter(Boolean)
  const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  if (!unique.length) {
    logRaw('获取模型列表 · 响应里没有模型', JSON.stringify(data))
    throw new AiError('接口没有返回可用的模型列表', 502)
  }
  return unique
}

function extractContent(data: Record<string, unknown>, label: string): string {
  const choices = data.choices
  if (!Array.isArray(choices) || !choices.length) {
    // 有些实现会把内容放在 message.content 或 output_text。
    const direct = asText(data.output_text)
    if (direct) return direct
    logRaw(`${label} · 响应里没有内容字段`, JSON.stringify(data))
    throw new AiError('接口没有返回可用的内容', 502)
  }
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown }
  const content = first?.message?.content
  let result = ''
  if (typeof content === 'string') result = content
  // 部分实现会把内容拆成 [{ type: 'text', text: '…' }]。
  else if (Array.isArray(content)) result = content.map(part => typeof part === 'string' ? part : asText((part as { text?: unknown })?.text)).join('')
  else if (typeof first?.text === 'string') result = first.text
  if (!result.trim()) {
    logRaw(`${label} · 响应里没有可用的内容`, JSON.stringify(data))
    throw new AiError('接口返回的内容为空', 502)
  }
  return result
}

// 模型有时会裹上代码块或前后寒暄，这里尽量把 JSON 抠出来。
function parseJsonValue(content: string, label: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const candidates = [trimmed]
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  const arrayStart = trimmed.indexOf('[')
  const arrayEnd = trimmed.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(trimmed.slice(arrayStart, arrayEnd + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch { /* 换下一个候选串 */ }
  }
  logRaw(`${label} · 模型返回`, content)
  throw new AiError('模型返回的内容无法解析为 JSON，可尝试换个模型或简化提示词', 502)
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  const parsed = parseJsonValue(content, label)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logRaw(`${label} · 模型返回的不是 JSON 对象`, content)
    throw new AiError('模型返回的内容不是 JSON 对象，可尝试换个模型或简化提示词', 502)
  }
  return parsed as Record<string, unknown>
}

function cleanFields(input: AiTranslateFields): AiTranslateFields {
  const fields: AiTranslateFields = {}
  if (typeof input?.title === 'string' && input.title.trim()) fields.title = input.title
  if (typeof input?.author === 'string' && input.author.trim()) fields.author = input.author
  if (typeof input?.description === 'string' && input.description.trim()) fields.description = input.description
  if (Array.isArray(input?.tags)) {
    const tags = input.tags.filter(tag => typeof tag === 'string' && tag.trim())
    if (tags.length) fields.tags = tags
  }
  return fields
}

// 内置提示词只读不可编辑：用户只能追加一段文本，拼在内置提示词之后，中间空两行。
function withAppendedPrompt(builtin: string, target: string, append: string): string {
  const base = fillPrompt(builtin, target)
  const extra = (append || '').trim()
  return extra ? `${base}\n\n${extra}` : base
}

function systemPrompt(target: string, append: string): string {
  return withAppendedPrompt(DEFAULT_TRANSLATE_PROMPT, target, append)
}

function mangaSystemPrompt(target: string, append: string): string {
  return withAppendedPrompt(DEFAULT_MANGA_PROMPT, target, append)
}

function cacheKey(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function pickFields(parsed: Record<string, unknown>, source: AiTranslateFields, label: string): AiTranslateFields {
  const result: AiTranslateFields = {}
  let matched = 0
  for (const key of ['title', 'author', 'description'] as const) {
    const original = source[key]
    if (original === undefined) continue
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) { result[key] = value.trim(); matched++ } else { result[key] = original }
  }
  if (source.tags) {
    const value = parsed.tags
    const tags = Array.isArray(value) ? value.map(tag => asText(tag)).filter(Boolean) : []
    if (tags.length) { result.tags = tags; matched++ } else { result.tags = source.tags }
  }
  if (!matched) {
    logRaw(`${label} · 模型返回缺少预期字段`, JSON.stringify(parsed))
    throw new AiError('模型返回的 JSON 缺少预期字段，可尝试换个模型或调整自定义参数', 502)
  }
  return result
}

export interface AiTranslateResult { fields: AiTranslateFields; cached: boolean; model: string; createdAt: number; targetLanguage: string }

export interface MangaTextTranslateResult { translations: string[]; model: string; targetLanguage: string }

/**
 * 一页漫画里的文本按阅读顺序一次批量翻译。输入输出等长、顺序一致；
 * 模型少返或漏返的项回退到原文，避免某个气泡被擦掉后却没有新文字。
 */
export async function translateMangaTexts(input: { texts: string[]; targetLanguage?: string }): Promise<MangaTextTranslateResult> {
  const texts = Array.isArray(input?.texts) ? input.texts.map(text => asText(text)).filter(Boolean) : []
  if (!texts.length) throw new AiError('这一页没有识别到可翻译的文字')
  const settings = configured()
  const targetLanguage = asText(input?.targetLanguage, '') || settings.targetLanguage
  const { chat } = endpoints(settings.baseUrl)
  const payload = bodyWithParams(settings.params, {
    model: settings.model,
    messages: [
      {
        role: 'system',
        content: mangaSystemPrompt(targetLanguage, settings.appendPrompt),
      },
      { role: 'user', content: JSON.stringify(texts) },
    ],
    response_format: { type: 'json_object' },
    stream: false,
  }, ['model', 'messages', 'response_format', 'stream'])
  const label = `翻译漫画文本（${texts.length} 段${settings.model ? ` · ${settings.model}` : ''}）`
  const data = await requestJson(chat, { method: 'POST', headers: headers(settings), body: payload }, settings.timeoutMs, label)
  const content = extractContent(data, label)
  const parsed = parseJsonValue(content, label)
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).translations
        ?? (parsed as Record<string, unknown>).translated_texts
        ?? (parsed as Record<string, unknown>).items
      : null
  if (!Array.isArray(values)) {
    logRaw(`${label} · 模型返回里没有译文数组`, content)
    throw new AiError('模型没有按数组返回漫画译文，可尝试换个模型', 502)
  }
  const translations = texts.map((source, index) => asText(values[index]) || source)
  if (translations.every((text, index) => text === texts[index])) {
    logRaw(`${label} · 模型返回的译文与原文相同`, content)
    throw new AiError('模型没有返回可用的漫画译文，可尝试换个模型', 502)
  }
  return { translations, model: asText(data.model, settings.model), targetLanguage }
}

export async function translateFields(input: { fields: AiTranslateFields; targetLanguage?: string; force?: boolean }): Promise<AiTranslateResult> {
  const settings = configured()
  const fields = cleanFields(input?.fields || {})
  if (!Object.keys(fields).length) throw new AiError('这组作品没有可翻译的文字内容')
  const targetLanguage = asText(input?.targetLanguage, '') || settings.targetLanguage
  // 缓存只认「原文 + 目标语言」：换模型、改系统提示词或自定义参数都不会让已有译文失效。
  // 想用新配置重译时走 force 分支，重新请求并覆盖这条记录。
  const key = cacheKey({ targetLanguage, fields })
  if (!input?.force) {
    const row = db.prepare('SELECT data FROM translations WHERE key = ?').get(key) as { data: string } | undefined
    if (row) {
      try {
        const cached = JSON.parse(row.data) as AiTranslateResult
        return { ...cached, cached: true }
      } catch { /* 缓存损坏就当没命中 */ }
    }
  }
  const { chat } = endpoints(settings.baseUrl)
  const payload = bodyWithParams(settings.params, {
    model: settings.model,
    messages: [
      { role: 'system', content: systemPrompt(targetLanguage, settings.appendPrompt) },
      { role: 'user', content: JSON.stringify(fields, null, 2) },
    ],
    // 结构化输出：内容必须是 JSON 对象，便于直接解析。
    response_format: { type: 'json_object' },
    stream: false,
  }, ['model', 'messages', 'response_format', 'stream'])
  const label = `翻译作品信息（${Object.keys(fields).length} 个字段${settings.model ? ` · ${settings.model}` : ''}）`
  const data = await requestJson(chat, { method: 'POST', headers: headers(settings), body: payload }, settings.timeoutMs, label)
  const content = extractContent(data, label)
  const result: AiTranslateResult = {
    fields: pickFields(parseJsonObject(content, label), fields, label),
    cached: false,
    model: asText(data.model, settings.model),
    createdAt: Date.now(),
    targetLanguage,
  }
  db.prepare('INSERT OR REPLACE INTO translations (key, data, created) VALUES (?, ?, ?)').run(key, JSON.stringify(result), result.createdAt)
  return result
}

export function clearTranslationCache(): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM translations').get() as { count: number }
  db.prepare('DELETE FROM translations').run()
  return row?.count || 0
}
