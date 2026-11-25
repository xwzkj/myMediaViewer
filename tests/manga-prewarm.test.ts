import test, { after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import sharp from 'sharp'
import type { StoredAsset } from '../server/database.js'

/**
 * 预热过的页面，点翻译时只能补在线请求。
 *
 * 预热缓存本来就是为了跳过检测 / OCR；此前只有逐页模式复用预热结果，默认的
 * 「边识别边并发翻译」和合并 / 并发模式会重新跑一遍本地识别。
 */

const root = mkdtempSync(path.join(os.tmpdir(), 'media-manga-prewarm-'))
process.env.MEDIA_DATA_DIR = path.join(root, 'data')

const { saveAiSettings } = await import('../server/ai.js')
const { db } = await import('../server/database.js')
const { ComicTextDetector } = await import('../server/ai/manga/detector.js')
const { MangaOcrRecognizer } = await import('../server/ai/manga/recognizer.js')
const manga = await import('../server/ai/manga/service.js')

after(async () => {
  db.close()
  await rm(root, { recursive: true, force: true })
})

const base = {
  baseUrl: 'https://example.com/v1',
  apiKey: 'test',
  model: 'test-model',
  targetLanguage: '简体中文',
}

function save(patch: Record<string, unknown> = {}) {
  saveAiSettings({ ...base, ...patch })
}

/** 假的本地识别：只数调用次数，不加载任何 ONNX 模型。 */
function mockEngine(t: TestContext) {
  t.mock.getter(ComicTextDetector.prototype, 'isLoaded', () => true)
  t.mock.getter(MangaOcrRecognizer.prototype, 'isLoaded', () => true)
  const detect = t.mock.method(ComicTextDetector.prototype, 'detect', async () => ({
    pageWidth: 60, pageHeight: 80, textMask: null,
    boxes: [{ cx: 30, cy: 40, width: 24, height: 30, confidence: 0.99, classId: 0 }],
  }))
  const ocr = t.mock.method(MangaOcrRecognizer.prototype, 'recognizeBatch', async () => [{ text: 'こんにちは', confidence: 0.99 }])
  return { detect, ocr }
}

function mockTranslation(t: TestContext, translations: string[] = ['你好']) {
  return t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }))
}

async function makeAsset(id: string, color = '#ffffff'): Promise<StoredAsset> {
  const imagePath = path.join(root, `${id}.png`)
  await sharp({ create: { width: 60, height: 80, channels: 3, background: color } }).png().toFile(imagePath)
  return {
    id, path: imagePath, workId: 'test', filename: `${id}.png`, page: 0,
    kind: 'image', extension: 'png', size: 0, modified: 0, display: true,
  }
}

async function finished(id: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const job = manga.getMangaJob(id)!
    if (job.state === 'ready' || job.state === 'failed') return job
    await nextTurn()
  }
  throw new Error('测试任务未在时限内完成')
}

test('预热过的页面：点翻译复用 OCR 结果，不再跑本地检测与识别', async t => {
  save({ mangaPipelineMode: 'streaming' })
  const { detect, ocr } = mockEngine(t)
  const fetchMock = mockTranslation(t)
  const asset = await makeAsset('warm-streaming')

  const warmed = await manga.runBackgroundMangaAsset(asset, { translate: false })
  assert.equal(warmed.regions.length, 1)
  assert.equal(warmed.model, 'OCR 预热')
  assert.equal(detect.mock.callCount(), 1)
  assert.equal(ocr.mock.callCount(), 1)
  assert.equal(fetchMock.mock.callCount(), 0, '预热只识别，不调用在线翻译')

  const job = await finished((await manga.startMangaTranslation(asset)).id)
  assert.equal(job.state, 'ready')
  assert.equal(job.result?.regions[0]?.translation, '你好')
  assert.equal(detect.mock.callCount(), 1, '预热后点翻译不得重新检测')
  assert.equal(ocr.mock.callCount(), 1, '预热后点翻译不得重新 OCR')
})

test('先批量识别再合并翻译：同样复用预热结果', async t => {
  save({ mangaPipelineMode: 'merged' })
  const { detect, ocr } = mockEngine(t)
  const fetchMock = mockTranslation(t)
  const asset = await makeAsset('warm-merged', '#224466')

  await manga.runBackgroundMangaAsset(asset, { translate: false })
  assert.equal(detect.mock.callCount(), 1)
  assert.equal(ocr.mock.callCount(), 1)

  const job = await finished((await manga.startMangaTranslation(asset)).id)
  assert.equal(job.state, 'ready')
  assert.equal(job.result?.regions[0]?.translation, '你好')
  assert.equal(detect.mock.callCount(), 1, '合并模式也不能重新识别预热过的页面')
  assert.equal(ocr.mock.callCount(), 1)
  assert.equal(fetchMock.mock.callCount(), 1)
})
