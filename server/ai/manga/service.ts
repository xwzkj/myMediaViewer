import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { MangaJob, MangaModelStatus, MangaPageResult, MangaRegion } from '../../../shared/types.js'
import { getAiSettings, translateMangaTexts } from '../../ai.js'
import { cacheDir, dataDir } from '../../config.js'
import { db, type StoredAsset } from '../../database.js'
import { ComicTextDetector } from './detector.js'
import { eraseTranslatedRegions } from './erase.js'
import { judgeRegion, mangaReadingOrder, trimTrailingNoise } from './pipeline.js'
import { MangaOcrRecognizer } from './recognizer.js'
import { boxToRect, type OcrRegion } from './types.js'

const modelRoot = path.join(dataDir, 'models')
const mangaCacheDir = path.join(cacheDir, 'manga')
const PIPELINE_VERSION = 1
const MAX_REGIONS = 80

const detector = new ComicTextDetector()
const recognizer = new MangaOcrRecognizer()
let loading: Promise<void> | null = null

interface PreparedAsset {
  key: string
  targetLanguage: string
  cached?: MangaPageResult
}

interface InternalJob extends MangaJob {
  assetIds: string[]
  prepared: Map<string, PreparedAsset>
}
const jobs = new Map<string, InternalJob>()
// 只有真正需要模型的页面才占用这个队列。缓存查询不排队，也不会被 GPU 任务挡住。
let inferenceQueue: Promise<void> = Promise.resolve()

export function getMangaModelStatus(): MangaModelStatus {
  const models = [
    {
      name: 'manga-ocr',
      dir: path.join(modelRoot, 'manga-ocr'),
      files: ['config.json', 'encoder_model_quantized.onnx', 'decoder_model_quantized.onnx', 'vocab.json'],
    },
    {
      name: 'comic-text-detector',
      dir: path.join(modelRoot, 'comic-text-detector'),
      files: ['comictextdetector.pt.onnx'],
    },
  ].map(model => {
    const missing = model.files.filter(file => !existsSync(path.join(model.dir, file)))
    return { name: model.name, ready: missing.length === 0, files: model.files, missing }
  })
  const ready = models.every(model => model.ready)
  return {
    ready,
    device: providers()[0] === 'dml' ? 'DirectML（不可用时回退 CPU）' : 'CPU',
    models,
    message: ready ? undefined : `请把模型文件放到 ${modelRoot}`,
  }
}

export async function startMangaTranslation(input: StoredAsset | StoredAsset[], force = false): Promise<MangaJob> {
  const assets = Array.isArray(input) ? input : [input]
  const seen = new Set<string>()
  const uniqueAssets = assets.filter(asset => {
    if (seen.has(asset.id)) return false
    seen.add(asset.id)
    return true
  })
  if (!uniqueAssets.length) throw new Error('没有可翻译的图片')

  const assetIds = uniqueAssets.map(asset => asset.id).sort()
  const existing = [...jobs.values()].find(job =>
    (job.state === 'queued' || job.state === 'processing')
    && sameAssetIds(job.assetIds, assetIds))
  if (existing) return publicJob(existing)
  const job: InternalJob = {
    id: randomUUID(),
    assetIds,
    state: 'queued',
    stage: uniqueAssets.length > 1 ? `等待翻译 ${uniqueAssets.length} 张图片` : '等待开始',
    progress: 0,
    total: uniqueAssets.length,
    completed: 0,
    results: [],
    failed: [],
    prepared: new Map(),
  }
  jobs.set(job.id, job)

  // 单页请求先做一次缓存 preflight：命中时直接返回 ready，不再进入任务队列。
  if (uniqueAssets.length === 1) {
    const asset = uniqueAssets[0]!
    job.stage = '检查图片缓存'
    try {
      const prepared = await prepareAsset(asset, force)
      job.prepared.set(asset.id, prepared)
      if (prepared.cached) {
        job.result = prepared.cached
        job.results = [{ assetId: asset.id, result: prepared.cached }]
        job.completed = 1
        job.progress = 100
        job.stage = '读取缓存结果'
        job.state = 'ready'
        return publicJob(job)
      }
    } catch (error) {
      job.state = 'failed'
      job.stage = '读取缓存失败'
      job.progress = 100
      job.message = error instanceof Error ? error.message : '读取漫画缓存失败'
      return publicJob(job)
    }
  }

  void runJob(job, uniqueAssets, force)
  return publicJob(job)
}

export function getMangaJob(id: string): MangaJob | undefined {
  const job = jobs.get(id)
  return job ? publicJob(job) : undefined
}

export function mangaBaseImagePath(key: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(key)) return undefined
  const row = db.prepare('SELECT image_path FROM manga_translations WHERE key = ?').get(key) as { image_path: string | null } | undefined
  return row?.image_path && existsSync(row.image_path) ? row.image_path : undefined
}

async function runJob(job: InternalJob, assets: StoredAsset[], force: boolean): Promise<void> {
  job.state = 'processing'
  try {
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i]!
      const prefix = assets.length > 1 ? `第 ${i + 1}/${assets.length} 张 · ` : ''
      const setStage = (stage: string) => { job.stage = `${prefix}${stage}` }
      job.currentAssetId = asset.id
      job.completed = i
      setStage('准备翻译')
      try {
        const result = await processAsset(asset, force, setStage, job.prepared.get(asset.id))
        if (!job.results) job.results = []
        job.results.push({ assetId: asset.id, result })
        if (assets.length === 1) job.result = result
      } catch (error) {
        if (!job.failed) job.failed = []
        job.failed.push({ assetId: asset.id, message: error instanceof Error ? error.message : '漫画图片翻译失败' })
        setStage('翻译失败，继续下一张')
      }
      job.completed = i + 1
      job.progress = Math.round(job.completed / assets.length * 100)
    }

    if (!job.results?.length) {
      const first = job.failed?.[0]?.message || '漫画图片翻译失败'
      throw new Error(first)
    }
    if (job.failed?.length) {
      job.stage = `完成，${job.failed.length}/${job.total} 张翻译失败`
      job.message = `有 ${job.failed.length} 张图片翻译失败`
    } else {
      job.stage = assets.length > 1 ? '整部翻译完成' : '完成'
    }
    job.progress = 100
    job.state = 'ready'
  } catch (error) {
    job.state = 'failed'
    job.stage = '翻译失败'
    job.progress = 100
    job.message = error instanceof Error ? error.message : '漫画图片翻译失败'
  }
}

async function processAsset(
  asset: StoredAsset,
  force: boolean,
  setStage: (stage: string) => void,
  prepared?: PreparedAsset,
): Promise<MangaPageResult> {
  const info = prepared || await prepareAsset(asset, force)
  if (info.cached) {
    setStage('读取缓存结果')
    return info.cached
  }

  setStage('等待本地识别资源')
  return runInference(() => processUncachedAsset(asset, info.key, info.targetLanguage, setStage))
}

async function processUncachedAsset(
  asset: StoredAsset,
  key: string,
  targetLanguage: string,
  setStage: (stage: string) => void,
): Promise<MangaPageResult> {
  const status = getMangaModelStatus()
  if (!status.ready) throw new Error(status.message || '本地漫画 OCR 模型未就绪')
  setStage('加载本地识别模型')
  await ensureModels()

  setStage('识别气泡区域')
  const detection = await detector.detect(asset.path)
  if (!detection.boxes.length) {
    setStage('没有检测到气泡文字')
    return emptyResult(asset, key, targetLanguage)
  }

  setStage(`准备提取 ${detection.boxes.length} 处气泡文本`)
  const pageRaw = await sharp(asset.path, { limitInputPixels: 500_000_000 })
    .removeAlpha().toColourspace('srgb').raw().toBuffer()
  const crops = detection.boxes.map(box => paddedRect(boxToRect(box, detection.pageWidth, detection.pageHeight), detection.pageWidth, detection.pageHeight))
  setStage(`提取气泡文本 0/${crops.length}`)
  const ocrResults = await recognizer.recognizeBatch(
    pageRaw,
    detection.pageWidth,
    detection.pageHeight,
    crops,
    (completed, total) => setStage(`提取气泡文本 ${completed}/${total}`),
  )

  setStage('筛选气泡文本')
  const candidates: OcrRegion[] = detection.boxes.map((box, index) => ({
    text: trimTrailingNoise(ocrResults[index]?.text || ''),
    cx: box.cx, cy: box.cy, width: box.width, height: box.height,
    prob: box.confidence,
    confidence: ocrResults[index]?.confidence || 0,
  }))
  const shortEdge = Math.min(detection.pageWidth, detection.pageHeight)
  const kept = mangaReadingOrder(candidates.filter(region => judgeRegion(region, shortEdge).keep)).slice(0, MAX_REGIONS)
  if (!kept.length) {
    setStage('没有可翻译的气泡文本')
    return emptyResult(asset, key, targetLanguage)
  }

  setStage(`AI 翻译 ${kept.length} 处文字`)
  const translated = await translateMangaTexts({ texts: kept.map(region => region.text), targetLanguage })
  setStage('擦除原文')
  const eraseRegions = kept.map(region => boxToRect({ ...region, classId: 0 }, detection.pageWidth, detection.pageHeight))
  const erased = await eraseTranslatedRegions(asset.path, detection.pageWidth, detection.pageHeight, detection.textMask, eraseRegions)
  await mkdir(mangaCacheDir, { recursive: true })
  const imagePath = path.join(mangaCacheDir, `${key}.png`)
  const temp = `${imagePath}.tmp.png`
  setStage('生成译图文件')
  try {
    await sharp(erased.data, { raw: { width: erased.width, height: erased.height, channels: 3 } })
      .png({ compressionLevel: 7, adaptiveFiltering: true })
      .toFile(temp)
    await rename(temp, imagePath)
  } finally {
    await unlink(temp).catch(() => {})
  }

  const regions: MangaRegion[] = kept.map((region, index) => {
    const rect = eraseRegions[index]!
    return {
      id: index + 1,
      x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      source: region.text,
      translation: translated.translations[index] || region.text,
      detection: region.prob,
      confidence: region.confidence,
      background: erased.colors[index]?.background || '#ffffff',
      textColor: erased.colors[index]?.textColor || '#111111',
    }
  })
  const result: MangaPageResult = {
    key,
    width: detection.pageWidth,
    height: detection.pageHeight,
    baseUrl: `/api/ai/manga/cache/${key}/base.png`,
    regions,
    cached: false,
    model: translated.model,
    targetLanguage: translated.targetLanguage,
    createdAt: Date.now(),
  }
  db.prepare('INSERT OR REPLACE INTO manga_translations (key, data, image_path, created) VALUES (?, ?, ?, ?)')
    .run(key, JSON.stringify(result), imagePath, result.createdAt)
  setStage('完成')
  return result
}

async function prepareAsset(asset: StoredAsset, force: boolean): Promise<PreparedAsset> {
  const hash = createHash('sha256').update(await readFile(asset.path)).digest('hex')
  const targetLanguage = getAiSettings().targetLanguage
  const key = createHash('sha256').update(JSON.stringify({ version: PIPELINE_VERSION, hash, targetLanguage })).digest('hex')
  const cached = force ? undefined : readCachedResult(key)
  return { key, targetLanguage, cached }
}

/** 只把真正需要模型/翻译/擦字的页面串行化；缓存查询可以在队列外立即完成。 */
function runInference<T>(task: () => Promise<T>): Promise<T> {
  const result = inferenceQueue.then(task, task)
  inferenceQueue = result.then(() => undefined, () => undefined)
  return result
}

async function ensureModels(): Promise<void> {
  if (detector.isLoaded && recognizer.isLoaded) return
  if (!loading) {
    loading = Promise.all([
      detector.load(path.join(modelRoot, 'comic-text-detector', 'comictextdetector.pt.onnx'), { executionProviders: providers() }),
      recognizer.load(path.join(modelRoot, 'manga-ocr'), { encoderProviders: providers(), decoderProviders: ['cpu'] }),
    ]).then(() => undefined).finally(() => { loading = null })
  }
  return loading
}

function providers(): string[] {
  return process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu']
}

function paddedRect(rect: { left: number; top: number; width: number; height: number }, pageWidth: number, pageHeight: number) {
  const padding = Math.max(3, Math.round(Math.min(rect.width, rect.height) * 0.04))
  const left = Math.max(0, rect.left - padding)
  const top = Math.max(0, rect.top - padding)
  const right = Math.min(pageWidth, rect.left + rect.width + padding)
  const bottom = Math.min(pageHeight, rect.top + rect.height + padding)
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

function emptyResult(asset: StoredAsset, key: string, targetLanguage: string): MangaPageResult {
  return {
    key,
    width: 0,
    height: 0,
    baseUrl: `/api/assets/${asset.id}/file`,
    regions: [],
    cached: false,
    model: '',
    targetLanguage,
    createdAt: Date.now(),
  }
}

function readCachedResult(key: string): MangaPageResult | undefined {
  const row = db.prepare('SELECT data, image_path FROM manga_translations WHERE key = ?').get(key) as { data: string; image_path: string | null } | undefined
  if (!row) return undefined
  if (row.image_path && !existsSync(row.image_path)) {
    db.prepare('DELETE FROM manga_translations WHERE key = ?').run(key)
    return undefined
  }
  try {
    return { ...(JSON.parse(row.data) as MangaPageResult), cached: true }
  } catch {
    db.prepare('DELETE FROM manga_translations WHERE key = ?').run(key)
    return undefined
  }
}

function sameAssetIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function publicJob(job: InternalJob): MangaJob {
  return {
    id: job.id,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    total: job.total,
    completed: job.completed,
    ...(job.currentAssetId ? { currentAssetId: job.currentAssetId } : {}),
    ...(job.message ? { message: job.message } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.results?.length ? { results: job.results.map(item => ({ assetId: item.assetId, result: item.result })) } : {}),
    ...(job.failed?.length ? { failed: job.failed.map(item => ({ assetId: item.assetId, message: item.message })) } : {}),
  }
}
