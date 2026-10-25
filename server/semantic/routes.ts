import type { FastifyInstance } from 'fastify'
import type { WorksResponse } from '../../shared/types.js'
import { allWorks, favoriteIds, getAsset, toWork } from '../database.js'
import { getSemanticStatus, indexSemanticAsset, semanticStore } from './service.js'
import type { SemanticProvider } from './provider.js'
import { SemanticError } from './vectors.js'

const vectorSchema = { type: 'array', minItems: 512, maxItems: 512, items: { type: 'number' } }
const modelSchema = { type: 'string', minLength: 1, maxLength: 200 }
export function registerSemanticRoutes(app: FastifyInstance, provider?: SemanticProvider): void {
  app.get('/api/semantic/status', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); return getSemanticStatus(provider) })
  app.post<{ Params: { id: string } }>('/api/semantic/assets/:id/index', async request => {
    const asset = getAsset(request.params.id)
    if (!asset) throw new SemanticError('semantic_asset_not_found', '图片不存在', 404)
    return indexSemanticAsset(asset, provider)
  })
  // Explicit adapter boundary for trusted local tooling. No client-supplied filesystem paths.
  app.put<{ Params: { id: string }; Body: { model: string; vector: number[]; size: number; modified: number } }>('/api/semantic/assets/:id/vector', {
    bodyLimit: 32_768,
    schema: { body: { type: 'object', additionalProperties: false, required: ['model', 'vector', 'size', 'modified'], properties: { model: modelSchema, vector: vectorSchema, size: { type: 'number', minimum: 0 }, modified: { type: 'number', minimum: 0 } } } },
  }, async request => {
    const asset = getAsset(request.params.id)
    if (!asset) throw new SemanticError('semantic_asset_not_found', '图片不存在', 404)
    if (asset.size !== request.body.size || asset.modified !== request.body.modified) throw new SemanticError('semantic_asset_changed', '图片已变更，拒绝保存旧向量', 409)
    semanticStore.put(asset, request.body.model, request.body.vector)
    return { indexed: true }
  })
  app.delete<{ Params: { id: string } }>('/api/semantic/assets/:id/vector', async request => { semanticStore.invalidate(request.params.id); return { ok: true } })
  app.post<{ Body: { model: string; vector: number[]; source?: string; favorites?: boolean; page?: number; minScore?: number } }>('/api/semantic/search', {
    bodyLimit: 32_768,
    schema: { body: { type: 'object', additionalProperties: false, required: ['model', 'vector'], properties: { model: modelSchema, vector: vectorSchema, source: { type: 'string', maxLength: 200 }, favorites: { type: 'boolean' }, page: { type: 'integer', minimum: 1 }, minScore: { type: 'number', minimum: -1, maximum: 1 } } } },
  }, async (request, reply): Promise<WorksResponse> => {
    reply.header('Cache-Control', 'no-store')
    const started = performance.now()
    const favorites = favoriteIds()
    const body = request.body
    const works = new Map(allWorks().filter(work => (!body.source || work.sourceId === body.source) && (!body.favorites || favorites.has(work.id))).map(work => [work.id, toWork(work, favorites)]))
    const matches = await semanticStore.rank(body.vector, body.model, new Set(works.keys()), body.minScore ?? -1)
    const pages = Math.max(1, Math.ceil(matches.length / 48))
    const page = Math.min(pages, body.page || 1)
    return { items: matches.slice((page - 1) * 48, page * 48).map(match => ({ ...works.get(match.workId)!, semanticScore: match.score, semanticAssetId: match.assetId })), total: matches.length, page, pages, elapsed: Math.round(performance.now() - started) }
  })
}
