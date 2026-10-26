import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { customRules } from '../shared/source-presets.js'
import { normalizeSourceBackground } from '../shared/background.js'

async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`等待超时：${label}`)
}

test('单张图超过像素上限只跳过这一页，不会让整个来源等待一分钟', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'background-asset-failure-')), media = path.join(root, 'media')
  await mkdir(media)
  for (const name of ['bad.jpg', '1.jpg', '2.jpg', '3.jpg']) await writeFile(path.join(media, name), name)
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  process.env.COMPUTE_API_KEY = 'failure-key'
  process.env.BACKGROUND_CONCURRENCY = '2'
  const { saveSources } = await import('../server/config.js')
  const { saveAiSettings, getAiSettings } = await import('../server/ai.js')
  const { db } = await import('../server/database.js')
  const { scanLibrary } = await import('../server/scanner.js')
  const service = await import('../server/background/service.js')
  saveSources([{ id: 's', name: 'Failure', kind: 'custom', path: media, rules: customRules() }])
  const base = getAiSettings()
  saveAiSettings({
    ...base,
    localCompute: { ...base.localCompute, mode: 'remote', baseUrl: 'http://127.0.0.1:3211', fallback: 'error', apiKey: 'failure-key' },
  })
  const done: string[] = []
  try {
    await scanLibrary()
    service.saveBackgroundSettings('s', { ...normalizeSourceBackground(undefined), ocr: true, maxPagesPerDay: 100 })
    await service.synchronizeBackground()
    // 让超限页排在队首，确保旧行为下 60 秒退避会挡住后面的三页。
    const rows = db.prepare('SELECT t.id AS task_id, t.asset_id, a.data FROM background_tasks t JOIN assets a ON a.id=t.asset_id').all() as Array<{ task_id: string; asset_id: string; data: string }>
    const bad = rows.find(row => JSON.parse(row.data).filename === 'bad.jpg')
    assert.ok(bad)
    db.prepare('UPDATE background_tasks SET updated = ? WHERE id = ?').run(1, bad.task_id)
    for (const [index, row] of rows.filter(row => row.task_id !== bad.task_id).entries()) {
      db.prepare('UPDATE background_tasks SET updated = ? WHERE id = ?').run(10 + index, row.task_id)
    }

    await service.runBackgroundTick({
      manga: {
        hasManualMangaWork: () => false,
        runBackgroundMangaAsset: async (asset: { filename: string }) => {
          if (asset.filename === 'bad.jpg') {
            throw Object.assign(new Error('这张图有 47.5 MP，超过单页 40 MP 上限'), { code: 'image_too_large', statusCode: 413, expose: true })
          }
          done.push(asset.filename)
        },
      },
    })
    await waitFor(() => service.backgroundQueue.counts('s').failed === 1 && service.backgroundQueue.counts('s').done === 3, '失败页之后继续处理')
    assert.deepEqual(done.sort(), ['1.jpg', '2.jpg', '3.jpg'])
  } finally {
    service.stopBackgroundRuntime()
    await service.synchronizeBackground()
    db.close()
    delete process.env.BACKGROUND_CONCURRENCY
    delete process.env.COMPUTE_API_KEY
    await rm(root, { recursive: true, force: true })
  }
})
