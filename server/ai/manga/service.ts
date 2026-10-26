import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MangaJob, MangaModelStatus, MangaPageResult, MangaPipelineMode, MangaRegion } from '../../../shared/types.js'
import { getAiSettings, getLocalComputeConfig, translateMangaTexts } from '../../ai.js'
import { cacheDir } from '../../config.js'
import { db, getAsset, type StoredAsset } from '../../database.js'
import { MangaEngine, PIPELINE_VERSION, type EnginePage } from './engine.js'
import { checkRemoteCompute, RemoteComputeError, runRemoteMangaJob } from './remote.js'
import { formatDuration, logError, logInfo, logWarn } from '../../log.js'
import { modelRoot } from './models.js'
import { createTranslationLimiter } from './concurrency.js'
import { createPriorityQueue } from './priority.js'
import { remoteBackgroundConcurrency } from '../../background/limits.js'

const mangaCacheDir = path.join(cacheDir, 'manga')

/** Local ONNX sessions are rebuilt when the configured CPU thread count changes. */
let localEngineThreads: number | undefined = getLocalComputeConfig().localThreads
let localEngine = new MangaEngine({ modelRoot, intraOpNumThreads: localEngineThreads })

function currentLocalEngine(): MangaEngine {
  const configured = getLocalComputeConfig().localThreads
  if (configured !== localEngineThreads) {
    const previous = localEngine
    localEngineThreads = configured
    localEngine = new MangaEngine({ modelRoot, intraOpNumThreads: configured })
    void previous.release().catch(() => {})
  }
  return localEngine
}

/** OCR/擦字预热结果使用的模型标记；这类缓存不含译文，不能当成已翻译结果返回。 */
const OCR_ONLY_MODEL = 'OCR 预热'

interface PreparedAsset {
  key: string
  targetLanguage: string
  /** 原图内容哈希；同时作为远程任务幂等 ID。 */
  hash: string
  /** 同一语言下已完成的译图；只可能来自真实翻译结果。 */
  cached?: MangaPageResult
  /** 只有识别与底图的预热结果，可以直接跳过 OCR 进入翻译。 */
  prepared?: MangaPageResult
}

interface InternalJob extends MangaJob {
  assetIds: string[]
  prepared: Map<string, PreparedAsset>
}
const jobs = new Map<string, InternalJob>()
/** 日志里用短编号指代任务，长 UUID 只会占地方。 */
const jobLabel = (job: InternalJob) => `漫画翻译 #${job.id.slice(0, 6)}`
// 只有真正需要模型的页面才占用这个队列。缓存查询不排队，也不会被 GPU 任务挡住。
// 本地 ONNX 会话必须逐页推理；远程模式允许后台流水线，手动任务仍然优先。
const localInferenceQueue = createPriorityQueue({ manualBypass: false })
const remoteInferenceQueue = createPriorityQueue({
  backgroundConcurrency: () => remoteBackgroundConcurrency(),
  manualBypass: true,
})
const manualJobs = new Set<string>()

/** 远程状态检查带 10 秒缓存，设置页轮询时不会每次都打计算端。 */
let remoteStatus: { at: number; value: MangaModelStatus } | null = null

/** 保存计算设置后清掉状态缓存，避免设置页仍显示旧地址的检查结果。 */
export function clearMangaStatusCache(): void {
  remoteStatus = null
}

/**
 * 当前执行位置的模型状态。
 *
 * 本地模式只看模型文件是否就位；远程模式做一次带缓存的连接检查，失败原因原样
 * 返回给设置页，但不影响翻译任务本身（任务失败时会给出同一条原因）。
 */
export async function getMangaModelStatus(): Promise<MangaModelStatus> {
  const compute = getLocalComputeConfig()
  if (compute.mode !== 'remote') return { ...localEngine.modelStatus(), location: 'local' }

  const configured = Boolean(compute.baseUrl && compute.apiKey)
  if (!configured) {
    return {
      ready: false,
      device: '远程计算端',
      models: [],
      location: 'remote',
      remote: { configured: false, connected: false, message: '还没有填写远程计算端地址或 API Key' },
      message: '请先在 AI 设置里填写远程计算端的地址和 API Key',
    }
  }
  if (remoteStatus && Date.now() - remoteStatus.at < 10_000) return remoteStatus.value
  try {
    const status = await checkRemoteCompute(compute)
    const value: MangaModelStatus = {
      ready: status.ready,
      device: status.device,
      models: status.models,
      location: 'remote',
      remote: { configured: true, connected: true, device: status.device },
      ...(status.message ? { message: status.message } : {}),
    }
    remoteStatus = { at: Date.now(), value }
    return value
  } catch (error) {
    const message = (error as Error).message
    const value: MangaModelStatus = {
      ready: false,
      device: `远程计算端（${compute.baseUrl}）`,
      models: [],
      location: 'remote',
      remote: { configured: true, connected: false, message },
      message,
    }
    remoteStatus = { at: Date.now(), value }
    return value
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
  // 手动任务必须立刻登记：后台调度靠 hasManualMangaWork() 判断是否让位。
  manualJobs.add(job.id)

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
        manualJobs.delete(job.id)
        logInfo('任务', `${jobLabel(job)} 命中缓存，直接返回`)
        return publicJob(job)
      }
    } catch (error) {
      job.state = 'failed'
      job.stage = '读取缓存失败'
      job.progress = 100
      job.message = error instanceof Error ? error.message : '读取漫画缓存失败'
      logError('任务', `${jobLabel(job)} 读取缓存失败：${job.message}`)
      manualJobs.delete(job.id)
      return publicJob(job)
    }
  }

  logInfo('任务', `${jobLabel(job)} 入队 · ${job.total} 张图片${force ? ' · 强制重译' : ''}`)
  void runJob(job, uniqueAssets, force).finally(() => manualJobs.delete(job.id))
  return publicJob(job)
}

export function getMangaJob(id: string): MangaJob | undefined {
  const job = jobs.get(id)
  return job ? publicJob(job) : undefined
}

/** 只读取当前语言的已有译图，不创建任务、不加载识别模型、不调用翻译接口。 */
export async function getAutoMangaTranslation(asset: StoredAsset): Promise<MangaPageResult | null> {
  if (!getAiSettings().mangaAutoShowTranslated) return null
  return (await prepareAsset(asset, false)).cached || null
}

/** True while an explicitly requested manga job is queued or processing. */
export function hasManualMangaWork(): boolean {
  for (const id of manualJobs) {
    const job = jobs.get(id)
    if (job && (job.state === 'queued' || job.state === 'processing')) return true
  }
  return false
}

/**
 * Background OCR/prewarm entry point. It intentionally never creates a user-visible job.
 * Translation is opt-in and its caller reserves the paid-request budget immediately before
 * the HTTP call via beforeTranslate.
 */
export async function runBackgroundMangaAsset(
  asset: StoredAsset, options: { translate: boolean; signal?: AbortSignal; beforeTranslate?: () => void; onLocalFallback?: () => void },
): Promise<MangaPageResult> {
  options.signal?.throwIfAborted()
  const info = await prepareAsset(asset, false)
  // 只有真实译文才能直接返回；OCR 预热结果仅用于跳过重复识别。
  if (info.cached) return info.cached
  if (!options.translate && info.prepared) return info.prepared
  const page = info.prepared
    ? await hydratePrepared(asset, info)
    : await recognizePage(asset, info, () => {}, 'background', options.signal, options.onLocalFallback)
  options.signal?.throwIfAborted()
  if (page.empty) return page.empty
  // 预热只缓存「识别 + 底图」，不写 manga_translations，避免被当成已翻译结果。
  if (!options.translate) return persistPrepared(page)
  const translated = await translateMangaTexts({
    texts: page.page.regions.map(region => region.source),
    targetLanguage: page.targetLanguage,
    // 预算预留与请求中止都必须挂在真正的 HTTP 调用上，而不是提前手动调用。
    signal: options.signal,
    beforeRequest: options.beforeTranslate,
  })
  options.signal?.throwIfAborted()
  return finalizePage(page, translated.translations, translated.model)
}

export function mangaOverlayPath(key: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(key)) return undefined
  // 预热页与已翻译页共用同一份覆盖层；先查译文表，再回退到预热表。
  const row = db.prepare(`
    SELECT overlay_path AS file FROM manga_translations WHERE key = ?
    UNION ALL SELECT overlay_path AS file FROM manga_prepared_pages WHERE key = ?
  `).get(key, key) as { file: string | null } | undefined
  return row?.file && existsSync(row.file) ? row.file : undefined
}

/** 译图底图：Pixiv 云页不在 assets 表里，只能沿这条路由按翻译时记录的原图路径提供。 */
export function mangaSourcePath(key: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(key)) return undefined
  const row = db.prepare(`
    SELECT source_path AS file FROM manga_translations WHERE key = ?
    UNION ALL SELECT source_path AS file FROM manga_prepared_pages WHERE key = ?
  `).get(key, key) as { file: string | null } | undefined
  return row?.file && existsSync(row.file) ? row.file : undefined
}

/**
 * 底图 URL。
 *
 * 本地资产直接指向原图接口（与原图共用同一份 HTTP 缓存与解码结果）；
 * Pixiv 云页的 id 不在 assets 表里，用记录下来的原图路径兜底。
 */
function sourceUrlFor(asset: StoredAsset, key: string): string {
  return getAsset(asset.id) ? `/api/assets/${asset.id}/file` : `/api/ai/manga/cache/${key}/source`
}

/** 旧版整页擦字底图；只为兼容升级前写入的缓存行保留。 */
export function mangaBaseImagePath(key: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(key)) return undefined
  const row = db.prepare('SELECT image_path FROM manga_translations WHERE key = ?').get(key) as { image_path: string | null } | undefined
  return row?.image_path && existsSync(row.image_path) ? row.image_path : undefined
}

/**
 * 单页的本地计算结果（检测 + OCR + 擦字后的底图）。
 * 批量模式下先收集这些结果，再统一进入翻译阶段。
 */
interface PreparedPage {
  asset: StoredAsset
  key: string
  targetLanguage: string
  page: EnginePage
  /** 没有可翻译文本时直接返回的空结果。 */
  empty?: MangaPageResult
}

/** 缓存命中或空页占位：这些页面不需要再计算，也不持有任何像素数据。 */
function placeholderPage(): EnginePage {
  return {
    width: 0, height: 0, regions: [], engine: '',
    timings: { detectionMs: 0, ocrMs: 0, eraseMs: 0, encodeMs: 0 },
  }
}

/**
 * 把一页交给当前选择的计算位置。
 *
 * 只有「任务还没被接收」的连接失败才允许回退到本地主机；鉴权、协议、资源超限、
 * 模型错误都直接抛给调用方，避免同一页悄悄算两遍。
 */
async function computePage(asset: StoredAsset, info: PreparedAsset, setStage: (stage: string) => void, priority: 'manual' | 'background' = 'manual', signal?: AbortSignal, onLocalFallback?: () => void): Promise<EnginePage> {
  const compute = getLocalComputeConfig()
  if (compute.mode === 'remote') {
    // 远程模式：后台任务按流水线深度并发，手动任务可以越过已满的后台名额。
    // 计算端会按请求头优先执行手动任务，所以再排队也只是上传先后不同。
    return remoteInferenceQueue(async () => {
      signal?.throwIfAborted()
      try {
        return await runRemoteMangaJob(compute, { imagePath: asset.path, onStage: setStage, signal, priority })
      } catch (error) {
        const remote = error instanceof RemoteComputeError ? error : null
        if (compute.fallback === 'local' && remote?.phase === 'connect') {
          logWarn('计算', `远程计算端不可用，回退本地主机：${remote.message}`)
          setStage('远程计算端不可用，改用本地主机')
          onLocalFallback?.()
          // 本地回退走独立队列：远程任务可以并发，但本机 ONNX 仍然只能逐页跑。
          return localInferenceQueue(() => currentLocalEngine().process(asset.path, setStage), priority, signal)
        }
        throw error
      }
    }, priority, signal)
  }
  return localInferenceQueue(() => currentLocalEngine().process(asset.path, setStage), priority, signal)
}

/**
 * 各流水线共用「本地识别」这一段：检测 + OCR + 擦字 + 底图编码.
 * 不涉及大模型调用，也不写任何缓存结果。
 */
async function recognizePage(asset: StoredAsset, info: PreparedAsset, setStage: (stage: string) => void, priority: 'manual' | 'background' = 'manual', signal?: AbortSignal, onLocalFallback?: () => void): Promise<PreparedPage> {
  signal?.throwIfAborted()
  const page = await computePage(asset, info, setStage, priority, signal, onLocalFallback)
  const prepared: PreparedPage = { asset, key: info.key, targetLanguage: info.targetLanguage, page }
  if (!page.regions.length) prepared.empty = emptyResult(asset, info.key, info.targetLanguage)
  return prepared
}

/** 把一页的译文写进缓存并返回最终结果（底图在本地或远程计算阶段已经生成）。 */
async function finalizePage(
  page: PreparedPage, translations: string[], model: string, setStage?: (stage: string) => void,
): Promise<MangaPageResult> {
  if (page.empty) return page.empty
  const imagePath = await writeOverlayArtifact(page, setStage)
  const regions: MangaRegion[] = page.page.regions.map((region, index) => ({
    id: region.id,
    x: region.x, y: region.y, width: region.width, height: region.height,
    source: region.source,
    translation: translations[index] || region.source,
    detection: region.detection,
    confidence: region.confidence,
    background: region.background,
    textColor: region.textColor,
  }))
  const result: MangaPageResult = {
    key: page.key,
    width: page.page.width,
    height: page.page.height,
    // 底图就是原图本身：擦除只发生在独立的透明覆盖层里，原文件永远不改写。
    baseUrl: sourceUrlFor(page.asset, page.key),
    overlayUrl: `/api/ai/manga/cache/${page.key}/overlay.png`,
    regions,
    cached: false,
    model,
    targetLanguage: page.targetLanguage,
    createdAt: Date.now(),
  }
  db.prepare('INSERT OR REPLACE INTO manga_translations (key, data, image_path, overlay_path, source_path, created) VALUES (?, ?, ?, ?, ?, ?)')
    .run(page.key, JSON.stringify(result), null, imagePath, page.asset.path, result.createdAt)
  // 译文已覆盖同一份覆盖层，预热行不再需要。
  db.prepare('DELETE FROM manga_prepared_pages WHERE key = ?').run(page.key)
  setStage?.('完成')
  return result
}

/** 把透明覆盖层原子写进缓存目录，返回最终路径。原图永远只读，不会被改写。 */
async function writeOverlayArtifact(page: PreparedPage, setStage?: (stage: string) => void): Promise<string> {
  const imagePath = path.join(mangaCacheDir, `${page.key}.png`)
  const overlay = page.page.overlay
  // 复用预热阶段已经落盘的覆盖层：翻译阶段不需要再传一遍像素。
  if (!overlay) {
    if (!existsSync(imagePath)) throw new Error('这一页缺少擦字覆盖层，请重试')
    return imagePath
  }
  await mkdir(mangaCacheDir, { recursive: true })
  const temp = `${imagePath}.tmp.png`
  setStage?.('写入擦字覆盖层')
  try {
    await writeFile(temp, overlay)
    await rename(temp, imagePath)
  } finally {
    await unlink(temp).catch(() => {})
  }
  return imagePath
}

/**
 * 预热：只落「识别 + 擦字覆盖层」，译文留空。
 *
 * 写进独立表而不是 manga_translations，这样自动显示译文时不会拿到一张
 * translation 全是原文的假结果，再次翻译时又能直接跳过 OCR。
 */
async function persistPrepared(page: PreparedPage, setStage?: (stage: string) => void): Promise<MangaPageResult> {
  if (page.empty) return page.empty
  const imagePath = await writeOverlayArtifact(page, setStage)
  const result: MangaPageResult = {
    key: page.key,
    width: page.page.width,
    height: page.page.height,
    baseUrl: sourceUrlFor(page.asset, page.key),
    overlayUrl: `/api/ai/manga/cache/${page.key}/overlay.png`,
    regions: page.page.regions.map(region => ({ ...region, translation: '' })),
    cached: false,
    model: OCR_ONLY_MODEL,
    targetLanguage: page.targetLanguage,
    createdAt: Date.now(),
  }
  db.prepare('INSERT OR REPLACE INTO manga_prepared_pages (key, data, image_path, overlay_path, source_path, created) VALUES (?, ?, ?, ?, ?, ?)')
    .run(page.key, JSON.stringify(result), null, imagePath, page.asset.path, result.createdAt)
  // 预热与手动翻译可能同时跑到这里；译文已经落盘时不要再补一条预热行。
  if (db.prepare('SELECT 1 FROM manga_translations WHERE key = ?').get(page.key)) {
    db.prepare('DELETE FROM manga_prepared_pages WHERE key = ?').run(page.key)
  }
  setStage?.('完成')
  return result
}

/** 用预热结果还原一页：只还原文本与坐标，覆盖层已经在磁盘上，无需再读像素。 */
async function hydratePrepared(asset: StoredAsset, info: PreparedAsset): Promise<PreparedPage> {
  const prepared = info.prepared
  if (!prepared) throw new Error('缺少预热结果')
  const page: EnginePage = {
    width: prepared.width,
    height: prepared.height,
    regions: prepared.regions.map(region => ({
      id: region.id,
      x: region.x, y: region.y, width: region.width, height: region.height,
      source: region.source,
      detection: region.detection,
      confidence: region.confidence,
      background: region.background,
      textColor: region.textColor,
    })),
    engine: prepared.model,
    timings: { detectionMs: 0, ocrMs: 0, eraseMs: 0, encodeMs: 0 },
  }
  const result: PreparedPage = { asset, key: info.key, targetLanguage: info.targetLanguage, page }
  if (!page.regions.length) result.empty = emptyResult(asset, info.key, info.targetLanguage)
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
  for (const page of pending) texts.push(...page.page.regions.map(region => region.source))

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
          texts: page.page.regions.map(region => region.source),
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
    else if (mode === 'streaming') await runStreaming(job, assets, force)
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
    : mode === 'streaming' ? '边识别边并发翻译'
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

/** 本地识别逐页进行，识别结果立即进入独立的限流翻译队列。 */
async function runStreaming(job: InternalJob, assets: StoredAsset[], force: boolean): Promise<void> {
  const concurrency = getAiSettings().mangaConcurrency
  const translate = createTranslationLimiter(concurrency)
  const pending: Promise<void>[] = []
  let recognized = 0
  let recognitionStage = '准备识别'
  const updateStage = () => {
    job.completed = (job.results?.length || 0) + (job.failed?.length || 0)
    job.progress = Math.round(job.completed / assets.length * 100)
    job.stage = `识别 ${recognized}/${assets.length} · 完成 ${job.completed}/${assets.length} · ${recognitionStage}`
  }
  const fail = (asset: StoredAsset, error: unknown, prefix: string) => {
    recordFailure(job, asset, error, () => {}, prefix)
    updateStage()
  }
  const finishPage = async (page: PreparedPage, prefix: string) => {
    try {
      const translated = await translate(() => translateMangaTexts({
        texts: page.page.regions.map(region => region.source),
        targetLanguage: page.targetLanguage,
      }))
      const result = await finalizePage(page, translated.translations, translated.model)
      pushResult(job, page.asset.id, result, assets.length)
      logInfo('任务', `${jobLabel(job)} ${prefix}完成 · ${result.regions.length} 处文本`)
    } catch (error) {
      fail(page.asset, error, prefix)
    }
    updateStage()
  }

  // 翻译等待网络响应或并发名额时，不占用本地推理队列。
  try {
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i]!
      const prefix = `第 ${i + 1}/${assets.length} 张 · `
      job.currentAssetId = asset.id
      recognitionStage = `${prefix}准备识别`
      updateStage()
      try {
        const info = job.prepared.get(asset.id) || await prepareAsset(asset, force)
        if (info.cached) {
          pushResult(job, asset.id, info.cached, assets.length)
        } else {
          const page = await recognizePage(asset, info, stage => {
            recognitionStage = `${prefix}${stage}`
            updateStage()
          })
          logInfo('任务', `${jobLabel(job)} ${prefix}识别完成 · ${page.page.regions.length} 处文本 · 检测 ${formatDuration(page.page.timings.detectionMs)} / OCR ${formatDuration(page.page.timings.ocrMs)}`)
          if (page.empty) pushResult(job, asset.id, page.empty, assets.length)
          else pending.push(finishPage(page, prefix))
        }
      } catch (error) {
        fail(asset, error, prefix)
      }
      recognized++
      updateStage()
    }
    delete job.currentAssetId
    recognitionStage = `等待翻译与译图生成（并发 ${concurrency}）`
    updateStage()
  } finally {
    // 所有已排队页面落盘或失败后，才允许任务进入最终状态。
    await Promise.all(pending)
  }
}

/**
 * 批量模式：先把所有页的检测与 OCR 跑完，再进入翻译阶段。
 * merged 把所有文本合并成尽量少的几次调用；parallel 按页并发、受并发数限制。
 */
async function runBatched(job: InternalJob, assets: StoredAsset[], force: boolean, mode: 'merged' | 'parallel'): Promise<void> {
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
          page: placeholderPage(), empty: info.cached,
        })
        continue
      }
      job.stage = `${prefix}本地识别`
      const page = await recognizePage(asset, info, stage => { job.stage = `${prefix}${stage}` })
      prepared.push(page)
      logInfo('任务', `${jobLabel(job)} ${prefix}识别完成 · ${page.page.regions.length} 处文本 · 检测 ${formatDuration(page.page.timings.detectionMs)} / OCR ${formatDuration(page.page.timings.ocrMs)}`)
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
      const slice = merged.translations.slice(cursor, cursor + page.page.regions.length)
      cursor += page.page.regions.length
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
  // 计算本身（本地或远程）由 computePage 串行化；这里只负责翻译与落盘。
  // 已有 OCR 预热时直接复用底图与文本，只补翻译这一次网络调用。
  const page = info.prepared ? await hydratePrepared(asset, info) : await recognizePage(asset, info, setStage)
  if (page.empty) return page.empty
  setStage(`AI 翻译 ${page.page.regions.length} 处文字`)
  const translated = await translateMangaTexts({
    texts: page.page.regions.map(region => region.source), targetLanguage: page.targetLanguage,
  })
  return finalizePage(page, translated.translations, translated.model, setStage)
}

/**
 * 定位这一页的结果缓存。
 *
 * 快速路径只做一次 stat + 索引查询：原图内容没变就直接沿用上次算出的 key，不再
 * 重读整张图片。未翻译过的页同样会留下指纹，所以反复翻页不会反复哈希原图。
 * 只有文件真的变了、或用户强制重译时才重新读文件计算内容哈希。
 */
async function prepareAsset(asset: StoredAsset, force: boolean): Promise<PreparedAsset> {
  const targetLanguage = getAiSettings().targetLanguage
  if (!force) {
    const known = await readAssetFingerprint(asset, targetLanguage)
    if (known) return { key: known.key, targetLanguage, hash: known.hash, ...readCacheSlots(known.key) }
  }
  const info = await stat(asset.path)
  const hash = await hashFile(asset.path)
  const key = createHash('sha256').update(JSON.stringify({ version: PIPELINE_VERSION, hash, targetLanguage })).digest('hex')
  writeAssetFingerprint(asset, targetLanguage, key, hash, info.size, Math.trunc(info.mtimeMs))
  if (force) return { key, targetLanguage, hash }
  return { key, targetLanguage, hash, ...readCacheSlots(key) }
}

/** 已完成的译文优先；没有译文才退回 OCR 预热结果。 */
function readCacheSlots(key: string): Pick<PreparedAsset, 'cached' | 'prepared'> {
  const cached = readCachedResult(key)
  if (cached) return { cached }
  const prepared = readPreparedResult(key)
  return prepared ? { prepared } : {}
}

/** 原图指纹：大小与修改时间足够便宜，用来判断是否还需要重新哈希。 */
async function readAssetFingerprint(asset: StoredAsset, targetLanguage: string) {
  let info
  try { info = await stat(asset.path) } catch { return null }
  const row = db.prepare(
    'SELECT key, size, mtime, content_hash FROM manga_asset_cache WHERE asset_id = ? AND language = ? AND version = ?',
  ).get(asset.id, targetLanguage, PIPELINE_VERSION) as { key: string; size: number; mtime: number; content_hash: string } | undefined
  if (!row) return null
  if (row.size !== info.size || row.mtime !== Math.trunc(info.mtimeMs)) return null
  return { key: row.key, hash: row.content_hash }
}

function writeAssetFingerprint(
  asset: StoredAsset, targetLanguage: string, key: string, hash: string, size: number, mtime: number,
): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO manga_asset_cache (asset_id, language, version, key, size, mtime, content_hash, created, last_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_id, language, version) DO UPDATE SET
      key = excluded.key, size = excluded.size, mtime = excluded.mtime,
      content_hash = excluded.content_hash, last_used = excluded.last_used
  `).run(asset.id, targetLanguage, PIPELINE_VERSION, key, size, mtime, hash, now, now)
}

/** 流式计算原图内容哈希，避免把整张图读进内存。 */
function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
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
  const row = db.prepare('SELECT data, image_path, overlay_path FROM manga_translations WHERE key = ?').get(key) as { data: string; image_path: string | null; overlay_path: string | null } | undefined
  if (!row) return undefined
  const artifact = row.overlay_path || row.image_path
  if (artifact && !existsSync(artifact)) {
    db.prepare('DELETE FROM manga_translations WHERE key = ?').run(key)
    return undefined
  }
  try {
    const result = JSON.parse(row.data) as MangaPageResult
    // 旧版本把 OCR 预热写进这张表；它不含译文，绝不能当成已翻译结果返回。
    if (result.model === OCR_ONLY_MODEL) return undefined
    return { ...result, cached: true }
  } catch {
    db.prepare('DELETE FROM manga_translations WHERE key = ?').run(key)
    return undefined
  }
}

/** 只读取 OCR 预热结果；覆盖层丢失时丢弃该行，让调用方重新计算。 */
function readPreparedResult(key: string): MangaPageResult | undefined {
  const row = db.prepare('SELECT data, image_path, overlay_path FROM manga_prepared_pages WHERE key = ?').get(key) as { data: string; image_path: string | null; overlay_path: string | null } | undefined
  if (!row) return undefined
  const artifact = row.overlay_path || row.image_path
  if (!artifact || !existsSync(artifact)) {
    db.prepare('DELETE FROM manga_prepared_pages WHERE key = ?').run(key)
    return undefined
  }
  try {
    return JSON.parse(row.data) as MangaPageResult
  } catch {
    db.prepare('DELETE FROM manga_prepared_pages WHERE key = ?').run(key)
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
