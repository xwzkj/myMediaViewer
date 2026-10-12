import * as http from 'node:http'
import { PixivApiError } from './errors.js'
import { describeNetworkError, logPixivRequestError, logPixivResponseError, pixivRequestContext } from './diagnostics.js'
import type { PixivRequestContext } from './diagnostics.js'

const requestContexts = new WeakMap<Response, PixivRequestContext>()

// Node 24.14+ provides proxy setup for fetch and HTTP(S), without another dependency.
const proxy = process.env.PIXIV_PROXY?.trim()
const setProxy = (http as typeof http & { setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => unknown }).setGlobalProxyFromEnv
if (proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  if (setProxy) setProxy(proxy ? { ...process.env, https_proxy: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, HTTP_PROXY: proxy } : process.env)
}

// Shared by OAuth, app-api and pximg; Node fetch does not normally use proxy env vars.
export async function pixivRequest(url: string | URL, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const context = pixivRequestContext(url, init)
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  if (!setProxy && proxy) throw new PixivApiError('PIXIV_PROXY 需要 Node.js 24.14+，请升级 Node.js', 503, 'proxy_unsupported')
  try {
    const response = await fetch(url, { ...init, signal, redirect: 'error' })
    requestContexts.set(response, context)
    if (!response.ok) logPixivRequestError(context, response.status)
    return response
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason
    logPixivRequestError(context, null, describeNetworkError(error))
    throw new PixivApiError(signal.aborted ? 'Pixiv 请求超时，请检查服务端网络或代理' : '无法连接 Pixiv，请检查服务端网络或代理', signal.aborted ? 504 : 502, signal.aborted ? 'timeout' : 'network_error')
  }
}

export async function pixivJson(response: Response): Promise<Record<string, unknown>> {
  const context = requestContexts.get(response) || pixivRequestContext(response.url || 'https://app-api.pixiv.net/', {})
  let text: string
  try { text = await response.text() }
  catch (error) {
    logPixivRequestError(context, response.status, describeNetworkError(error))
    const timeout = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
    throw new PixivApiError(timeout ? 'Pixiv 读取响应超时' : 'Pixiv 响应连接中断', timeout ? 504 : 502, timeout ? 'timeout' : 'network_error')
  }
  let payload: unknown
  try { payload = JSON.parse(text) }
  catch {
    logPixivResponseError(context, response, text, '响应不是有效 JSON')
    if (!response.ok) return {}
    throw new PixivApiError('Pixiv 返回了无效的 JSON 响应', 502, 'invalid_response')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    logPixivResponseError(context, response, text, '响应结构无效')
    throw new PixivApiError('Pixiv 返回了无效的响应', 502, 'invalid_response')
  }
  if (!response.ok || (payload as Record<string, unknown>).error) logPixivResponseError(context, response, text, '上游接口返回错误')
  return payload as Record<string, unknown>
}
