import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { customRules } from '../shared/source-presets.js'

/**
 * 重扫不能清空语义向量。
 *
 * 清理孤儿向量曾经放在「删除本来源资源」之后、重新插入之前：那一刻 assets 表里
 * 只有其它来源的资源，于是每次扫描都会把刚扫过的这一来源的 CLIP 向量全部删掉，
 * 索引在每次启动后归零。
 */
test('重扫保留未变化资源的语义向量，只删除真正消失的资源', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'media-semantic-rescan-'))
  process.env.MEDIA_DATA_DIR = dir
  const { db, saveSource } = await import('../server/database.js')
  try {
    const source = { id: 'src', name: 'Src', kind: 'custom' as const, path: dir, rules: customRules() }
    const asset = {
      id: 'src:page-01', workId: 'src:page-01', path: path.join(dir, 'page-01.png'), filename: 'page-01.png',
      page: 0, kind: 'image' as const, extension: 'png', size: 1, modified: 1, display: true,
    }
    const work = {
      id: 'src:page-01', sourceId: 'src', sourceName: 'Src', sourceKind: 'custom' as const, externalId: 'page-01',
      title: 'page-01', author: '', description: '', tags: [], date: '', collected: 0, updated: 0, count: 1,
      kind: 'image' as const, coverId: asset.id, originalUrl: '',
    }
    const putVector = (assetId: string) => db.prepare('INSERT OR REPLACE INTO semantic_embeddings (asset_id, model, fingerprint, dimensions, vector, created) VALUES (?, ?, ?, 512, ?, 1)')
      .run(assetId, 'test-model', 'fp', new Uint8Array(2048))
    const vectors = () => (db.prepare('SELECT asset_id FROM semantic_embeddings').all() as Array<{ asset_id: string }>).map(row => row.asset_id)

    saveSource(source as never, [work as never], [asset as never])
    putVector(asset.id)
    assert.deepEqual(vectors(), [asset.id])

    // 同样的资源再扫一次：向量必须还在。
    saveSource(source as never, [work as never], [asset as never])
    assert.deepEqual(vectors(), [asset.id], '重扫不能清空仍然存在的资源向量')

    // 资源真的消失了：向量应当被清理。
    saveSource(source as never, [], [])
    assert.deepEqual(vectors(), [], '被删除资源的向量要清理')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
