import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

/**
 * kha-white/manga-ocr-base 的 ONNX 推理实现，ViT(DeiT) encoder + GPT-2 decoder。
 *
 * 模型来自 HuggingFace（onnx-community/manga-ocr-base-ONNX），不再依赖第三方
 * 导出的模型包，因此不再需要 config.json —— 这些超参就是该模型的固定属性。
 *
 * 与原版一致、不能改的三处：
 *  1. 预处理是 `PIL Image.convert('L').convert('RGB')` 的等价物 —— 用 BT.601 权重转
 *     灰度后**复制成三通道**，再 (v-0.5)/0.5。直接喂彩色会掉精度。
 *  2. 输入尺寸 224（模型固定）。
 *  3. 贪心解码，输入从 BOS 开始逐 token 增长；decoder 没有 past_key_values，
 *     每步都要重算整段前缀。
 */

/** 模型固定超参：manga-ocr-base 的结构与分词设置。 */
const IMAGE_SIZE = 224
const IMAGE_MEAN = 0.5
const IMAGE_STD = 0.5
const BOS_TOKEN_ID = 2
const EOS_TOKEN_ID = 3
const PAD_TOKEN_ID = 0
const MAX_LENGTH = 300

/** 两个 encoder 变体，以及各自的解码器与词表。 */
export const ENCODER_FP16 = 'encoder_model_fp16.onnx'
export const ENCODER_QUANTIZED = 'encoder_model_quantized.onnx'
export const DECODER_FILE = 'decoder_model_quantized.onnx'
export const VOCAB_FILE = 'vocab.txt'

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
  /** 实际选中的 encoder 文件，以及模型的输入输出名（不同导出批次命名不一样）。 */
  private encoderFileName = ''
  private encoderInputName = 'pixel_values'
  private encoderOutputName = 'last_hidden_state'

  get isLoaded() { return this.encoder !== null && this.decoder !== null }
  /** 供日志显示当前用的是量化版还是 fp16 加速版。 */
  get encoderFileUsed() { return this.encoderFileName }
  get imageSize() { return IMAGE_SIZE }
  get vocabSize() { return this.vocab.length }

  async load(modelDir: string, options: RecognizerOptions = {}): Promise<void> {
    if (this.encoder && this.decoder) return
    this.vocab = await loadVocab(modelDir)

    const common: ort.InferenceSession.SessionOptions = {
      intraOpNumThreads: options.intraOpNumThreads ?? 0,
    }
    const encoderProviders = options.encoderProviders ?? ['dml', 'cpu']
    const fp16Path = path.join(modelDir, ENCODER_FP16)
    const quantizedPath = path.join(modelDir, ENCODER_QUANTIZED)

    // fp16 encoder 在 DirectML 上比动态量化版快约 4 倍，但在 CPU 上反而慢 3 倍。
    // 所以先用「只指定 dml」建一次会话做探测：成功说明 GPU 路径真的可用，才用 fp16；
    // 失败（没有独显、驱动太旧）就退回量化版，继续走 dml → cpu 的回退链。
    let encoder: ort.InferenceSession | null = null
    if (encoderProviders.includes('dml') && existsSync(fp16Path)) {
      try {
        encoder = await ort.InferenceSession.create(fp16Path, { ...common, executionProviders: ['dml'] })
        this.encoderFileName = ENCODER_FP16
      } catch { encoder = null }
    }
    // 回退顺序：量化版优先（CPU 上更快）；只装了 fp16 时也接受它，慢但能跑。
    if (!encoder && existsSync(quantizedPath)) {
      encoder = await ort.InferenceSession.create(quantizedPath, {
        ...common,
        executionProviders: encoderProviders,
      })
      this.encoderFileName = ENCODER_QUANTIZED
    }
    if (!encoder && existsSync(fp16Path)) {
      encoder = await ort.InferenceSession.create(fp16Path, {
        ...common,
        executionProviders: encoderProviders,
      })
      this.encoderFileName = ENCODER_FP16
    }
    if (!encoder) {
      throw new Error('缺少 encoder 模型：' + quantizedPath + ' 或 ' + fp16Path + ' 至少要有一个')
    }
    this.encoder = encoder

    this.decoder = await ort.InferenceSession.create(path.join(modelDir, DECODER_FILE), {
      ...common,
      executionProviders: options.decoderProviders ?? ['cpu'],
    })

    // 输出名随导出批次变化（last_hidden_state / encoder_hidden_states），按名字取，取不到再退回第一个输出。
    this.encoderInputName = this.encoder.inputNames[0] ?? 'pixel_values'
    this.encoderOutputName = this.encoder.outputNames.find(name => name === 'last_hidden_state')
      ?? this.encoder.outputNames.find(name => name === 'encoder_hidden_states')
      ?? this.encoder.outputNames[0]
      ?? 'last_hidden_state'
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
    if (!this.encoder || !this.decoder) throw new Error('manga-ocr 模型未加载')
    if (!crops.length) return []
    const size = IMAGE_SIZE
    const plane = size * size
    const batch = new Float32Array(crops.length * 3 * plane)
    for (let i = 0; i < crops.length; i++) {
      const pixels = await cropToSquareRgb(pageRaw, pageWidth, pageHeight, crops[i]!, size)
      writeGrayscaleChw(batch, i * 3 * plane, pixels)
    }

    const encOut = await this.encoder.run({
      [this.encoderInputName]: new ort.Tensor('float32', batch, [crops.length, 3, size, size]),
    })
    try {
      const hiddenTensor = encOut[this.encoderOutputName] as ort.Tensor
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
      try { (encOut[this.encoderOutputName] as ort.Tensor).dispose?.() } catch { /* 忽略 */ }
    }
  }

  /** 贪心解码一段：每步取最后一个位置的 logits，argmax 即下一个 token。 */
  private async decodeOne(hidden: Float32Array, seq: number, dim: number): Promise<OcrResult> {
    const decoder = this.decoder!
    const vocabSize = this.vocabSize
    const ids: number[] = [BOS_TOKEN_ID]
    let logProbSum = 0
    let counted = 0

    for (let step = 0; step < MAX_LENGTH; step++) {
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
        if (idx === EOS_TOKEN_ID) break
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
    const special = new Set([BOS_TOKEN_ID, EOS_TOKEN_ID, PAD_TOKEN_ID])
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
 * 读词表。一行一个 token，共 6144 个。
 *
 * 不能改用按 \n 切分后过滤空串的写法：词表里有 3 个 token 本身就是空串，
 * 过滤掉会让后面所有 token 的下标整体前移，解码结果全错。
 */
async function loadVocab(modelDir: string): Promise<string[]> {
  const txtPath = path.join(modelDir, VOCAB_FILE)
  if (!existsSync(txtPath)) throw new Error('缺少词表文件：' + txtPath)
  const text = await readFile(txtPath, 'utf8')
  const lines = text.split('\n')
  // 末尾换行会多出一个空串，去掉它；中间的空 token 必须保留。
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
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
function writeGrayscaleChw(out: Float32Array, base: number, rgb: Buffer): void {
  const plane = IMAGE_SIZE * IMAGE_SIZE
  for (let i = 0; i < plane; i++) {
    const r = rgb[i * 3]!
    const g = rgb[i * 3 + 1]!
    const b = rgb[i * 3 + 2]!
    const v = ((0.299 * r + 0.587 * g + 0.114 * b) / 255 - IMAGE_MEAN) / IMAGE_STD
    out[base + i] = v
    out[base + plane + i] = v
    out[base + 2 * plane + i] = v
  }
}