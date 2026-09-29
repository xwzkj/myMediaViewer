import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

/**
 * kha-white/manga-ocr-base 的 ONNX 推理实现，ViT(DeiT) encoder + GPT-2 decoder。
 *
 * 与原版一致、不能改的三处：
 *  1. 预处理是 `PIL Image.convert('L').convert('RGB')` 的等价物 —— 用 BT.601 权重转
 *     灰度后**复制成三通道**，再 (v-0.5)/0.5。直接喂彩色会掉精度。
 *  2. 输入尺寸从 config.json 读（**实测是 224，不是 384**）。
 *  3. 贪心解码，输入从 BOS 开始逐 token 增长；decoder 没有 past_key_values，
 *     每步都要重算整段前缀。
 */

const MODEL_IMAGE_SIZE_FALLBACK = 224
const DEFAULT_MAX_LENGTH = 300

export interface OcrConfig {
  encoderFile: string
  decoderFile: string
  vocabFile: string
  imageSize: number
  imageMean: number[]
  imageStd: number[]
  bosTokenId: number
  eosTokenId: number
  padTokenId: number
  vocabSize: number
  maxLength: number
}

export interface RecognizerOptions {
  /**
   * encoder 用 GPU 划算（一次前向、形状固定）。
   * decoder 则相反：一个 token 一次调用、序列长度每步都在变，DML 每次调用的
   * 调度开销(~23ms)远大于这个小 GPT-2 的实际算力(~1.8ms)，实测 CPU 快 14 倍。
   */
  encoderProviders?: string[]
  decoderProviders?: string[]
  intraOpNumThreads?: number
}

/** 一页里的一个待识别裁剪区，坐标是原图分辨率。 */
export interface CropRect { left: number; top: number; width: number; height: number }

export interface OcrResult {
  text: string
  /** 每 token 最大概率的几何平均：正经文本 0.6-0.95，噪声上幻觉通常 < 0.3 */
  confidence: number
  /** 生成了多少个 token，用于观察是否撞上 maxLength */
  tokens: number
}

export class MangaOcrRecognizer {
  private encoder: ort.InferenceSession | null = null
  private decoder: ort.InferenceSession | null = null
  private vocab: string[] = []
  private config: OcrConfig | null = null

  get isLoaded() { return this.encoder !== null && this.decoder !== null }
  get imageSize() { return this.config?.imageSize ?? MODEL_IMAGE_SIZE_FALLBACK }
  get vocabSize() { return this.config?.vocabSize ?? this.vocab.length }

  async load(modelDir: string, options: RecognizerOptions = {}): Promise<void> {
    if (this.encoder && this.decoder) return
    const config = parseConfig(JSON.parse(await readFile(path.join(modelDir, 'config.json'), 'utf8')))
    this.config = config
    this.vocab = JSON.parse(await readFile(path.join(modelDir, config.vocabFile), 'utf8')) as string[]

    const common: ort.InferenceSession.SessionOptions = {
      intraOpNumThreads: options.intraOpNumThreads ?? 0,
    }
    this.encoder = await ort.InferenceSession.create(path.join(modelDir, config.encoderFile), {
      ...common,
      executionProviders: options.encoderProviders ?? ['dml', 'cpu'],
    })
    this.decoder = await ort.InferenceSession.create(path.join(modelDir, config.decoderFile), {
      ...common,
      executionProviders: options.decoderProviders ?? ['cpu'],
    })

    // 以 ONNX 实际输入形状为准，config 只作交叉校验 —— 两者不一致时以模型为准。
    const declared = this.encoder.inputMetadata[0]
    const modelSize = declared?.isTensor ? Number(declared.shape[2]) : Number.NaN
    if (Number.isFinite(modelSize) && modelSize !== config.imageSize) {
      config.imageSize = modelSize
    }
  }

  async release(): Promise<void> {
    await this.encoder?.release()
    await this.decoder?.release()
    this.encoder = null
    this.decoder = null
  }

  /**
   * 批量识别。先整批跑一次 encoder，再逐个跑自回归 decoder。
   * @param pageRaw 整页的 RGB raw buffer（比每个框单独解码一次划算）
   */
  async recognizeBatch(
    pageRaw: Buffer,
    pageWidth: number,
    pageHeight: number,
    crops: CropRect[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<OcrResult[]> {
    if (!this.encoder || !this.decoder || !this.config) throw new Error('manga-ocr 模型未加载')
    if (!crops.length) return []
    const size = this.config.imageSize
    const plane = size * size
    const batch = new Float32Array(crops.length * 3 * plane)
    for (let i = 0; i < crops.length; i++) {
      const pixels = await cropToSquareRgb(pageRaw, pageWidth, pageHeight, crops[i]!, size)
      writeGrayscaleChw(batch, i * 3 * plane, pixels, this.config)
    }

    const encOut = await this.encoder.run({
      pixel_values: new ort.Tensor('float32', batch, [crops.length, 3, size, size]),
    })
    try {
      const hiddenTensor = encOut.encoder_hidden_states as ort.Tensor
      const hiddenDims = hiddenTensor.dims
      const seq = Number(hiddenDims[1])
      const dim = Number(hiddenDims[2])
      const hidden = hiddenTensor.data as Float32Array
      const perItem = seq * dim

      const results: OcrResult[] = []
      for (let i = 0; i < crops.length; i++) {
        // slice 而非 subarray：避免把带偏移的视图交给 ORT
        const item = hidden.slice(i * perItem, (i + 1) * perItem)
        results.push(await this.decodeOne(item, seq, dim))
        onProgress?.(i + 1, crops.length)
      }
      return results
    } finally {
      try { (encOut.encoder_hidden_states as ort.Tensor).dispose?.() } catch { /* 忽略 */ }
    }
  }

  /** 贪心解码一段：每步取最后一个位置的 logits，argmax 即下一个 token。 */
  private async decodeOne(hidden: Float32Array, seq: number, dim: number): Promise<OcrResult> {
    const decoder = this.decoder!
    const cfg = this.config!
    const vocabSize = this.vocabSize
    const ids: number[] = [cfg.bosTokenId]
    let logProbSum = 0
    let counted = 0

    for (let step = 0; step < cfg.maxLength; step++) {
      const out = await decoder.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        encoder_hidden_states: new ort.Tensor('float32', hidden, [1, seq, dim]),
      })
      try {
        const logitsTensor = out.logits as ort.Tensor
        const logits = logitsTensor.data as Float32Array
        const offset = (ids.length - 1) * vocabSize
        let maxVal = Number.NEGATIVE_INFINITY
        let idx = 0
        for (let v = 0; v < vocabSize; v++) {
          const value = logits[offset + v]!
          if (value > maxVal) { maxVal = value; idx = v }
        }
        // 数值稳定的 log-softmax：log P(idx) = -log(Σ exp(x_v - max))
        let sum = 0
        for (let v = 0; v < vocabSize; v++) sum += Math.exp(logits[offset + v]! - maxVal)
        const logProb = -Math.log(sum)
        if (idx === cfg.eosTokenId) break
        ids.push(idx)
        logProbSum += logProb
        counted++
      } finally {
        try { (out.logits as ort.Tensor).dispose?.() } catch { /* 忽略 */ }
      }
    }

    return {
      text: this.detokenize(ids.slice(1)),
      confidence: counted === 0 ? 0 : Math.exp(logProbSum / counted),
      tokens: counted,
    }
  }

  /** 词表是 WordPiece（manga-ocr 实际用的）：`##` 前缀去掉后直接拼接，最后 NFKC 归一。 */
  private detokenize(ids: number[]): string {
    const cfg = this.config!
    const special = new Set([cfg.bosTokenId, cfg.eosTokenId, cfg.padTokenId])
    const specialText = new Set(['[CLS]', '[SEP]', '[PAD]', '[UNK]', '[MASK]'])
    const sb: string[] = []
    for (const id of ids) {
      if (special.has(id) || id < 0 || id >= this.vocab.length) continue
      let token = this.vocab[id]!
      if (specialText.has(token)) continue
      if (token.startsWith('##')) token = token.slice(2)
      else if (token.startsWith('\u2581')) token = token.slice(1)
      sb.push(token)
    }
    return sb.join('').normalize('NFKC')
  }
}

/**
 * 解析 config.json。字段是 snake_case（由 Shaft 的导出脚本写出），
 * 这里统一映射成 camelCase，并对缺失项给默认值。
 */
export function parseConfig(raw: Record<string, unknown>): OcrConfig {
  const num = (key: string, fallback: number): number => {
    const v = Number(raw[key])
    return Number.isFinite(v) ? v : fallback
  }
  const str = (key: string, fallback: string): string =>
    typeof raw[key] === 'string' && (raw[key] as string).length ? raw[key] as string : fallback
  const arr = (key: string): number[] => {
    const v = raw[key]
    return Array.isArray(v) && v.length >= 3 ? v.map(Number) : [0.5, 0.5, 0.5]
  }
  return {
    encoderFile: str('encoder_file', 'encoder_model_quantized.onnx'),
    decoderFile: str('decoder_file', 'decoder_model_quantized.onnx'),
    vocabFile: str('vocab_file', 'vocab.json'),
    imageSize: num('image_size', MODEL_IMAGE_SIZE_FALLBACK),
    imageMean: arr('image_mean'),
    imageStd: arr('image_std'),
    bosTokenId: num('bos_token_id', 2),
    eosTokenId: num('eos_token_id', 3),
    padTokenId: num('pad_token_id', 0),
    vocabSize: num('vocab_size', 0),
    maxLength: num('max_length', DEFAULT_MAX_LENGTH),
  }
}
/** 裁一块并缩放到 size×size（直接拉伸，与上游 Bitmap.createScaledBitmap 行为一致）。 */
async function cropToSquareRgb(
  pageRaw: Buffer, pageWidth: number, pageHeight: number, rect: CropRect, size: number,
): Promise<Buffer> {
  const left = Math.max(0, Math.min(pageWidth - 1, Math.floor(rect.left)))
  const top = Math.max(0, Math.min(pageHeight - 1, Math.floor(rect.top)))
  const width = Math.max(1, Math.min(pageWidth - left, Math.floor(rect.width)))
  const height = Math.max(1, Math.min(pageHeight - top, Math.floor(rect.height)))
  return sharp(pageRaw, { raw: { width: pageWidth, height: pageHeight, channels: 3 } })
    .extract({ left, top, width, height })
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer()
}

/** BT.601 灰度 → 复制三通道 → (v-mean)/std → CHW。 */
function writeGrayscaleChw(
  out: Float32Array, base: number, rgb: Buffer, cfg: OcrConfig,
): void {
  const size = cfg.imageSize
  const plane = size * size
  const mean = cfg.imageMean[0] ?? 0.5
  const std = cfg.imageStd[0] ?? 0.5
  for (let i = 0; i < plane; i++) {
    const r = rgb[i * 3]!
    const g = rgb[i * 3 + 1]!
    const b = rgb[i * 3 + 2]!
    const v = ((0.299 * r + 0.587 * g + 0.114 * b) / 255 - mean) / std
    out[base + i] = v
    out[base + plane + i] = v
    out[base + 2 * plane + i] = v
  }
}
