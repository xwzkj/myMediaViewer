import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type * as Ort from 'onnxruntime-node'
import { logInfo, logWarn } from '../log.js'
import { wordPieceFromTokenizerJson, type WordPieceTokenizer } from './wordpiece.js'
import { normalizeVector, SemanticError } from './vectors.js'
import { clipModelRoot, ensureClipModels, missingClipModels, type DownloadProgress } from './models.js'

export interface SemanticProviderStatus {
  ready: boolean
  provider: 'local' | 'remote' | 'unavailable'
  model: string
  dimensions: 512
  message?: string
  /** 首次使用时正在自动下载模型；调用方应稍后重试而不是当成永久不可用。 */
  downloading?: boolean
}
export interface SemanticProvider {
  status(): Promise<SemanticProviderStatus>
  embedText(query: string): Promise<Float32Array>
  embedImage(image: Buffer): Promise<Float32Array>
}
const unavailable = () => new SemanticError('semantic_unavailable', '语义模型不可用。请检查网络后重试，或切换回关键词搜索。', 503)
const invalid = () => new SemanticError('semantic_model_invalid', '语义模型无法加载或格式不兼容；需要 Chinese-CLIP 的 ONNX 双塔导出与 tokenizer.json。', 503)

/** 模型加载失败后短时间内不重复尝试，避免每次轮询都重新下载几百 MB。 */
const FAILURE_COOLDOWN = 30_000

/** Chinese-CLIP 预处理：直接缩放到 224×224（不做中心裁剪），CLIP 逐通道均值方差。 */
const IMAGE_SIZE = 224
const MEANS = [0.48145466, 0.4578275, 0.40821073]
const STDS = [0.26862954, 0.26130258, 0.27577711]

function progressMessage(progress?: DownloadProgress): string {
  const mb = (bytes: number) => (bytes / 1048576).toFixed(0)
  if (!progress) return '正在准备语义模型（首次使用会自动下载约 180 MB）'
  if (!progress.total) return `正在下载语义模型 ${mb(progress.received)} MB`
  return `正在下载语义模型 ${Math.round(progress.received / progress.total * 100)}%（${mb(progress.received)}/${mb(progress.total)} MB）`
}

export interface ClipProviderOptions {
  /** 模型目录；省略用默认目录，传 null 表示禁用本地语义模型。 */
  directory?: string | null
  threads?: number
}

interface LoadedModel {
  ort: typeof Ort
  session: Ort.InferenceSession
  tokenizer: WordPieceTokenizer
  model: string
}

/**
 * 本地中文 CLIP：模型自动下载到本进程的数据目录，加载后复用同一个 ONNX 会话。
 *
 * 导出是单图双塔：一次前向需要同时给出 `input_ids`/`attention_mask` 和 `pixel_values`，
 * 因此只编码文本时会喂一张全零的占位图，只编码图片时会喂一对 [CLS]/[SEP]。
 */
export class LocalClipProvider implements SemanticProvider {
  private readonly directory: string
  private readonly threads: number
  private loaded?: LoadedModel
  private loading?: Promise<LoadedModel>
  private progress?: DownloadProgress
  private phase?: 'download' | 'load'
  private failure?: string
  private failedAt = 0
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  /** 只做文本编码时复用同一块占位像素，避免每次查询分配 600 KB。 */
  private readonly blankPixels = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE)
  constructor(options: ClipProviderOptions = {}) {
    this.directory = options.directory === null ? '' : options.directory ?? clipModelRoot
    this.threads = options.threads ?? 1
  }
  private load() {
    if (this.loaded) return Promise.resolve(this.loaded)
    return this.start()
  }
  private start() {
    if (!this.loading) {
      this.loading = this.open()
        .then(loaded => {
          this.loaded = loaded
          this.failure = undefined
          this.failedAt = 0
          return loaded
        })
        .catch(error => {
          this.failure = error instanceof Error ? error.message : String(error)
          this.failedAt = Date.now()
          throw error
        })
        .finally(() => {
          this.loading = undefined
          this.progress = undefined
          this.phase = undefined
        })
    }
    return this.loading
  }
  private async open(): Promise<LoadedModel> {
    if (!this.directory) throw unavailable()
    // 首次使用自动补齐模型文件；下载失败时保留可读原因，而不是伪装成「已就绪」。
    const missing = missingClipModels(this.directory)
    // 在第一个 await 之前定好阶段，状态查询才能立刻区分「正在下载」与「正在加载」。
    this.phase = missing.length ? 'download' : 'load'
    if (missing.length) {
      logInfo('语义', `缺少语义模型文件，开始下载到 ${this.directory}`)
      try {
        await ensureClipModels(this.directory, progress => { this.progress = progress })
      } catch (error) {
        throw new SemanticError('semantic_model_download', (error as Error).message, 503)
      }
      this.phase = 'load'
      this.progress = undefined
    }
    let session: Ort.InferenceSession | undefined
    try {
      logInfo('语义', `加载语义模型 · ${this.directory}`)
      const names = ['model.onnx', 'tokenizer.json']
      const files = names.map(name => path.join(this.directory, name))
      for (const file of files) if (!(await stat(file)).isFile()) throw invalid()
      const tokenizer = wordPieceFromTokenizerJson(JSON.parse(await readFile(files[1], 'utf8')))
      // 模型标识绑定权重、词表与预处理版本：任何一项变化都必须重建索引。
      const digest = createHash('sha256').update('chinese-clip-vit-b16-rgb224-fill-v1')
      for (let i = 0; i < files.length; i++) {
        digest.update(names[i])
        for await (const chunk of createReadStream(files[i])) digest.update(chunk)
      }
      const ort = await import('onnxruntime-node')
      const options: Ort.InferenceSession.SessionOptions = {
        executionProviders: ['cpu'],
        intraOpNumThreads: Math.min(16, Math.max(1, Math.floor(this.threads) || 1)),
        interOpNumThreads: 1,
        executionMode: 'sequential',
      }
      session = await ort.InferenceSession.create(files[0], options)
      const inputs = new Set(session.inputNames)
      if (!inputs.has('input_ids') || !inputs.has('pixel_values')
        || !session.outputNames.includes('text_embeds') || !session.outputNames.includes('image_embeds')) throw invalid()
      const model = `chinese-clip-vit-b16:${digest.digest('hex')}`
      logInfo('语义', `语义模型就绪 · ${model.slice(0, 26)}… · 线程 ${options.intraOpNumThreads ?? 1}`)
      return { ort, session, tokenizer, model }
    } catch (error) {
      await session?.release().catch(() => {})
      if (error instanceof SemanticError) throw error
      logWarn('语义', `语义模型文件无法加载：${(error as Error).message}`)
      throw invalid()
    }
  }
  async status(): Promise<SemanticProviderStatus> {
    if (this.loaded) return { ready: true, provider: 'local', model: this.loaded.model, dimensions: 512 }
    if (!this.directory) return { ready: false, provider: 'unavailable', model: '', dimensions: 512, message: unavailable().message }
    // 状态查询必须立刻返回：首次访问时顺手开始下载，由轮询展示进度。
    const cooling = this.failure && Date.now() - this.failedAt < FAILURE_COOLDOWN
    if (!this.loading && !cooling) void this.start().catch(() => {})
    return {
      ready: false,
      provider: 'local',
      model: '',
      dimensions: 512,
      downloading: this.phase === 'download',
      message: cooling ? this.failure : this.phase === 'download' ? progressMessage(this.progress) : '正在加载语义模型…',
    }
  }
  private async serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.pending >= 8) throw new SemanticError('semantic_busy', '语义计算队列已满，请稍后重试', 429)
    this.pending++
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    try { return await result } finally { this.pending-- }
  }
  private async runText(loaded: LoadedModel, query: string): Promise<Float32Array> {
    const { ids, mask } = loaded.tokenizer.encode(query)
    const feeds: Record<string, Ort.Tensor> = {
      input_ids: new loaded.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      pixel_values: new loaded.ort.Tensor('float32', this.blankPixels, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
    }
    if (loaded.session.inputNames.includes('attention_mask')) {
      feeds.attention_mask = new loaded.ort.Tensor('int64', BigInt64Array.from(mask.map(BigInt)), [1, mask.length])
    }
    const output = await loaded.session.run(feeds, ['text_embeds'])
    return normalizeVector(output.text_embeds.data as Float32Array)
  }
  async embedText(query: string): Promise<Float32Array> {
    return this.serial(async () => {
      const loaded = await this.load()
      try { return await this.runText(loaded, query) }
      catch (error) {
        if (error instanceof SemanticError) throw error
        throw new SemanticError('semantic_encoding_failed', '语义文本编码失败，请检查模型是否输出 512 维投影向量', 503)
      }
    })
  }
  async embedImage(image: Buffer): Promise<Float32Array> {
    return this.serial(async () => {
      const loaded = await this.load()
      try {
        // Chinese-CLIP 直接缩放到 224×224（不做中心裁剪），其余与 CLIP 一致。
        const oriented = sharp(image, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha()
        const { data, info } = await oriented.resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true })
        if (info.channels !== 3) throw invalid()
        const values = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE)
        for (let c = 0; c < 3; c++) for (let i = 0; i < IMAGE_SIZE * IMAGE_SIZE; i++) values[c * IMAGE_SIZE * IMAGE_SIZE + i] = (data[i * 3 + c] / 255 - MEANS[c]!) / STDS[c]!
        const { ids, mask } = loaded.tokenizer.encode('a')
        const feeds: Record<string, Ort.Tensor> = {
          pixel_values: new loaded.ort.Tensor('float32', values, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
          input_ids: new loaded.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        }
        if (loaded.session.inputNames.includes('attention_mask')) {
          feeds.attention_mask = new loaded.ort.Tensor('int64', BigInt64Array.from(mask.map(BigInt)), [1, mask.length])
        }
        const output = await loaded.session.run(feeds, ['image_embeds'])
        return normalizeVector(output.image_embeds.data as Float32Array)
      } catch (error) {
        if (error instanceof SemanticError) throw error
        throw new SemanticError('semantic_encoding_failed', '语义图片编码失败；图片可能损坏、过大或模型格式不匹配', 503)
      }
    })
  }
}
