import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { StoredAsset } from '../server/database.js'

/**
 * 译图缓存查询的快速路径。
 *
 * 旧实现每次自动查询都会读整张原图并计算 SHA-256；现在先做一次 stat 查映射，
 * 只有文件真的变化或强制重译才重新哈希。这组用例用"替换成同样大小的非法字节并
 * 复原修改时间"来证明：快速路径确实没有读文件内容（否则解码/哈希会得到不同结果）。
 */

const testDir = mkdtempSync(path.join(os.tmpdir(), 'media-manga-cache-'))
process.env.MEDIA_DATA_DIR = testDir

const { saveAiSettings } = await import('../server/ai.js')
const { db } = await import('../server/database.js')
const { ComicTextDetector } = await import('../server/ai/manga/detector.js')
const { MangaOcrRecognizer } = await import('../server/ai/manga/recognizer.js')
const { startMangaTranslation, getMangaJob, getAutoMangaTranslation, runBackgroundMangaAsset } = await import('../server/ai/manga/service.js')

after(() => db.close())

async function makeAsset(id: string): Promise<StoredAsset> {
  const imagePath = path.join(testDir, `${id}.png`)
  await sharp({ create: { width: 60, height: 80, channels: 3, background: '#ffffff' } }).png().toFile(imagePath)
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

test('译图自动查询只做 stat，不重复读取原图', async t => {
  saveAiSettings({ baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test-model', targetLanguage: '简体中文', mangaPipelineMode: 'sequential' })
  t.mock.getter(ComicTextDetector.prototype, 'isLoaded', () => true)
  t.mock.getter(MangaOcrRecognizer.prototype, 'isLoaded', () => true)
  const detect = t.mock.method(ComicTextDetector.prototype, 'detect', async () => ({
    pageWidth: 60, pageHeight: 80, textMask: null,
    boxes: [{ cx: 30, cy: 40, width: 24, height: 30, confidence: 0.99, classId: 0 }],
  }))
  t.mock.method(MangaOcrRecognizer.prototype, 'recognizeBatch', async () => [{ text: 'こんにちは', confidence: 0.99 }])
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ translations: ['你好'] }) } }] }))

  const asset = await makeAsset('page')
  const original = await readFile(asset.path)
  const job = await finished((await startMangaTranslation(asset)).id)
  assert.equal(job.state, 'ready')
  assert.equal(job.result?.regions[0]?.translation, '你好')

  await t.test('首次翻译后写入原图指纹', () => {
    const row = db.prepare('SELECT key, size, mtime FROM manga_asset_cache WHERE asset_id = ?').get(asset.id) as
      { key: string; size: number; mtime: number } | undefined
    assert.ok(row, '应记录 asset → 结果 key 的映射')
    assert.equal(row.key, job.result!.key)
    assert.equal(row.size, original.length)
  })

  await t.test('内容被替换但大小与修改时间不变时，仍然直接返回缓存（未重新读取原图）', async () => {
    const info = await stat(asset.path)
    // 同样长度、完全不是图片的字节：只要真的读了内容，就绝不可能命中同一个缓存。
    const decoy = Buffer.alloc(original.length, 7)
    await writeFile(asset.path, decoy)
    await utimes(asset.path, info.atime, info.mtime)
    const detectCalls = detect.mock.callCount()
    const requests = fetchMock.mock.callCount()

    const cached = await getAutoMangaTranslation(asset)
    assert.equal(cached?.cached, true)
    assert.equal(cached?.regions[0]?.translation, '你好')
    assert.equal(detect.mock.callCount(), detectCalls, '自动查询不应触发识别')
    assert.equal(fetchMock.mock.callCount(), requests, '自动查询不应调用翻译接口')
    await writeFile(asset.path, original)
    await utimes(asset.path, info.atime, info.mtime)
  })

  await t.test('内容与修改时间都变化后指纹失效，重新哈希并返回没有缓存', async () => {
    const info = await stat(asset.path)
    // 换成另一张真实图片：尺寸相同但字节不同，哈希必然变化。
    await sharp({ create: { width: 60, height: 80, channels: 3, background: '#334455' } }).png().toFile(asset.path)
    const future = new Date(info.mtimeMs + 5000)
    await utimes(asset.path, future, future)
    assert.equal(await getAutoMangaTranslation(asset), null)
    // 指纹已经回填成新内容对应的 key，下一次查询又回到快速路径。
    const row = db.prepare('SELECT key FROM manga_asset_cache WHERE asset_id = ?').get(asset.id) as { key: string }
    assert.notEqual(row.key, job.result!.key)
    assert.equal(await getAutoMangaTranslation(asset), null)
  })

  await t.test('强制重译会重新读取内容并刷新映射', async () => {
    const before = db.prepare('SELECT content_hash FROM manga_asset_cache WHERE asset_id = ?').get(asset.id) as { content_hash: string }
    // 再换一张图，强制重译必须重新读取内容并写下新的哈希。
    await sharp({ create: { width: 60, height: 80, channels: 3, background: '#996633' } }).png().toFile(asset.path)
    const forced = await finished((await startMangaTranslation(asset, true)).id)
    assert.equal(forced.state, 'ready')
    assert.equal(forced.result?.cached, false)
    const afterRow = db.prepare('SELECT content_hash FROM manga_asset_cache WHERE asset_id = ?').get(asset.id) as { content_hash: string }
    assert.match(afterRow.content_hash, /^[a-f0-9]{64}$/)
    assert.notEqual(afterRow.content_hash, before.content_hash)
    const imagePath = db.prepare('SELECT overlay_path FROM manga_translations WHERE key = ?').get(forced.result!.key) as { overlay_path: string }
    assert.ok(existsSync(imagePath.overlay_path))
  })

  await t.test('流式模式不会因为重复排队而卡住', async () => {
    // 计算入口自己负责串行化；调用方再套一层队列会互相等待，这里回归验证流式模式仍能完成。
    saveAiSettings({ baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test-model', targetLanguage: '简体中文', mangaPipelineMode: 'streaming' })
    const streaming = await makeAsset('streaming')
    const job = await finished((await startMangaTranslation(streaming)).id)
    assert.equal(job.state, 'ready')
    assert.equal(job.result?.regions[0]?.translation, '你好')
  })
})

test('OCR 预热只缓存识别结果，后续翻译只补一次请求', async t => {
  saveAiSettings({
    baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test-model',
    targetLanguage: '简体中文', mangaPipelineMode: 'sequential', mangaAutoShowTranslated: true,
  })
  t.mock.getter(ComicTextDetector.prototype, 'isLoaded', () => true)
  t.mock.getter(MangaOcrRecognizer.prototype, 'isLoaded', () => true)
  const detect = t.mock.method(ComicTextDetector.prototype, 'detect', async () => ({
    pageWidth: 60, pageHeight: 80, textMask: null,
    boxes: [{ cx: 30, cy: 40, width: 24, height: 30, confidence: 0.99, classId: 0 }],
  }))
  t.mock.method(MangaOcrRecognizer.prototype, 'recognizeBatch', async () => [{ text: 'こんにちは', confidence: 0.99 }])
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ translations: ['你好'] }) } }] }))

  const asset = await makeAsset('prewarm')
  // 换成唯一配色的同尺寸图片：缓存 key 只由内容决定，避免命中其它用例的白色底图。
  await sharp({ create: { width: 60, height: 80, channels: 3, background: '#778899' } }).png().toFile(asset.path)
  const warm = await runBackgroundMangaAsset(asset, { translate: false })
  assert.equal(warm.model, 'OCR 预热')
  assert.equal(warm.regions.length, 1)
  assert.equal(warm.regions[0]?.translation, '', '预热结果不能填译文')
  assert.equal(fetchMock.mock.callCount(), 0, '预热不应产生任何翻译费用')

  await t.test('预热结果不会被自动显示当成已翻译缓存', () => {
    const translations = db.prepare('SELECT COUNT(*) AS n FROM manga_translations WHERE key = ?').get(warm.key) as { n: number }
    assert.equal(translations.n, 0, '预热结果不写译文表')
    const prepared = db.prepare('SELECT overlay_path FROM manga_prepared_pages WHERE key = ?').get(warm.key) as { overlay_path: string } | undefined
    assert.ok(prepared && existsSync(prepared.overlay_path))
  })

  await t.test('自动显示返回 null，随后翻译复用预热只补一次网络请求', async () => {
    assert.equal(await getAutoMangaTranslation(asset), null)
    const detectCalls = detect.mock.callCount()
    let billed = 0
    const translated = await runBackgroundMangaAsset(asset, { translate: true, beforeTranslate: () => { billed++ } })
    assert.equal(billed, 1, '每次真实翻译请求只预留一次预算')
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(detect.mock.callCount(), detectCalls, '复用预热结果时不应重新检测')
    assert.equal(translated.model, 'test-model')
    assert.equal(translated.regions[0]?.translation, '你好')
    const auto = await getAutoMangaTranslation(asset)
    assert.equal(auto?.cached, true)
    assert.equal(auto?.regions[0]?.translation, '你好')
  })
})

test('不在资产表里的云端页用 source 路由兜底底图', async t => {
  saveAiSettings({
    baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test-model',
    targetLanguage: '简体中文', mangaPipelineMode: 'sequential',
  })
  t.mock.getter(ComicTextDetector.prototype, 'isLoaded', () => true)
  t.mock.getter(MangaOcrRecognizer.prototype, 'isLoaded', () => true)
  t.mock.method(ComicTextDetector.prototype, 'detect', async () => ({
    pageWidth: 60, pageHeight: 80, textMask: null,
    boxes: [{ cx: 30, cy: 40, width: 24, height: 30, confidence: 0.99, classId: 0 }],
  }))
  t.mock.method(MangaOcrRecognizer.prototype, 'recognizeBatch', async () => [{ text: 'こんにちは', confidence: 0.99 }])
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ translations: ['你好'] }) } }] }))

  // Pixiv 云页的 id 形如 pixiv:<illust>:<page>，不在 assets 表里，
  // 因此 /api/assets/:id/file 必然 404，底图必须走按 key 记录原图路径的路由。
  const asset = await makeAsset('cloud-page')
  await sharp({ create: { width: 60, height: 80, channels: 3, background: '#223344' } }).png().toFile(asset.path)
  const cloud = { ...asset, id: 'pixiv:123456:0', workId: 'pixiv:123456', filename: '123456_p0.png' }
  const job = await finished((await startMangaTranslation(cloud)).id)
  assert.equal(job.state, 'ready')
  const result = job.result!
  assert.equal(result.baseUrl, `/api/ai/manga/cache/${result.key}/source`)
  assert.equal(result.overlayUrl, `/api/ai/manga/cache/${result.key}/overlay.png`)
})
