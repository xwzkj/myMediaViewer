import { logRaw, logUpstream, logWarn } from '../log.js'

const sensitive = /token|secret|password|authorization|cookie|client[-_]hash|code[-_]verifier/i
export interface PixivRequestContext {
  url: string
  method: string
  body: unknown
  secrets: string[]
  started: number
  reported?: boolean
}

function formData(form: URLSearchParams): Record<string, string[]> {
  const data: Record<string, string[]> = Object.create(null)
  for (const [key, value] of form) (data[key] ||= []).push(value)
  return data
}

export function pixivRequestContext(url: string | URL, init: RequestInit): PixivRequestContext {
  let body: unknown = init.body
  if (body instanceof URLSearchParams) body = formData(body)
  else if (typeof body === 'string') {
    const text = body
    try { body = JSON.parse(text) }
    catch { if (new Headers(init.headers).get('content-type')?.includes('application/x-www-form-urlencoded')) body = formData(new URLSearchParams(text)) }
  } else if (body != null) body = '[binary or stream]'
  const secrets = new Set<string>()
  function collect(value: unknown, key = ''): void {
    if (typeof value === 'string' && sensitive.test(key) && value.length >= 3) {
      secrets.add(value)
      if (/^Bearer /i.test(value)) secrets.add(value.slice(7))
    } else if (Array.isArray(value)) value.forEach(item => collect(item, key))
    else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => collect(item, name))
  }
  collect(body)
  const address = new URL(url)
  collect(formData(address.searchParams))
  new Headers(init.headers).forEach((value, key) => collect(value, key))
  return { url: address.href, method: init.method || 'GET', body, secrets: [...secrets].sort((a, b) => b.length - a.length), started: Date.now() }
}

function redact(value: unknown, context: PixivRequestContext, key = ''): unknown {
  if (sensitive.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redact(item, context))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, context, name)]))
  if (typeof value !== 'string') return value
  let text = value
  for (const secret of context.secrets) text = text.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]')
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/("[^"\n]*(?:token|secret|password|cookie|authorization)[^"\n]*"\s*:\s*")[^"\n]*/gi, '$1[REDACTED]')
}

export function logPixivRequestError(context: PixivRequestContext, status: number | null, reason = ''): void {
  if (context.reported) return
  context.reported = true
  const url = new URL(context.url)
  url.username = ''; url.password = ''
  for (const [key, value] of url.searchParams) if (sensitive.test(key)) url.searchParams.set(key, '[REDACTED]'); else url.searchParams.set(key, String(redact(value, context)))
  logUpstream('Pixiv', context.method, url.href, status, Date.now() - context.started)
  if (reason) logWarn('Pixiv', String(redact(reason, context)))
  logRaw('Pixiv 请求参数', JSON.stringify({ url: url.href, body: redact(context.body, context) }))
}

export function logPixivResponseError(context: PixivRequestContext, response: Response, text: string, reason = ''): void {
  logPixivRequestError(context, response.status, reason)
  let payload: unknown = text
  try { payload = JSON.parse(text) } catch { /* Preserve malformed JSON / HTML for diagnostics. */ }
  const safe = redact(payload, context)
  logRaw('Pixiv 错误响应', typeof safe === 'string' ? safe : JSON.stringify(safe))
}

export function describeNetworkError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error)
  const code = 'code' in error ? ` (${String(error.code)})` : ''
  const cause = error.cause && depth < 3 ? `; cause: ${describeNetworkError(error.cause, depth + 1)}` : ''
  return `${error.name}${code}: ${error.message}${cause}`
}
