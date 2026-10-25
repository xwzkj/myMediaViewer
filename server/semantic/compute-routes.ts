import type { FastifyInstance } from 'fastify'
import { LocalClipProvider, type SemanticProvider } from './provider.js'
import { normalizeVector, SemanticError } from './vectors.js'
import { COMPUTE_MAX_UPLOAD_BYTES } from '../../shared/compute.js'
import { logInfo } from '../log.js'

/** Register inside the authenticated compute app, after its octet-stream parser. */
export function registerSemanticComputeRoutes(app: FastifyInstance, provider: SemanticProvider = new LocalClipProvider({ threads: Number(process.env.SEMANTIC_CLIP_THREADS) || 1 })): void {
  let active = false
  app.get('/v1/semantic/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return provider.status()
  })
  async function encode(model: unknown, label: string, run: () => Promise<Float32Array>) {
    if (active) throw new SemanticError('semantic_busy', '语义计算正在处理另一张图片或查询，请稍后重试', 429)
    active = true
    const started = Date.now()
    try {
      const status = await provider.status()
      if (!status.ready) {
        throw new SemanticError(status.downloading ? 'semantic_downloading' : 'semantic_unavailable', status.message || 'CLIP 模型尚未准备好', 503)
      }
      if (model !== status.model) throw new SemanticError('semantic_model_mismatch', 'CLIP 模型版本不匹配，请重新获取状态', 409)
      const vector = normalizeVector(await run())
      logInfo('计算端', `语义编码完成 · ${label} · 512 维 · ${Date.now() - started}ms`)
      return { model: status.model, dimensions: 512, vector: Array.from(vector) }
    } finally { active = false }
  }
  app.post<{ Body: { query: string } }>('/v1/semantic/text', {
    bodyLimit: 4096,
    schema: { body: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 500 } } } },
  }, async request => {
    if (!request.body.query.trim()) throw new SemanticError('semantic_invalid_query', '请输入画面描述')
    return encode(request.headers['x-semantic-model'], `文本「${request.body.query.slice(0, 30)}」`, () => provider.embedText(request.body.query))
  })
  app.post<{ Body: Buffer }>('/v1/semantic/image', { bodyLimit: COMPUTE_MAX_UPLOAD_BYTES }, async request => {
    if (!Buffer.isBuffer(request.body) || !request.body.length) throw new SemanticError('semantic_invalid_image', '请上传非空图片二进制数据')
    return encode(request.headers['x-semantic-model'], `图片 ${(request.body.length / 1024).toFixed(0)}KB`, () => provider.embedImage(request.body))
  })
}
