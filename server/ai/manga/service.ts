import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { MangaJob, MangaModelStatus, MangaPageResult, MangaPipelineMode, MangaRegion } from '../../../shared/types.js'
import { getAiSettings, translateMangaTexts } from '../../ai.js'
import { cacheDir, dataDir } from '../../config.js'
import { db, type StoredAsset } from '../../database.js'
import { ComicTextDetector } from './detector.js'
import { eraseTranslatedRegions, type EraseRegion } from './erase.js'
import { judgeRegion, mangaReadingOrder, trimTrailingNoise } from './pipeline.js'
import { MangaOcrRecognizer } from './recognizer.js'
import { formatDuration, logError, logInfo } from '../../log.js'
import { boxToRect, paddedRect, type OcrRegion, type TextMask } from './types.js'
import { alternateEncoder, decoderModel, detectorModel, ensureMangaModels, hasModel, missingModels, modelPath, modelRoot, preferredEncoder, vocabModel } from './models.js'

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
/** 日志里用短编号指代任务，长 UUID 只会占地方。 */
const jobLabel = (job: InternalJob) => `漫画翻译 #${job.id.slice(0, 6)}`
// 只有真正需要模型的页面才占用这个队列。缓存查询不排队，也不会被 GPU 任务挡住。
let inferenceQueue: Promise<void> = Promise.resolve()

/**
 * 模型是否就位。encoder 有两个变体，装任意一个即可，所以单独判断，
 * 不能直接套用 requiredModels()（那里面只列了首选变体）。
 */
export function getMangaModelStatus(): MangaModelStatus {
  const preferred = preferredEncoder()
  const alternate = alternateEncoder()
  const encoderReady = hasModel(preferred) || hasModel(alternate)
  const encoderNames = [path.basename(preferred.target), path.basename(alternate.target)]
  const detectorReady = hasModel(detectorModel)
  const decoderReady = hasModel(decoderModel)
  const vocabReady = hasModel(vocabModel)

  const detectorFiles = [path.basename(detectorModel.target)]
  const ocrFiles = [...encoderNames, path.basename(decoderModel.target), path.basename(vocabModel.target)]
  const detectorMissing = detectorReady ? [] : detectorFiles
  const ocrMissing = [
    ...(encoderReady ? [] : encoderNames),
    ...(decoderReady ? [] : [path.basename(decoderModel.target)]),
    ...(vocabReady ? [] : [path.basename(vocabModel.target)]),
  ]

  const models = [
    { name: 'comic-text-detector', ready: detectorReady, files: detectorFiles, missing: detectorMissing },
    { name: 'manga-ocr', ready: encoderReady && decoderReady && vocabReady, files: ocrFiles, missing: ocrMissing },
  ]
  const ready = models.every(model => model.ready)
  return {
    ready,
    device: providers()[0] === 'dml' ? 'DirectML（不可用时回退 CPU）' : 'CPU',
    models,
    message: ready ? undefined : `首次翻译会自动下载模型到 ${modelRoot}；网络不通时设置 HF_ENDPOINT 指向镜像站`,
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
        logInfo('任务', `${jobLabel(job)} 命中缓存，直接返回`)
        return publicJob(job)
      }
    } catch (error) {
      job.state = 'failed'
      job.stage = '读取缓存失败'
      job.progress = 100
      job.message = error instanceof Error ? error.message : '读取漫画缓存失败'
      logError('任务', `${jobLabel(job)} 读取缓存失败：${job.message}`)
      return publicJob(job)
    }
  }

  logInfo('任务', `${jobLabel(job)} 入队 · ${job.total} 张图片${force ? ' · 强制重译' : ''}`)
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

/**
 * 单页的本地识别结果（检测 + OCR + 筛选后的待翻译文本）。
 * 批量模式下先收集这些结果，再统一进入翻译阶段。
 */
interface PreparedPage {
  asset: StoredAsset
  key: string
  targetLanguage: string
  pageWidth: number
  pageHeight: number
  textMask: TextMask | null
  kept: OcrRegion[]
  eraseRegions: EraseRegion[]
  detectionMs: number
  ocrMs: number
  /** 没有可翻译文本时直接落库的空结果。 */
  empty?: MangaPageResult
}

/**
 * 三种流水线模式共用「本地识别」这一段：检测 + OCR + 筛选。
 * 不涉及大模型调用，也不写任何缓存。
 */
async function recognizePage(asset: StoredAsset, info: PreparedAsset, setStage: (stage: string) => void): Promise<PreparedPage> {
  setStage('准备本地识别模型')
  await ensureModels(setStage)

  setStage('识别气泡区域')
  const detectStarted = Date.now()
  const detection = await detector.detect(asset.path)
  const detectionMs = Date.now() - detectStarted
  if (!detection.boxes.length) {
    setStage('没有检测到气泡文字')
    return {
      asset, key: info.key, targetLanguage: info.targetLanguage,
      pageWidth: detection.pageWidth, pageHeight: detection.pageHeight,
      textMask: detection.textMask, kept: [], eraseRegions: [],
      detectionMs, ocrMs: 0,
      empty: emptyResult(asset, info.key, info.targetLanguage),
    }
  }

  setStage(`准备提取 ${detection.boxes.length} 处气泡文本`)
  const pageRaw = await sharp(asset.path, { limitInputPixels: 500_000_000 })
    .removeAlpha().toColourspace('srgb').raw().toBuffer()
  const crops = detection.boxes.map(box => paddedRect(boxToRect(box, detection.pageWidth, detection.pageHeight), detection.pageWidth, detection.pageHeight))
  setStage(`提取气泡文本 0/${crops.length}`)
  const ocrStarted = Date.now()
  const ocrResults = await recognizer.recognizeBatch(
    pageRaw,
    detection.pageWidth,
    detection.pageHeight,
    crops,
    (completed, total) => setStage(`提取气泡文本 ${completed}/${total}`),
  )
  const ocrMs = Date.now() - ocrStarted

  setStage('筛选气泡文本')
  const candidates: OcrRegion[] = detection.boxes.map((box, index) => ({
    text: trimTrailingNoise(ocrResults[index]?.text || ''),
    cx: box.cx, cy: box.cy, width: box.width, height: box.height,
    prob: box.confidence,
    confidence: ocrResults[index]?.confidence || 0,
  }))
  const shortEdge = Math.min(detection.pageWidth, detection.pageHeight)
  const kept = mangaReadingOrder(candidates.filter(region => judgeRegion(region, shortEdge).keep)).slice(0, MAX_REGIONS)
  const eraseRegions = kept.map(region => boxToRect({ ...region, classId: 0 }, detection.pageWidth, detection.pageHeight))

  return {
    asset, key: info.key, targetLanguage: info.targetLanguage,
    pageWidth: detection.pageWidth, pageHeight: detection.pageHeight,
    textMask: detection.textMask, kept, eraseRegions, detectionMs, ocrMs,
    empty: kept.length ? undefined : emptyResult(asset, info.key, info.targetLanguage),
  }
}

/** 把一页的译文写进缓存并返回最终结果（擦字 + 生成译图底图）。 */
async function finalizePage(page: PreparedPage, translations: string[], model: string): Promise<MangaPageResult> {
  if (page.empty) return page.empty
  const erased = await eraseTranslatedRegions(page.asset.path, page.pageWidth, page.pageHeight, page.textMask, page.eraseRegions)
  await mkdir(mangaCacheDir, { recursive: true })
  const imagePath = path.join(mangaCacheDir, `${page.key}.png`)
  const temp = `${imagePath}.tmp.png`
  try {
    await sharp(erased.data, { raw: { width: erased.width, height: erased.height, channels: 3 } })
      .png({ compressionLevel: 7, adaptiveFiltering: true })
      .toFile(temp)
    await rename(temp, imagePath)
  } finally {
    await unlink(temp).catch(() => {})
  }

  const regions: MangaRegion[] = page.kept.map((region, index) => {
    const rect = page.eraseRegions[index]!
    return {
      id: index + 1,
      x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      source: region.text,
      translation: translations[index] || region.text,
      detection: region.prob,
      confidence: region.confidence,
      background: erased.colors[index]?.background || '#ffffff',
      textColor: erased.colors[index]?.textColor || '#111111',
    }
  })
  const result: MangaPageResult = {
    key: page.key,
    width: page.pageWidth,
    height: page.pageHeight,
    baseUrl: `/api/ai/manga/cache/${page.key}/base.png`,
    regions,
    cached: false,
    model,
    targetLanguage: page.targetLanguage,
    createdAt: Date.now(),
  }
  db.prepare('INSERT OR REPLACE INTO manga_translations (key, data, image_path, created) VALUES (?, ?, ?, ?)')
    .run(page.key, JSON.stringify(result), imagePath, result.createdAt)
  return result
}

/**
 * merged 模式：所有页共用一次大模型调用（超过单次上限时分块）。
 * 把每页文本拍平成一个数组，模型只回一个等长数组，再按各页长度切回去。
 */
async function translateMerged(pages: PreparedPage[], setStage: (stage: string) => void): Promise<{ translations: string[]; model: string }> {
  const pending = pages.filter(page => !page.empty)
  if (!pending.length) return { translations: [], model: '' }
  const targetLanguage = pending[0]!.targetLanguage
  const texts: string[] = []
  for (const page of pending) texts.push(...page.kept.map(region => region.text))

  // 单次请求的文本量上限：太长容易被模型的输出长度或超时截断，按批切开。
  const CHUNK = 200
  const translations: string[] = []
  const chunks = Math.ceil(texts.length / CHUNK)
  let model = ''
  for (let i = 0; i < texts.length; i += CHUNK) {
    const part = texts.slice(i, i + CHUNK)
    setStage(chunks > 1
      ? `AI 合并翻译 ${texts.length} 处文字（第 ${Math.floor(i / CHUNK) + 1}/${chunks} 批）`
      : `AI 合并翻译 ${texts.length} 处文字`)
    const translated = await translateMangaTexts({ texts: part, targetLanguage })
    translations.push(...translated.translations)
    model = translated.model
  }
  return { translations, model }
}

/**
 * parallel 模式：每页各发一个请求，用信号量把并发数限制在设置值内。
 * 结果按页写回，顺序与输入一致。
 */
async function translateParallel(
  pages: PreparedPage[],
  concurrency: number,
  setStage: (stage: string) => void,
  onPageDone: (done: number, total: number) => void,
): Promise<Array<{ translations: string[]; model: string } | { error: string }>> {
  const results = new Array<{ translations: string[]; model: string } | { error: string }>(pages.length)
  let next = 0
  let done = 0
  const total = pages.filter(page => !page.empty).length
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, async () => {
    while (true) {
      const index = next++
      if (index >= pages.length) return
      const page = pages[index]!
      if (page.empty) { results[index] = { translations: [], model: '' }; continue }
      try {
        const translated = await translateMangaTexts({
          texts: page.kept.map(region => region.text),
          targetLanguage: page.targetLanguage,
        })
        results[index] = { translations: translated.translations, model: translated.model }
      } catch (error) {
        // 单页失败不打断其他页：记录原因，继续处理后面的图片。
        results[index] = { error: error instanceof Error ? error.message : '翻译失败' }
      }
      done++
      onPageDone(done, total)
    }
  })
  setStage(`AI 并发翻译 ${total} 张图片（并发 ${concurrency}）`)
  await Promise.all(workers)
  return results
}
async function runJob(job: InternalJob, assets: StoredAsset[], force: boolean): Promise<void> {
  job.state = 'processing'
  const jobStarted = Date.now()
  const mode = getAiSettings().mangaPipelineMode
  logInfo('任务', `${jobLabel(job)} 开始处理 · 共 ${assets.length} 张 · 模式 ${modeLabel(mode)}`)
  try {
    if (mode === 'sequential') await runSequential(job, assets, force)
    else await runBatched(job, assets, force, mode)
    finishJob(job, assets.length, jobStarted)
  } catch (error) {
    job.state = 'failed'
    job.stage = '翻译失败'
    job.progress = 100
    job.message = error instanceof Error ? error.message : '漫画图片翻译失败'
    // 逐张失败已经单独记录过原因，这里只为任务级异常补一条。
    if (!job.failed?.length) logError('任务', `${jobLabel(job)} 失败：${job.message}`)
  }
}

function modeLabel(mode: MangaPipelineMode): string {
  return mode === 'merged' ? '先批量识别再合并翻译'
    : mode === 'parallel' ? '先批量识别再并发翻译'
    : '逐页处理'
}

/** 任务收尾：汇总成功 / 失败，写入最终状态。 */
function finishJob(job: InternalJob, total: number, startedAt: number): void {
  if (!job.results?.length) {
    const first = job.failed?.[0]?.message || '漫画图片翻译失败'
    throw new Error(first)
  }
  const elapsed = formatDuration(Date.now() - startedAt)
  if (job.failed?.length) {
    job.stage = `完成，${job.failed.length}/${job.total} 张翻译失败`
    job.message = `有 ${job.failed.length} 张图片翻译失败`
    logError('任务', `${jobLabel(job)} 结束 · 成功 ${job.results?.length || 0}/${job.total} 张，失败 ${job.failed.length} 张 · 用时 ${elapsed}`)
  } else {
    job.stage = total > 1 ? '整部翻译完成' : '完成'
    logInfo('任务', `${jobLabel(job)} 全部完成 · ${job.total} 张 · 用时 ${elapsed}`)
  }
  job.progress = 100
  job.state = 'ready'
}

/** 原逻辑：一页走完「检测 → OCR → 翻译 → 回填」再处理下一页。 */
async function runSequential(job: InternalJob, assets: StoredAsset[], force: boolean): Promise<void> {
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]!
    const prefix = assets.length > 1 ? `第 ${i + 1}/${assets.length} 张 · ` : ''
    const setStage = (stage: string) => { job.stage = `${prefix}${stage}` }
    const assetStarted = Date.now()
    job.currentAssetId = asset.id
    job.completed = i
    setStage('准备翻译')
    try {
      const result = await processAsset(asset, force, setStage, job.prepared.get(asset.id))
      if (!job.results) job.results = []
      job.results.push({ assetId: asset.id, result })
      if (assets.length === 1) job.result = result
      const detail = result.cached ? '命中缓存' : `${result.regions.length} 处文本`
      logInfo('任务', `${jobLabel(job)} ${prefix}完成 · ${detail} · 用时 ${formatDuration(Date.now() - assetStarted)}`)
    } catch (error) {
      recordFailure(job, asset, error, setStage, prefix)
    }
    job.completed = i + 1
    job.progress = Math.round(job.completed / assets.length * 100)
  }
}

/**
 * 批量模式：先把所有页的检测与 OCR 跑完，再进入翻译阶段。
 * merged 把所有文本合并成尽量少的几次调用；parallel 按页并发、受并发数限制。
 */
async function runBatched(job: InternalJob, assets: StoredAsset[], force: boolean, mode: MangaPipelineMode): Promise<void> {
  // ── 阶段一：本地识别（检测 + OCR）──
  const prepared: PreparedPage[] = []
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]!
    const prefix = `第 ${i + 1}/${assets.length} 张 · `
    job.currentAssetId = asset.id
    job.stage = `${prefix}准备翻译`
    try {
      const info = job.prepared.get(asset.id) || await prepareAsset(asset, force)
      if (info.cached) {
        // 已缓存的页不需要重新识别，直接算完成。
        prepared.push({
          asset, key: info.key, targetLanguage: info.targetLanguage,
          pageWidth: 0, pageHeight: 0, textMask: null, kept: [], eraseRegions: [],
          detectionMs: 0, ocrMs: 0, empty: info.cached,
        })
        continue
      }
      job.stage = `${prefix}本地识别`
      const page = await runInference(() => recognizePage(asset, info, stage => { job.stage = `${prefix}${stage}` }))
      prepared.push(page)
      logInfo('任务', `${jobLabel(job)} ${prefix}识别完成 · ${page.kept.length} 处文本 · 检测 ${formatDuration(page.detectionMs)} / OCR ${formatDuration(page.ocrMs)}`)
    } catch (error) {
      recordFailure(job, asset, error, stage => { job.stage = `${prefix}${stage}` }, prefix)
    }
  }

  const translatable = prepared.filter(page => !page.empty)
  if (!translatable.length) {
    // 全部页要么命中缓存、要么没有文本、要么失败：不需要调用大模型。
    for (const page of prepared) {
      if (page.empty) pushResult(job, page.asset.id, page.empty, assets.length)
    }
    return
  }

  // ── 阶段二：翻译 ──
  const settings = getAiSettings()
  if (mode === 'merged') {
    // 只有合并调用本身失败才整批失败；之后的擦字 / 落盘失败按单页记录，
    // 否则会把已经成功的页重复标成失败。
    let merged: { translations: string[]; model: string }
    try {
      merged = await translateMerged(translatable, stage => { job.stage = stage })
    } catch (error) {
      const message = error instanceof Error ? error.message : '合并翻译失败'
      for (const page of prepared) {
        if (page.empty) pushResult(job, page.asset.id, page.empty, assets.length)
        else recordFailure(job, page.asset, new Error(message), () => {}, '')
      }
      return
    }
    let cursor = 0
    for (const page of prepared) {
      if (page.empty) { pushResult(job, page.asset.id, page.empty, assets.length); continue }
      const slice = merged.translations.slice(cursor, cursor + page.kept.length)
      cursor += page.kept.length
      job.stage = `生成译图 ${job.completed + 1}/${assets.length}`
      try {
        const result = await finalizePage(page, slice, merged.model)
        pushResult(job, page.asset.id, result, assets.length)
      } catch (error) {
        recordFailure(job, page.asset, error, () => {}, '')
      }
    }
  } else {
    const results = await translateParallel(
      prepared,
      settings.mangaConcurrency,
      stage => { job.stage = stage },
      (done, total) => { job.stage = `AI 并发翻译 ${done}/${total}`; job.progress = Math.round(done / total * 60) },
    )
    for (let i = 0; i < prepared.length; i++) {
      const page = prepared[i]!
      if (page.empty) { pushResult(job, page.asset.id, page.empty, assets.length); continue }
      const translated = results[i]!
      if ('error' in translated) {
        recordFailure(job, page.asset, new Error(translated.error), () => {}, '')
        continue
      }
      try {
        job.stage = `生成译图 ${job.completed + 1}/${assets.length}`
        const result = await finalizePage(page, translated.translations, translated.model)
        pushResult(job, page.asset.id, result, assets.length)
      } catch (error) {
        recordFailure(job, page.asset, error, () => {}, '')
      }
    }
  }

  job.completed = assets.length
  job.progress = 100
}

function pushResult(job: InternalJob, assetId: string, result: MangaPageResult, total: number): void {
  if (!job.results) job.results = []
  job.results.push({ assetId, result })
  if (total === 1) job.result = result
  job.completed = job.results.length + (job.failed?.length || 0)
  job.progress = Math.round(job.completed / total * 100)
}

function recordFailure(job: InternalJob, asset: StoredAsset, error: unknown, setStage: (stage: string) => void, prefix: string): void {
  if (!job.failed) job.failed = []
  const message = error instanceof Error ? error.message : '漫画图片翻译失败'
  job.failed.push({ assetId: asset.id, message })
  setStage('翻译失败，继续下一张')
  logError('任务', `${jobLabel(job)} ${prefix}失败：${message}`)
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
  setStage('准备本地识别模型')
  await ensureModels(setStage)

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

/**
 * 保证模型就位并加载进内存。模型是懒加载的：首次翻译时才下载、加载，之后
 * 一直复用同一份会话，直到进程退出，不会每次翻译都重建。
 */
async function ensureModels(setStage?: (stage: string) => void): Promise<void> {
  if (detector.isLoaded && recognizer.isLoaded) return
  if (!loading) {
    loading = (async () => {
      // 只下载真正缺失的文件；全部就位时这一步不做任何网络请求。
      if (missingModels().length) {
        setStage?.('下载本地识别模型')
        logInfo('任务', '首次调用需要下载本地识别与 OCR 模型，耗时会长一些')
        await ensureMangaModels(undefined, progress => {
          if (!progress.total) return
          const percent = Math.round(progress.received / progress.total * 100)
          setStage?.(`下载本地识别模型 ${percent}%`)
        })
      }
      setStage?.('加载本地识别模型')
      await Promise.all([
        detector.load(modelPath(detectorModel), { executionProviders: providers() }),
        recognizer.load(path.join(modelRoot, 'manga-ocr'), { encoderProviders: providers(), decoderProviders: ['cpu'] }),
      ])
      logInfo('任务', `本地 OCR encoder：${recognizer.encoderFileUsed}`)
    })().finally(() => { loading = null })
  }
  return loading
}

function providers(): string[] {
  return process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu']
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
