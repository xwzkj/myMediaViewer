import { readFile, stat } from 'node:fs/promises'
import { db, getAsset, type StoredAsset } from '../database.js'
import { getLocalComputeConfig } from '../ai.js'
import { accessibleAsset } from '../media.js'
import { formatDuration, logInfo, oneLine } from '../log.js'
import { COMPUTE_MAX_UPLOAD_BYTES } from '../../shared/compute.js'
import type { Work } from '../../shared/types.js'
import type { SemanticIndexResult, SemanticSearchStatus } from '../../shared/semantic.js'
import { LocalClipProvider, type SemanticProvider, type SemanticProviderStatus } from './provider.js'
import { RemoteClipProvider } from './remote.js'
import { assetFingerprint, SemanticStore } from './store.js'
import { SemanticError } from './vectors.js'

export const semanticStore = new SemanticStore(db)
let localProvider: LocalClipProvider | undefined

/** 正在自动下载模型时用可重试的错误码，后台任务据此稍后重试而不是判定失败。 */
function semanticUnavailableCode(status: SemanticProviderStatus): string {
  return status.downloading ? 'semantic_downloading' : 'semantic_unavailable'
}
export function getSemanticProvider(): SemanticProvider {
  const config = getLocalComputeConfig()
  // One immutable native model pair per process. CLIP 模型在首次使用时自动下载，
  // 线程数变更需要重启（见 SEMANTIC.md）；切换计算模式不会重新分配已有会话。
  localProvider ||= new LocalClipProvider({ threads: config.localThreads })
  // Remote adapters bind one model choice per operation; no shared status/fallback race.
  return config.mode === 'remote' ? new RemoteClipProvider(config, localProvider) : localProvider
}
export async function getSemanticStatus(provider = getSemanticProvider()): Promise<SemanticSearchStatus> {
  const status = await provider.status()
  return { ...status, ...(status.model ? await semanticStore.counts(status.model) : { indexedAssets: 0, indexedWorks: 0 }) }
}
/** Include this in background job stamps; model files are immutable until server restart. */
export async function semanticIndexRevision(): Promise<string> {
  const status = await getSemanticProvider().status()
  return status.ready ? status.model : `unavailable:${status.provider}`
}
export function invalidateSemanticAsset(assetId: string): void { semanticStore.invalidate(assetId) }
const pending = new Map<string, Promise<SemanticIndexResult>>()
/** Background callers retain source opt-in policy; manual API indexing is an explicit user action. */
export async function indexSemanticAsset(asset: StoredAsset, provider = getSemanticProvider()): Promise<SemanticIndexResult> {
  if (asset.kind !== 'image' || !asset.display) return { indexed: false, reason: 'unsupported' }
  const status = await provider.status()
  if (!status.ready) throw new SemanticError(semanticUnavailableCode(status), status.message || 'CLIP 语义编码服务不可用', 503)
  const key = JSON.stringify([asset.id, status.model, assetFingerprint(asset)])
  const existing = pending.get(key)
  if (existing) return existing
  if (pending.size >= 2) throw new SemanticError('semantic_busy', '图片语义索引正在处理，请稍后重试', 429)
  const started = Date.now()
  const task = (async (): Promise<SemanticIndexResult> => {
    if (!await accessibleAsset(asset)) throw new SemanticError('semantic_asset_unavailable', '索引图片不在可访问的媒体目录中', 404)
    const before = await stat(asset.path)
    if (!before.isFile() || before.size > COMPUTE_MAX_UPLOAD_BYTES) throw new SemanticError('semantic_image_too_large', '图片不可用或超过 128 MB 索引上限', 413)
    if (before.size !== asset.size || before.mtimeMs !== asset.modified) throw new SemanticError('semantic_asset_changed', '图片已变更，请先刷新媒体库再建立索引', 409)
    if (semanticStore.has(asset, status.model)) return { indexed: false, reason: 'cached' }
    const vector = await provider.embedImage(await readFile(asset.path))
    const after = await stat(asset.path)
    const current = getAsset(asset.id)
    if (!current || assetFingerprint(current) !== assetFingerprint(asset) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new SemanticError('semantic_asset_changed', '编码期间图片已变更，未保存过期向量', 409)
    semanticStore.put(asset, status.model, vector)
    logInfo('语义', `索引完成 · ${asset.filename} · 512 维 · ${formatDuration(Date.now() - started)}`)
    return { indexed: true }
  })()
  pending.set(key, task)
  try { return await task } finally { pending.delete(key) }
}
export async function searchSemanticWorks(query: string, works: Work[], provider = getSemanticProvider()) {
  const text = query.trim()
  if (!text || text.length > 500) throw new SemanticError('semantic_invalid_query', '请输入 1–500 字符的画面描述')
  const started = Date.now()
  const status = await provider.status()
  if (!status.ready) throw new SemanticError(semanticUnavailableCode(status), status.message || 'CLIP 语义编码服务不可用，请切换关键词搜索', 503)
  const catalog = new Map(works.filter(work => !work.unavailable).map(work => [work.id, work]))
  const vector = await provider.embedText(text)
  const matches = await semanticStore.rank(vector, status.model, new Set(catalog.keys()))
  if (!matches.length) {
    const counts = await semanticStore.counts(status.model)
    if (!counts.indexedAssets) throw new SemanticError('semantic_index_empty', '当前 CLIP 模型尚无图片索引；请先为媒体目录建立语义索引，或使用关键词搜索', 409)
  }
  logInfo('语义', `搜索「${oneLine(text, 40)}」· 候选 ${catalog.size} 组 · 命中 ${matches.length} 组 · ${formatDuration(Date.now() - started)}`)
  return matches.map(match => ({ work: { ...catalog.get(match.workId)!, semanticScore: match.score, semanticAssetId: match.assetId }, score: match.score, approximate: false }))
}
