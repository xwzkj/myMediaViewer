import path from 'node:path'
import sharp from 'sharp'
import { ComicTextDetector } from './detector.js'
import { MangaOcrRecognizer } from './recognizer.js'
import { eraseTranslatedRegions } from './erase.js'
import { judgeRegion, mangaReadingOrder, trimTrailingNoise } from './pipeline.js'
import { boxToRect, paddedRect, type OcrRegion } from './types.js'
import {
  decoderModel, detectorModel, encoderFp16Model, ensureMangaModels, hasModel,
  missingModels, modelPath, vocabModel,
} from './models.js'
import { logInfo } from '../../log.js'

/**
 * 共享的漫画计算核心：检测 → OCR → 阅读顺序整理 → 擦字 → 底图编码。
 *
 * 主服务的本地模式和远程计算端都调用这一份实现，保证两边对同一张图给出相同的
 * 文字、坐标和底图。这里刻意不引用数据库、配置或在线 AI：计算端只做纯计算。
 *
 * 擦字不依赖译文，所以底图可以在这里一次生成；在线翻译随后只在主服务进行，不需要
 * 把整页 mask 传回主服务，也不需要第二次远程调用。
 */

/** 结果缓存版本。改动识别、擦字或输出语义时递增，让旧缓存自然失效。 */
export const PIPELINE_VERSION = 1
/** 单页像素上限。超出时返回可解释的错误，避免异常扫描件耗尽内存。 */
export const MAX_PAGE_PIXELS = 40_000_000
/** 单页最多识别的文本区域。超出时明确报错，不静默丢掉文字。 */
export const MAX_REGIONS = 80

/** 计算核心的错误：信息可安全展示给用户，带 HTTP 状态码与机器可读错误码。 */
export class MangaEngineError extends Error {
  expose = true
  constructor(message: string, public statusCode = 400, public code = 'manga_failed') {
    super(message)
    this.name = 'MangaEngineError'
  }
}

export interface EngineRegion {
  id: number
  x: number
  y: number
  width: number
  height: number
  /** 识别出的原文，翻译在主服务完成。 */
  source: string
  detection: number
  confidence: number
  background: string
  textColor: string
}

export interface EnginePage {
  width: number
  height: number
  regions: EngineRegion[]
  /** 擦除后编码的无损 PNG；本页没有可翻译文本时为 undefined。 */
  base?: Buffer
  /** 实际使用的模型描述，写进任务日志与结果。 */
  engine: string
  timings: { detectionMs: number; ocrMs: number; eraseMs: number; encodeMs: number }
}

export interface MangaEngineOptions {
  /** 模型根目录，与下载逻辑共用。 */
  modelRoot: string
  /** 执行设备，默认 Windows 优先 DirectML 并回退 CPU，其他平台 CPU。 */
  executionProviders?: string[]
  /** ONNX Runtime 线程数；省略时交给运行时决定，保持现有行为。 */
  intraOpNumThreads?: number
}

export interface EngineModelStatus {
  ready: boolean
  device: string
  models: Array<{ name: string; ready: boolean; files: string[]; missing: string[] }>
  message?: string
}

export class MangaEngine {
  private readonly detector = new ComicTextDetector()
  private readonly recognizer = new MangaOcrRecognizer()
  private readonly modelRoot: string
  private readonly providers: string[]
  private readonly intraOpNumThreads: number | undefined
  private loading: Promise<void> | null = null

  constructor(options: MangaEngineOptions) {
    this.modelRoot = options.modelRoot
    this.providers = options.executionProviders ?? (process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu'])
    this.intraOpNumThreads = options.intraOpNumThreads
  }

  get isLoaded(): boolean {
    return this.detector.isLoaded && this.recognizer.isLoaded
  }

  /** 模型是否就位、实际设备是什么。只做文件存在性检查，不加载模型。 */
  modelStatus(): EngineModelStatus {
    const encoderReady = hasModel(encoderFp16Model, this.modelRoot)
    const encoderNames = [path.basename(encoderFp16Model.target)]
    const detectorReady = hasModel(detectorModel, this.modelRoot)
    const decoderReady = hasModel(decoderModel, this.modelRoot)
    const vocabReady = hasModel(vocabModel, this.modelRoot)

    const models = [
      {
        name: 'comic-text-detector',
        ready: detectorReady,
        files: [path.basename(detectorModel.target)],
        missing: detectorReady ? [] : [path.basename(detectorModel.target)],
      },
      {
        name: 'manga-ocr',
        ready: encoderReady && decoderReady && vocabReady,
        files: [...encoderNames, path.basename(decoderModel.target), path.basename(vocabModel.target)],
        missing: [
          ...(encoderReady ? [] : encoderNames),
          ...(decoderReady ? [] : [path.basename(decoderModel.target)]),
          ...(vocabReady ? [] : [path.basename(vocabModel.target)]),
        ],
      },
    ]
    const ready = models.every(model => model.ready)
    return {
      ready,
      device: this.providers[0] === 'dml' ? 'DirectML（不可用时回退 CPU）' : 'CPU',
      models,
      message: ready ? undefined : `首次翻译会自动下载模型到 ${this.modelRoot}；网络不通时设置 HF_ENDPOINT 指向镜像站`,
    }
  }

  /** 模型懒加载：首次真正需要时才下载并加载，之后一直复用同一份会话。 */
  async ensureModels(setStage?: (stage: string) => void): Promise<void> {
    if (this.isLoaded) return
    if (!this.loading) {
      this.loading = (async () => {
        if (missingModels(undefined, this.modelRoot).length) {
          setStage?.('下载本地识别模型')
          logInfo('识别', '首次调用需要下载本地识别与 OCR 模型，耗时会长一些')
          await ensureMangaModels(undefined, progress => {
            if (!progress.total) return
            setStage?.(`下载本地识别模型 ${Math.round(progress.received / progress.total * 100)}%`)
          }, this.modelRoot)
        }
        setStage?.('加载本地识别模型')
        await Promise.all([
          this.detector.load(modelPath(detectorModel, this.modelRoot), {
            executionProviders: this.providers,
            intraOpNumThreads: this.intraOpNumThreads,
          }),
          this.recognizer.load(path.join(this.modelRoot, 'manga-ocr'), {
            encoderProviders: this.providers,
            decoderProviders: ['cpu'],
            intraOpNumThreads: this.intraOpNumThreads,
          }),
        ])
        logInfo('识别', `本地 OCR encoder：${this.recognizer.encoderFileUsed}`)
      })().finally(() => { this.loading = null })
    }
    return this.loading
  }

  /**
   * 处理一页：检测、OCR、整理阅读顺序、擦字、编码底图。
   *
   * @param imagePath 原图路径；调用方负责确认它在允许的媒体目录内。
   */
  async process(imagePath: string, setStage: (stage: string) => void = () => {}): Promise<EnginePage> {
    setStage('准备本地识别模型')
    await this.ensureModels(setStage)

    let metadata: sharp.Metadata
    try {
      metadata = await sharp(imagePath, { limitInputPixels: MAX_PAGE_PIXELS * 4 }).metadata()
    } catch {
      throw new MangaEngineError('无法读取这张图片，可能已损坏或不是支持的图片格式', 422, 'invalid_image')
    }
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (!width || !height) throw new MangaEngineError(`无法读取图片尺寸：${path.basename(imagePath)}`, 422, 'invalid_image')
    if (width * height > MAX_PAGE_PIXELS) {
      throw new MangaEngineError(
        `这张图有 ${((width * height) / 1_000_000).toFixed(1)} MP，超过单页 ${MAX_PAGE_PIXELS / 1_000_000} MP 上限`,
        413, 'image_too_large',
      )
    }

    setStage('识别气泡区域')
    const detectionStarted = Date.now()
    const detection = await this.detector.detect(imagePath)
    const detectionMs = Date.now() - detectionStarted
    const engineName = `comic-text-detector + manga-ocr（${this.providers[0] === 'dml' ? 'DirectML/CPU' : 'CPU'}）`

    if (!detection.boxes.length) {
      setStage('没有检测到气泡文字')
      return {
        width: detection.pageWidth,
        height: detection.pageHeight,
        regions: [],
        engine: engineName,
        timings: { detectionMs, ocrMs: 0, eraseMs: 0, encodeMs: 0 },
      }
    }

    setStage(`准备提取 ${detection.boxes.length} 处气泡文本`)
    const pageRaw = await sharp(imagePath, { limitInputPixels: MAX_PAGE_PIXELS * 4 })
      .removeAlpha().toColourspace('srgb').raw().toBuffer()
    const crops = detection.boxes.map(box => paddedRect(boxToRect(box, detection.pageWidth, detection.pageHeight), detection.pageWidth, detection.pageHeight))
    setStage(`提取气泡文本 0/${crops.length}`)
    const ocrStarted = Date.now()
    const ocrResults = await this.recognizer.recognizeBatch(
      pageRaw, detection.pageWidth, detection.pageHeight, crops,
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
    const kept = mangaReadingOrder(candidates.filter(region => judgeRegion(region, shortEdge).keep))
    if (kept.length > MAX_REGIONS) {
      throw new MangaEngineError(
        `这一页识别出 ${kept.length} 处文字，超过单页 ${MAX_REGIONS} 处上限`, 413, 'too_many_regions',
      )
    }
    if (!kept.length) setStage('没有可翻译的气泡文本')

    const eraseRegions = kept.map(region => boxToRect({ ...region, classId: 0 }, detection.pageWidth, detection.pageHeight))
    let base: Buffer | undefined
    let colors: Array<{ background: string; textColor: string }> = []
    let eraseMs = 0
    let encodeMs = 0
    if (kept.length) {
      setStage('擦除原文')
      const eraseStarted = Date.now()
      const erased = await eraseTranslatedRegions(imagePath, detection.pageWidth, detection.pageHeight, detection.textMask, eraseRegions)
      eraseMs = Date.now() - eraseStarted
      colors = erased.colors
      setStage('生成译图底图')
      const encodeStarted = Date.now()
      base = await sharp(erased.data, { raw: { width: erased.width, height: erased.height, channels: 3 } })
        .png({ compressionLevel: 7, adaptiveFiltering: true })
        .toBuffer()
      encodeMs = Date.now() - encodeStarted
    }

    const regions: EngineRegion[] = kept.map((region, index) => {
      const rect = eraseRegions[index]!
      return {
        id: index + 1,
        x: rect.left, y: rect.top, width: rect.width, height: rect.height,
        source: region.text,
        detection: region.prob,
        confidence: region.confidence,
        background: colors[index]?.background || '#ffffff',
        textColor: colors[index]?.textColor || '#111111',
      }
    })

    return {
      width: detection.pageWidth,
      height: detection.pageHeight,
      regions,
      base,
      engine: engineName,
      timings: { detectionMs, ocrMs, eraseMs, encodeMs },
    }
  }

  async release(): Promise<void> {
    await this.detector.release()
    await this.recognizer.release()
  }
}
