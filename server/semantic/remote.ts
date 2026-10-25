import type { LocalComputeConfig } from '../ai.js'
import { logWarn } from '../log.js'
import { COMPUTE_PROTOCOL_VERSION } from '../../shared/compute.js'
import type { SemanticProvider, SemanticProviderStatus } from './provider.js'
import { normalizeVector, SemanticError } from './vectors.js'

/** 只有连接层面的失败允许回退本地；鉴权、配置、协议、模型错误必须原样暴露。 */
function fallbackable(error: unknown): boolean {
  return error instanceof SemanticError && error.code === 'semantic_remote_unavailable'
}

export class RemoteClipProvider implements SemanticProvider {
  private selected?: SemanticProviderStatus
  private usingLocal = false
  constructor(private readonly config: LocalComputeConfig, private readonly local: SemanticProvider) {}
  private async request(endpoint: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let url: URL
    try {
      url = new URL(this.config.baseUrl.replace(/[/]+$/, '') + endpoint)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !this.config.apiKey) throw new Error()
    } catch { throw new SemanticError('semantic_remote_config', '请配置远程计算端地址与 API Key', 503) }
    try {
      const response = await fetch(url, { ...init, redirect: 'error', headers: { ...init?.headers, authorization: `Bearer ${this.config.apiKey}` }, signal: AbortSignal.timeout(init ? this.config.timeoutMs : this.config.connectTimeoutMs) })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 409) throw new SemanticError('semantic_model_mismatch', '本地与远程 CLIP 模型不匹配，请重新建立对应模型的索引', 409)
        if (response.status === 401 || response.status === 403) throw new SemanticError('semantic_remote_unauthorized', '远程语义计算端 API Key 无效或访问被拒绝', 503)
        if (response.status === 429) throw new SemanticError('semantic_busy', '远程语义计算端繁忙，请稍后重试', 429)
        if (response.status < 500 && response.status !== 404) throw new SemanticError('semantic_remote_rejected', '远程语义计算端拒绝请求，请检查输入', 400)
        throw new SemanticError('semantic_remote_unavailable', '远程计算端没有可用的 CLIP 语义编码服务', 503)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 64 * 1024) { await reader.cancel(); throw new Error() }
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch (error) {
      if (error instanceof SemanticError) throw error
      throw new SemanticError('semantic_remote_unavailable', '无法连接远程语义计算端，请检查连接或选择本地回退', 503)
    }
  }
  /**
   * 基础健康检查：/v1/status 是权威来源，协议不兼容时直接拒绝。
   * 每次派发语义任务前都会重新执行，计算端离线后不会再收到任务。
   */
  private async health(): Promise<void> {
    const data = await this.request('/v1/status')
    if (data.protocol !== COMPUTE_PROTOCOL_VERSION) {
      throw new SemanticError(
        'semantic_remote_protocol',
        `远程计算端协议版本是 ${String(data.protocol ?? '未知')}，当前主服务需要 ${COMPUTE_PROTOCOL_VERSION}`,
        409,
      )
    }
  }
  async status(): Promise<SemanticProviderStatus> {
    // Base compute health is authoritative. Never send a semantic job after this fails.
    try { await this.health() }
    catch (error) {
      if (this.config.fallback === 'local' && fallbackable(error)) {
        this.usingLocal = true
        logWarn('语义', '远程计算端健康检查失败，回退本地 CLIP：' + (error as Error).message)
        const status = await this.local.status()
        return this.selected = { ...status, message: status.ready ? '远程计算端健康检查失败，已回退到本地 CLIP' : status.message }
      }
      return this.selected = { ready: false, provider: 'remote', model: '', dimensions: 512, message: (error as Error).message }
    }
    try {
      const data = await this.request('/v1/semantic/status')
      if (data.ready !== true || data.dimensions !== 512 || typeof data.model !== 'string' || !/^chinese-clip-vit-b16:[a-f0-9]{64}$/.test(data.model)) throw new SemanticError('semantic_remote_unavailable', '远程计算端未准备好匹配的 512 维语义模型', 503)
      this.usingLocal = false
      return this.selected = { ready: true, provider: 'remote', model: data.model, dimensions: 512 }
    } catch (error) {
      if (this.config.fallback === 'local' && fallbackable(error)) {
        this.usingLocal = true
        logWarn('语义', '远程语义状态不可用，回退本地 CLIP：' + (error as Error).message)
        const status = await this.local.status()
        return this.selected = { ...status, message: status.ready ? '远程语义计算不可用，已回退到本地 CLIP' : status.message }
      }
      return this.selected = { ready: false, provider: 'remote', model: '', dimensions: 512, message: (error as Error).message }
    }
  }
  private async embed(endpoint: string, init: RequestInit, fallback: () => Promise<Float32Array>): Promise<Float32Array> {
    const status = this.selected || await this.status()
    if (!status.ready) throw new SemanticError('semantic_unavailable', status.message || '语义编码服务不可用', 503)
    if (this.usingLocal) return fallback()
    try {
      // 每次派发前重新探测：健康检查失败时一个语义任务都不会发出去。
      await this.health()
      const data = await this.request(endpoint, { ...init, headers: { ...init.headers, 'x-semantic-model': status.model } })
      if (data.model !== status.model || data.dimensions !== 512) throw new SemanticError('semantic_model_mismatch', '远程语义模型已变更，请重试并重建索引', 409)
      if (!Array.isArray(data.vector)) throw new SemanticError('semantic_invalid_vector', '远程语义向量格式无效', 502)
      return normalizeVector(data.vector)
    } catch (error) {
      if (this.config.fallback === 'local' && fallbackable(error)) {
        const local = await this.local.status()
        if (local.ready && local.model === status.model) {
          logWarn('语义', '远程编码失败，回退本地 CLIP：' + (error as Error).message)
          return fallback()
        }
        throw new SemanticError('semantic_fallback_unavailable', '远程计算不可用，本地没有相同版本的 CLIP 模型，未混用向量', 503)
      }
      throw error
    }
  }
  embedText(query: string): Promise<Float32Array> {
    return this.embed('/v1/semantic/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) }, () => this.local.embedText(query))
  }
  embedImage(image: Buffer): Promise<Float32Array> {
    return this.embed('/v1/semantic/image', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(image) }, () => this.local.embedImage(image))
  }
}
