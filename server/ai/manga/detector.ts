import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import type { DetectionBox, DetectionResult, TextMask } from './types.js'

/**
 * dmMaze/comic-text-detector，跑在 ONNX Runtime 上。
 *
 * 与 dmMaze 的 inference 脚本严格对齐的三处：
 *  1. letterbox 是**左上对齐**，padding 全部堆在右下，填充色黑。
 *     （常见实现在中心 padding，但该模型训练时看到的是右下 padding 分布。）
 *  2. 输入是 RGB/255，**不做 ImageNet 归一化**。
 *  3. NMS 是 class-agnostic：文字框和气泡框互相抑制。
 */

/** YOLO 输入尺寸，模型固定。 */
const INPUT_SIZE = 1024
/** 候选框置信度下限，与上游一致。 */
const CONF_THRESHOLD = 0.4
/** NMS IoU 阈值，与上游 nms_thresh=0.35 一致（比 YOLOv5 默认 0.45 紧）。 */
const IOU_THRESHOLD = 0.35
/** seg 头是 sigmoid 后的概率，超过该值算文字像素。 */
const MASK_THRESHOLD = 0.5
/** CTD 的 batch 维固定为 1，不能批处理。 */
const BATCH = 1

export interface DetectorOptions {
  /** 默认 'dml'，失败时回退 CPU。CPU 上 1024² 一次约 15 秒，仅作兜底。 */
  executionProviders?: string[]
  intraOpNumThreads?: number
}

export class ComicTextDetector {
  private session: ort.InferenceSession | null = null
  private inputName = 'images'
  private blkKey = ''
  private segKey: string | null = null

  get isLoaded() { return this.session !== null }

  async load(modelPath: string, options: DetectorOptions = {}): Promise<void> {
    if (this.session) return
    const executionProviders = options.executionProviders ?? ['dml', 'cpu']
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders,
      intraOpNumThreads: options.intraOpNumThreads ?? 0,
    })
    // 输出名不同导出批次可能不一样，先按名字记，取不到再按形状兜底。
    this.blkKey = this.session.outputNames.find(n => n === 'blk')
      ?? this.session.outputNames.find(n => isBlkShape(this.session!.outputMetadata, n))
      ?? ''
    this.segKey = this.session.outputNames.find(n => n === 'seg')
      ?? this.session.outputNames.find(n => isSegShape(this.session!.outputMetadata, n))
      ?? null
    if (this.session.inputNames.length) this.inputName = this.session.inputNames[0]
    if (!this.blkKey) {
      throw new Error(`CTD 找不到 blk 输出，实际输出：${this.session.outputNames.join(', ')}`)
    }
  }

  async release(): Promise<void> {
    if (!this.session) return
    await this.session.release()
    this.session = null
  }

  /**
   * @param imagePath 任意尺寸的图片；内部 letterbox 到 1024²
   * @returns boxes 已反变换回原图坐标；textMask 与原图等大
   */
  async detect(imagePath: string): Promise<DetectionResult & { pageWidth: number; pageHeight: number }> {
    const session = this.session
    if (!session) throw new Error('CTD 模型未加载')

    const meta = await sharp(imagePath, { limitInputPixels: 500_000_000 }).metadata()
    const pageWidth = meta.width ?? 0
    const pageHeight = meta.height ?? 0
    if (!pageWidth || !pageHeight) throw new Error(`无法读取图片尺寸：${imagePath}`)

    const input = await letterboxToTensor(imagePath, pageWidth, pageHeight)
    const outputs = await session.run({
      [this.inputName]: new ort.Tensor('float32', input, [BATCH, 3, INPUT_SIZE, INPUT_SIZE]),
    })

    try {
      const blk = outputs[this.blkKey] as ort.Tensor | undefined
      if (!blk) throw new Error('CTD 未返回 blk 输出')
      const candidates = decodeBlk(blk)
      const kept = nms(candidates, IOU_THRESHOLD)
      // 反 letterbox：padX/padY 恒为 0（左上对齐），所以只需除以 scale。
      const scale = Math.min(INPUT_SIZE / pageWidth, INPUT_SIZE / pageHeight)
      const boxes = kept.map(b => ({
        ...b,
        cx: b.cx / scale,
        cy: b.cy / scale,
        width: b.width / scale,
        height: b.height / scale,
      }))

      let textMask: TextMask | null = null
      if (this.segKey) {
        const seg = outputs[this.segKey] as ort.Tensor | undefined
        if (seg) textMask = decodeMask(seg, pageWidth, pageHeight, scale)
      }
      return { boxes, textMask, pageWidth, pageHeight }
    } finally {
      for (const key of Object.keys(outputs)) {
        try { (outputs as Record<string, ort.Tensor>)[key].dispose?.() } catch { /* 忽略释放失败 */ }
      }
    }
  }
}

function shapeOf(meta: readonly ort.InferenceSession.ValueMetadata[], name: string): readonly (string | number)[] {
  const value = meta.find(m => m.name === name)
  return value?.isTensor ? value.shape : []
}
/** blk 是 3 维，末维是 4(box) + 1(obj) + N 类，本模型 N=2。 */
function isBlkShape(meta: readonly ort.InferenceSession.ValueMetadata[], name: string): boolean {
  const s = shapeOf(meta, name)
  return s.length === 3 && Number(s[2]) >= 5 && Number(s[2]) <= 16
}
/** seg 是 4 维、单通道，同本页分辨率的文字概率图。 */
function isSegShape(meta: readonly ort.InferenceSession.ValueMetadata[], name: string): boolean {
  const s = shapeOf(meta, name)
  return s.length === 4 && Number(s[1]) === 1
}

/**
 * letterbox 到 1024² 并转 NCHW float32。
 * padding 靠 Float32Array 初始化为 0 天然实现黑色填充，只把缩放后的像素写进左上角。
 */
async function letterboxToTensor(imagePath: string, pageWidth: number, pageHeight: number): Promise<Float32Array> {
  const scale = Math.min(INPUT_SIZE / pageWidth, INPUT_SIZE / pageHeight)
  const newW = Math.max(1, Math.floor(pageWidth * scale))
  const newH = Math.max(1, Math.floor(pageHeight * scale))
  const { data, info } = await sharp(imagePath, { limitInputPixels: 500_000_000 })
    .resize(newW, newH, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const plane = INPUT_SIZE * INPUT_SIZE
  const out = new Float32Array(3 * plane)
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const src = (y * newW + x) * channels
      const dst = y * INPUT_SIZE + x
      out[dst] = data[src]! / 255
      out[plane + dst] = data[src + 1]! / 255
      out[2 * plane + dst] = data[src + 2]! / 255
    }
  }
  return out
}

/** 解码 YOLOv5 头：[cx, cy, w, h, obj, cls0, cls1, ...]，坐标已是 letterbox 像素空间。 */
function decodeBlk(tensor: ort.Tensor): DetectionBox[] {
  const dims = tensor.dims
  if (dims.length !== 3) throw new Error(`blk 维度异常：${dims}`)
  const n = Number(dims[1])
  const k = Number(dims[2])
  const buf = tensor.data as Float32Array
  const out: DetectionBox[] = []
  for (let i = 0; i < n; i++) {
    const off = i * k
    const obj = buf[off + 4]!
    if (obj < CONF_THRESHOLD) continue
    let maxCls = 1
    let clsId = 0
    if (k > 5) {
      maxCls = Number.NEGATIVE_INFINITY
      for (let c = 5; c < k; c++) {
        const v = buf[off + c]!
        if (v > maxCls) { maxCls = v; clsId = c - 5 }
      }
    }
    const conf = obj * maxCls
    if (conf < CONF_THRESHOLD) continue
    out.push({
      cx: buf[off]!, cy: buf[off + 1]!, width: buf[off + 2]!, height: buf[off + 3]!,
      confidence: conf, classId: clsId,
    })
  }
  return out
}

/** 贪心 NMS，class-agnostic。 */
export function nms(boxes: DetectionBox[], iouThreshold: number): DetectionBox[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence)
  const kept: DetectionBox[] = []
  while (sorted.length) {
    const best = sorted.shift()!
    kept.push(best)
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(best, sorted[i]!) > iouThreshold) sorted.splice(i, 1)
    }
  }
  return kept
}

export function iou(a: DetectionBox, b: DetectionBox): number {
  const ax1 = a.cx - a.width / 2, ay1 = a.cy - a.height / 2
  const ax2 = a.cx + a.width / 2, ay2 = a.cy + a.height / 2
  const bx1 = b.cx - b.width / 2, by1 = b.cy - b.height / 2
  const bx2 = b.cx + b.width / 2, by2 = b.cy + b.height / 2
  const xL = Math.max(ax1, bx1), yT = Math.max(ay1, by1)
  const xR = Math.min(ax2, bx2), yB = Math.min(ay2, by2)
  if (xR <= xL || yB <= yT) return 0
  const inter = (xR - xL) * (yB - yT)
  return inter / ((ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter)
}

/**
 * seg 是 letterbox 坐标系（1024²）的概率图，按最近邻采样映射回原图。
 * 上游 mask 分辨率可能低于 1024，这里通用化处理。
 */
function decodeMask(tensor: ort.Tensor, pageW: number, pageH: number, scale: number): TextMask | null {
  const dims = tensor.dims
  if (dims.length !== 4 || Number(dims[1]) !== 1) return null
  const mh = Number(dims[2])
  const mw = Number(dims[3])
  const src = tensor.data as Float32Array
  const mScaleX = mw / INPUT_SIZE
  const mScaleY = mh / INPUT_SIZE
  const data = new Uint8Array(pageW * pageH)
  for (let by = 0; by < pageH; by++) {
    const my = Math.min(mh - 1, Math.max(0, Math.floor(by * scale * mScaleY)))
    const myRow = my * mw
    const rowOff = by * pageW
    for (let bx = 0; bx < pageW; bx++) {
      const mx = Math.min(mw - 1, Math.max(0, Math.floor(bx * scale * mScaleX)))
      if (src[myRow + mx]! > MASK_THRESHOLD) data[rowOff + bx] = 1
    }
  }
  return { width: pageW, height: pageH, data }
}
