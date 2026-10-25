import type { DatabaseSync } from 'node:sqlite'
import type { StoredAsset } from '../database.js'
import { cosineSimilarity, decodeVector, encodeVector, normalizeVector, SemanticError } from './vectors.js'

export function assetFingerprint(asset: StoredAsset): string {
  return JSON.stringify([asset.path, asset.size, asset.modified])
}
export function validateModel(model: string): string {
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new SemanticError('semantic_invalid_model', '必须指定有效的语义模型版本（不超过 200 字符）')
  return model.trim()
}
export interface SemanticMatch { workId: string; assetId: string; score: number }
interface VectorRow { asset_id: string; fingerprint: string; vector: Uint8Array; work_id: string; data: string }

export class SemanticStore {
  constructor(private readonly database: DatabaseSync) {}
  has(asset: StoredAsset, model: string): boolean {
    const row = this.database.prepare('SELECT fingerprint, vector FROM semantic_embeddings WHERE asset_id = ? AND model = ?').get(asset.id, model) as { fingerprint: string; vector: Uint8Array } | undefined
    if (!row || row.fingerprint !== assetFingerprint(asset)) return false
    try { decodeVector(row.vector); return true } catch { return false }
  }
  put(asset: StoredAsset, model: string, vector: ArrayLike<number>): void {
    if (!asset.display || asset.kind !== 'image') throw new SemanticError('semantic_unsupported_asset', '语义索引仅支持可显示的本地静态图片')
    this.database.prepare('INSERT OR REPLACE INTO semantic_embeddings (asset_id, model, fingerprint, dimensions, vector, created) VALUES (?, ?, ?, 512, ?, ?)')
      .run(asset.id, validateModel(model), assetFingerprint(asset), encodeVector(vector), Date.now())
  }
  invalidate(assetId: string): void { this.database.prepare('DELETE FROM semantic_embeddings WHERE asset_id = ?').run(assetId) }
  private async *rows(model: string): AsyncGenerator<{ row: VectorRow; vector: Float32Array }> {
    const select = this.database.prepare(`SELECT e.rowid AS row_id, e.asset_id, e.fingerprint, e.vector, a.work_id, a.data
      FROM semantic_embeddings e JOIN assets a ON a.id = e.asset_id JOIN works w ON w.id = a.work_id
      WHERE e.model = ? AND e.rowid > ? ORDER BY e.rowid LIMIT 256`)
    let cursor = 0
    for (;;) {
      const rows = select.all(model, cursor) as unknown as Array<VectorRow & { row_id: number }>
      if (!rows.length) break
      for (const row of rows) {
        cursor = row.row_id
        try {
          const asset = JSON.parse(row.data) as StoredAsset
          if (!asset.display || asset.kind !== 'image' || row.fingerprint !== assetFingerprint(asset)) continue
          yield { row, vector: decodeVector(row.vector) }
        } catch { /* Corrupt/stale records never become invented scores. Reindex repairs them. */ }
      }
      // Do not retain an SQLite iterator/read lock across event-loop yields.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  async counts(model: string): Promise<{ indexedAssets: number; indexedWorks: number }> {
    let indexedAssets = 0
    const works = new Set<string>()
    for await (const { row } of this.rows(model)) { indexedAssets++; works.add(row.work_id) }
    return { indexedAssets, indexedWorks: works.size }
  }
  /** Best page wins, so long albums do not gain an artificial sum-of-scores advantage. */
  async rank(query: ArrayLike<number>, model: string, eligible?: Set<string>, minScore = -1): Promise<SemanticMatch[]> {
    const vector = normalizeVector(query)
    const best = new Map<string, SemanticMatch>()
    for await (const { row, vector: candidate } of this.rows(validateModel(model))) {
      if (eligible && !eligible.has(row.work_id)) continue
      const score = cosineSimilarity(vector, candidate)
      if (score < minScore) continue
      const previous = best.get(row.work_id)
      if (!previous || score > previous.score || (score === previous.score && row.asset_id < previous.assetId)) best.set(row.work_id, { workId: row.work_id, assetId: row.asset_id, score })
    }
    return [...best.values()].sort((a, b) => b.score - a.score || (a.workId < b.workId ? -1 : a.workId > b.workId ? 1 : 0))
  }
}
