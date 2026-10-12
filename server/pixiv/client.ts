import { assertPixivSession, forceRefreshPixivAccessToken, getPixivAccessToken, getPixivSessionVersion, requirePixivReady } from './auth.js'
import { PixivApiError, pixivErrorMessage } from './errors.js'
import { pixivApiUrl, pixivHeaders } from './protocol.js'
import { pixivJson, pixivRequest } from './transport.js'

let queue: Promise<unknown> = Promise.resolve()
let nextAt = 0
const MIN_INTERVAL_MS = 200
const waiters: Array<() => void> = []
let active = 0

async function withApiSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>(resolve => waiters.push(resolve))
  else active++
  try { return await task() }
  finally { const next = waiters.shift(); if (next) next(); else active-- }
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// Pace request starts without holding the entire API queue during network I/O/backoff.
async function scheduled(signal?: AbortSignal | null): Promise<void> {
  const run = queue.then(async () => {
    await sleep(Math.max(0, nextAt - Date.now()), signal)
    nextAt = Date.now() + MIN_INTERVAL_MS
  })
  queue = run.catch(() => undefined)
  return run
}

function describeError(status: number, payload: unknown): PixivApiError {
  const message = pixivErrorMessage(payload) || `HTTP ${status}`
  if (status === 429) return new PixivApiError('Pixiv 请求过于频繁，请稍后再试', 429, 'rate_limited')
  if (status === 401 || status === 403) return new PixivApiError('Pixiv 账号无权访问该内容或登录已失效', status, 'unauthorized')
  if (status === 404) return new PixivApiError('Pixiv 内容不存在或不可见', 404, 'not_found')
  return new PixivApiError(`Pixiv 请求失败：${message}`, status >= 500 ? 502 : status, 'pixiv_error')
}

function tokenExpired(status: number, payload: unknown): boolean {
  return status === 401 || (status === 400 && /Error occurred at the OAuth process|Invalid refresh token|invalid.*token|token.*invalid|access.?token.*expir/i.test(JSON.stringify(payload)))
}

export async function pixivFetch<T>(pathOrUrl: string, init: RequestInit = {}, opts: { auth?: boolean; retryToken?: boolean } = {}): Promise<T> {
  const url = pixivApiUrl(pathOrUrl).toString()
  const auth = opts.auth !== false
  if (auth) requirePixivReady()
  const version = getPixivSessionVersion()
  let refreshed = false
  let retries = 0
  const read = !init.method || init.method.toUpperCase() === 'GET'
  for (;;) {
    await scheduled(init.signal)
    if (auth) assertPixivSession(version)
    const token = auth ? await getPixivAccessToken() : ''
    if (auth) assertPixivSession(version)
    const headers = new Headers(init.headers)
    for (const [key, value] of Object.entries(pixivHeaders())) headers.set(key, value)
    if (auth) headers.set('Authorization', `Bearer ${token}`)
    let response: Response
    let payload: Record<string, unknown>
    try {
      const result = await withApiSlot(async () => {
        if (auth) assertPixivSession(version)
        const reply = await pixivRequest(url, { ...init, headers })
        return { response: reply, payload: await pixivJson(reply) }
      })
      response = result.response
      payload = result.payload
    } catch (error) {
      if (auth) assertPixivSession(version)
      if (!read || !(error instanceof PixivApiError) || !['timeout', 'network_error'].includes(error.code || '') || retries >= 2) throw error
      await sleep(500 * 2 ** retries++, init.signal)
      continue
    }
    if (auth) assertPixivSession(version)
    if (response.ok && !payload.error) return payload as T
    const status = response.ok ? 400 : response.status
    if (auth && opts.retryToken !== false && !refreshed && tokenExpired(status, payload)) {
      refreshed = true
      await forceRefreshPixivAccessToken(token)
      continue
    }
    const error = describeError(status, payload)
    if (retries >= 2 || !(status === 429 || (read && [500, 502, 503, 504].includes(status)))) throw error
    const value = response.headers.get('retry-after')
    const retryAfter = value ? (Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : 0
    const backoff = Math.min(30_000, Math.max(500 * 2 ** retries++, retryAfter || 0))
    if (status === 429) nextAt = Math.max(nextAt, Date.now() + backoff)
    await sleep(backoff, init.signal)
  }
}

export function pixivForm<T>(path: string, fields: Record<string, string | string[]>, opts: { auth?: boolean; retryToken?: boolean } = {}): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) body.append(key, item)
  return pixivFetch<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, opts)
}
