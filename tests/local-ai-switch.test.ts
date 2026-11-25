import test, { after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import sharp from 'sharp'
import { customRules } from '../shared/source-presets.js'
import { normalizeSourceBackground } from '../shared/background.js'
import type { StoredAsset } from '../server/database.js'

/**
 * 本机 AI 开关，以及「预热过就不要再识别」。
 *
 * 用户点翻译时，预热结果必须直接复用；本机 AI 关闭后，主服务不得再加载 ONNX 会话，
 * 也不能因为「页面还没预热」就悄悄回退到本机算一遍。
 */

const root = mkdtempSync(path.join(os.tmpdir(), 'media-local-ai-'))
process.env.MEDIA_DATA_DIR = path.join(root, 'data')

const { saveAiSettings, getAiSettings, getLocalComputeConfig } = await import('../server/ai.js')
const { db } = await import('../server/database.js')
const { ComicTextDetector } = await import('../server/ai/manga/detector.js')
const { MangaOcrRecognizer } = await import('../server/ai/manga/recognizer.js')
const manga = await import('../server/ai/manga/service.js')
const semantic = await import('../server/semantic/service.js')

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

async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`等待超时：${label}`)
}

test('预热过的页面：点翻译复用 OCR 结果，不再跑本地检测与识别', async t => {
  save({ mangaPipelineMode: 'streaming', localCompute: { mode: 'local', localAiEnabled: true } })
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
  save({ mangaPipelineMode: 'merged', localCompute: { mode: 'local', localAiEnabled: true } })
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

test('关闭本机 AI：本地模式不跑识别、明确报错，语义与后台同时停用', async t => {
  save({ mangaPipelineMode: 'streaming', localCompute: { mode: 'local', localAiEnabled: false } })
  assert.equal(getAiSettings().localCompute.mode, 'local', '保留用户的执行位置偏好')
  assert.equal(getLocalComputeConfig().localAiEnabled, false)

  const { detect, ocr } = mockEngine(t)
  const fetchMock = mockTranslation(t)
  const asset = await makeAsset('disabled-local', '#663322')
  const job = await finished((await manga.startMangaTranslation(asset)).id)
  assert.equal(job.state, 'failed')
  assert.match(job.message || '', /本机 AI 计算已.*关闭/)
  assert.equal(detect.mock.callCount(), 0, '关闭后不得检测')
  assert.equal(ocr.mock.callCount(), 0, '关闭后不得 OCR')
  assert.equal(fetchMock.mock.callCount(), 0, '没有识别结果就不该发翻译请求')

  await t.test('模型状态与语义状态都明确说明本机 AI 已关闭', async () => {
    const status = await manga.getMangaModelStatus()
    assert.equal(status.ready, false)
    assert.match(status.message || '', /本机 AI 计算已.*关闭/)
    const semanticStatus = await semantic.getSemanticProvider().status()
    assert.equal(semanticStatus.ready, false)
    assert.match(semanticStatus.message || '', /本机 AI/)
  })

  await t.test('后台索引、预热与自动翻译暂停，重新开启后自动恢复', async () => {
    const media = path.join(root, 'media')
    await mkdir(media, { recursive: true })
    await writeFile(path.join(media, '1.jpg'), 'test')
    const { saveSources } = await import('../server/config.js')
    const { scanLibrary } = await import('../server/scanner.js')
    const background = await import('../server/background/service.js')
    saveSources([{ id: 's', name: 'Test', kind: 'custom', path: media, rules: customRules() }])
    await scanLibrary()
    background.saveBackgroundSettings('s', { ...normalizeSourceBackground(undefined), ocr: true })
    await background.synchronizeBackground()

    let calls = 0
    const runtime = { manga: { hasManualMangaWork: () => false, runBackgroundMangaAsset: async () => { calls++ } } }
    await background.runBackgroundTick(runtime)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls, 0, '本机 AI 关闭时不得领取后台任务')
    assert.equal(background.getBackgroundStatus().localAiEnabled, false)

    save({ localCompute: { mode: 'local', localAiEnabled: true } })
    await background.runBackgroundTick(runtime)
    await waitFor(() => calls === 1, '重新开启后后台继续')

    background.stopBackgroundRuntime()
    saveSources([])
  })
})
