import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { customRules } from '../shared/source-presets.js'
import { normalizeSourceBackground } from '../shared/background.js'

/**
 * CLIP 计算端离线时不能再把「不可用」写进任务指纹。
 *
 * 以前版本号在未就绪时是 `unavailable:remote`，于是计算端离线期间的一次同步
 * 就会删掉全部已完成的语义任务，等它恢复后再整体重排成待处理。
 */
test('CLIP 未就绪时同步不重建语义任务，也不删除已完成记录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'background-semantic-stamp-')), media = path.join(root, 'media')
  await mkdir(media)
  for (const name of ['1.jpg', '2.jpg']) await writeFile(path.join(media, name), name)
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  const { saveSources } = await import('../server/config.js')
  const { saveAiSettings, getAiSettings } = await import('../server/ai.js')
  const { db } = await import('../server/database.js')
  const { scanLibrary } = await import('../server/scanner.js')
  const service = await import('../server/background/service.js')
  try {
    saveSources([{ id: 's', name: 'Semantic', kind: 'custom', path: media, rules: customRules() }])
    const ai = getAiSettings()
    // 指向一个必然拒绝连接的端口：状态探测立刻返回「未就绪」，且不会触发模型下载。
    saveAiSettings({
      ...ai,
      localCompute: { ...ai.localCompute, mode: 'remote', baseUrl: 'http://127.0.0.1:1', fallback: 'error', apiKey: 'stamp-key', connectTimeoutMs: 100 },
    })
    await scanLibrary()
    service.saveBackgroundSettings('s', { ...normalizeSourceBackground(undefined), semantic: true })
    await service.synchronizeBackground()
    assert.equal(service.backgroundQueue.counts('s').queued, 0, 'CLIP 未就绪时不应排语义任务')

    // 模型可用时已经做完的记录，必须在离线期间原样保留。
    const asset = db.prepare('SELECT id FROM assets ORDER BY id LIMIT 1').get() as { id: string }
    db.prepare("INSERT INTO background_tasks(id,source_id,asset_id,stamp,kind,state,updated) VALUES ('kept','s',?,?,'semantic','done',1)")
      .run(asset.id, JSON.stringify(['/media/1.jpg', 1, 1, 'chinese-clip-vit-b16:deadbeef']))
    await service.synchronizeBackground()
    const kept = db.prepare("SELECT state FROM background_tasks WHERE id='kept'").get() as { state: string } | undefined
    assert.equal(kept?.state, 'done', '已完成记录不能被重建')
  } finally {
    service.stopBackgroundRuntime()
    await service.synchronizeBackground()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
