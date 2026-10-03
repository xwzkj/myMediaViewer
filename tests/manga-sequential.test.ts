import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { setImmediate as nextTurn } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { StoredAsset } from '../server/database.js'

const testDir = mkdtempSync(path.join(os.tmpdir(), 'media-manga-sequential-'))
process.env.MEDIA_DATA_DIR = testDir
const { saveAiSettings } = await import('../server/ai.js')
const { db } = await import('../server/database.js')
const { ComicTextDetector } = await import('../server/ai/manga/detector.js')
const { MangaOcrRecognizer } = await import('../server/ai/manga/recognizer.js')
const { startMangaTranslation, getMangaJob, mangaBaseImagePath } = await import('../server/ai/manga/service.js')
after(() => db.close())

async function asset(id: string, color: string): Promise<StoredAsset> {
  const imagePath = path.join(testDir, `${id}.png`)
  await sharp({ create: { width: 80, height: 100, channels: 3, background: color } }).png().toFile(imagePath)
  return { id, path: imagePath, workId: 'test', filename: `${id}.png`, page: 0, kind: 'image', extension: 'png', size: 0, modified: 0, display: true }
}

async function finished(id: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const job = getMangaJob(id)!
    if (job.state === 'ready' || job.state === 'failed') return job
    await nextTurn()
  }
  throw new Error('测试任务未在时限内完成')
}

test('逐页模式复用识别和回填，保持串行、缓存、空页和失败隔离', async t => {
  saveAiSettings({ baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test-model', targetLanguage: '简体中文', mangaPipelineMode: 'sequential' })
  t.mock.getter(ComicTextDetector.prototype, 'isLoaded', () => true)
  t.mock.getter(MangaOcrRecognizer.prototype, 'isLoaded', () => true)
  let empty = false
  let filtered = false
  let failPath = ''
  let changedSizePath = ''
  let failTranslationOnce = false
  const events: string[] = []
  let beforeDetect: (() => void) | undefined
  const detect = t.mock.method(ComicTextDetector.prototype, 'detect', async (imagePath: string) => {
    beforeDetect?.()
    events.push(`detect:${path.basename(imagePath)}`)
    if (imagePath === failPath) throw new Error('模拟识别失败')
    return { pageWidth: imagePath === changedSizePath ? 81 : 80, pageHeight: 100, textMask: null, boxes: empty ? [] : [
      { cx: 40, cy: 50, width: 30, height: 40, confidence: 0.99, classId: 0 },
    ] }
  })
  t.mock.method(MangaOcrRecognizer.prototype, 'recognizeBatch', async () => [{ text: filtered ? '...' : 'こんにちは', confidence: 0.99 }])
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    events.push('translate')
    if (failTranslationOnce) {
      failTranslationOnce = false
      return Response.json({ error: { message: '模拟模型拒绝请求' } }, { status: 400 })
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: ['你好'] }) } }] })
  })

  const first = await asset('first', '#ffffff')
  const second = await asset('second', '#eeeeee')
  await t.test('下一页识别开始前，上一页已经生成底图并写入缓存', async () => {
    beforeDetect = () => {
      if (events.includes('translate')) {
        const row = db.prepare('SELECT image_path FROM manga_translations').get() as { image_path: string }
        assert.ok(row && existsSync(row.image_path), '下一页识别前应完成前一页回填')
      }
    }
    const job = await finished((await startMangaTranslation([first, second])).id)
    beforeDetect = undefined
    assert.equal(job.state, 'ready')
    assert.equal(job.completed, 2)
    assert.deepEqual(events, ['detect:first.png', 'translate', 'detect:second.png', 'translate'])
    assert.deepEqual(job.results?.map(item => item.assetId), ['first', 'second'])
    for (const { result } of job.results!) {
      assert.equal(result.regions[0]?.source, 'こんにちは')
      assert.equal(result.regions[0]?.translation, '你好')
      assert.equal(result.model, 'test-model')
      assert.equal(result.targetLanguage, '简体中文')
      assert.equal((await sharp(mangaBaseImagePath(result.key)!).metadata()).width, 80)
    }
  })

  await t.test('缓存命中跳过识别和模型请求，强制重译重新执行', async () => {
    const calls = detect.mock.callCount()
    const requests = fetchMock.mock.callCount()
    const cached = await startMangaTranslation(first)
    assert.equal(cached.state, 'ready')
    assert.equal(cached.result?.cached, true)
    assert.equal(detect.mock.callCount(), calls)
    assert.equal(fetchMock.mock.callCount(), requests)
    const forced = await finished((await startMangaTranslation(first, true)).id)
    assert.equal(forced.result?.cached, false)
    assert.equal(detect.mock.callCount(), calls + 1)
    assert.equal(fetchMock.mock.callCount(), requests + 1)
  })

  await t.test('未检测到文本和筛选后无文本均不调用翻译', async () => {
    const requests = fetchMock.mock.callCount()
    empty = true
    const noBoxes = await finished((await startMangaTranslation(first, true)).id)
    empty = false
    filtered = true
    const noText = await finished((await startMangaTranslation(second, true)).id)
    filtered = false
    for (const job of [noBoxes, noText]) {
      assert.equal(job.state, 'ready')
      assert.deepEqual(job.result?.regions, [])
      assert.equal(job.completed, 1)
    }
    assert.equal(fetchMock.mock.callCount(), requests)
  })

  await t.test('单页识别失败后继续下一页', async () => {
    failPath = first.path
    const job = await finished((await startMangaTranslation([first, second], true)).id)
    assert.equal(job.state, 'ready')
    assert.equal(job.completed, 2)
    assert.deepEqual(job.failed, [{ assetId: first.id, message: '模拟识别失败' }])
    assert.deepEqual(job.results?.map(item => item.assetId), [second.id])
    failPath = ''
  })

  await t.test('模型调用和回填失败均只影响当前页', async () => {
    failTranslationOnce = true
    const translationFailed = await finished((await startMangaTranslation([first, second], true)).id)
    changedSizePath = first.path
    const finalizeFailed = await finished((await startMangaTranslation([first, second], true)).id)
    changedSizePath = ''
    for (const job of [translationFailed, finalizeFailed]) {
      assert.equal(job.state, 'ready')
      assert.equal(job.completed, 2)
      assert.equal(job.failed?.length, 1)
      assert.equal(job.failed?.[0]?.assetId, first.id)
      assert.deepEqual(job.results?.map(item => item.assetId), [second.id])
    }
    assert.match(finalizeFailed.failed![0]!.message, /图片尺寸在检测后发生变化/)
  })
})
