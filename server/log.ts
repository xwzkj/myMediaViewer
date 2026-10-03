/**
 * 精简日志：只输出接口调用、关键操作、队列进度和报错，不再逐请求打印流水账。
 * 需要 Fastify 自带的默认逐请求日志时，用 LOG_LEVEL=debug 启动。
 */
export const debugLogging = (process.env.LOG_LEVEL || '').trim().toLowerCase() === 'debug'

let enabled = true
export function setLoggingEnabled(value: boolean): void { enabled = value }

type Level = 'info' | 'warn' | 'error'

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: number, text: string) => useColor ? `\u001b[${code}m${text}\u001b[0m` : text
const dim = (text: string) => paint(2, text)
const levelPaint: Record<Level, (text: string) => string> = {
  info: text => paint(36, text),
  warn: text => paint(33, text),
  error: text => paint(31, text),
}

function clock(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function emit(level: Level, tag: string, message: string): void {
  if (!enabled) return
  process.stdout.write(`${dim(clock())} ${levelPaint[level](tag)} ${message}\n`)
}

/** 毫秒转成便于阅读的耗时：860ms / 1.2s / 1m12s。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds % 60)}s`
}

/** 单条日志只保留一行，避免把上游返回的长文本整段刷出来。 */
export function oneLine(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function logInfo(tag: string, message: string): void { emit('info', tag, message) }
export function logWarn(tag: string, message: string): void { emit('warn', tag, message) }

export function logError(tag: string, message: string, error?: unknown): void {
  emit('error', tag, oneLine(message))
  // 未预期的异常附上前几行调用栈，定位问题用；业务错误（AiError 等）只留一行消息。
  const stack = error instanceof Error ? error.stack : undefined
  if (!stack) return
  for (const line of stack.split('\n').slice(1, 4)) emit('error', '  ', oneLine(line))
}

/**
 * 上游（尤其是模型）返回的内容不符合预期时，把原始文本打出来：
 * 解析类报错没有原文就只能靠猜，溯源时需要能直接看到模型到底回了什么。
 * 按行缩进输出，超过行数或字符数上限时截断，并标注总长度。
 */
export function logRaw(label: string, text: string, maxLines = 40, maxChars = 4000): void {
  if (!enabled) return
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const clipped = (lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : normalized).slice(0, maxChars)
  const truncated = clipped.length < normalized.length
  emit('warn', '返回', `${label} · 共 ${normalized.length} 字符${truncated ? `，已截断到 ${clipped.length} 字符` : ''}`)
  if (!normalized.trim()) { emit('warn', '返回', '│ （空内容）'); return }
  for (const line of clipped.split('\n')) emit('warn', '返回', `│ ${line}`)
  if (truncated) emit('warn', '返回', '│ …')
}

/** 用户请求：方法 + 路径 + 状态码 + 耗时。4xx 记为警告，5xx 记为错误。 */
export function logApi(method: string, url: string, status: number, elapsedMs: number): void {
  emit(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', '接口', `${method} ${url} ${status} ${formatDuration(elapsedMs)}`)
}

/** 对外调用：说明用途、目标地址、状态码与耗时。 */
export function logUpstream(label: string, method: string, url: string, status: number | null, elapsedMs: number): void {
  let target = url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (target.length > 72) target = `${target.slice(0, 72)}…`
  const result = status === null ? '连接失败' : `${status}`
  emit(status === null || status >= 400 ? 'warn' : 'info', '调用', `${label} · ${method} ${target} · ${result} · ${formatDuration(elapsedMs)}`)
}
