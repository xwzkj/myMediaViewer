/** 漫画翻译用的公共类型。坐标系契约：除标注外一律是「原图」分辨率。 */

/** CTD 输出的检测框，字段与 YOLOv5 头一致。 */
export interface DetectionBox {
  cx: number
  cy: number
  width: number
  height: number
  confidence: number
  /** 0 = text，1 = balloon */
  classId: number
}

/** 像素级文字 mask，坐标与传入的页面 bitmaps 一致。 */
export interface TextMask {
  width: number
  height: number
  /** 每字节 0/1，长度 = width * height */
  data: Uint8Array
}

export interface DetectionResult {
  boxes: DetectionBox[]
  textMask: TextMask | null
}

/** 一个文字块的识别结果。 */
export interface OcrRegion {
  text: string
  cx: number
  cy: number
  width: number
  height: number
  /** 检测框置信度（这个框是不是文字） */
  prob: number
  /** manga-ocr 自己对识别的置信度（每 token 最大概率的几何平均） */
  confidence: number
}

export function boxToRect(b: DetectionBox, pageW: number, pageH: number) {
  const left = Math.max(0, Math.floor(b.cx - b.width / 2))
  const top = Math.max(0, Math.floor(b.cy - b.height / 2))
  const right = Math.min(pageW, Math.ceil(b.cx + b.width / 2))
  const bottom = Math.min(pageH, Math.ceil(b.cy + b.height / 2))
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/**
 * 给检测框加一圈留白再送去 OCR。
 *
 * 这一步不是可选的：manga-ocr 看到紧贴文字的裁剪区会陷入重复幻觉，实测同一个框
 * 无 padding 时吐 265 个 token（约 1.5 秒）且内容是重复废话，加 padding 后只要
 * 68 个 token（约 0.2 秒）且内容正常。检测框本身紧贴文字，留白让模型看到气泡
 * 边缘和背景，输出才稳定。
 */
export function paddedRect(rect: { left: number; top: number; width: number; height: number }, pageW: number, pageH: number) {
  const padding = Math.max(3, Math.round(Math.min(rect.width, rect.height) * 0.04))
  const left = Math.max(0, rect.left - padding)
  const top = Math.max(0, rect.top - padding)
  const right = Math.min(pageW, rect.left + rect.width + padding)
  const bottom = Math.min(pageH, rect.top + rect.height + padding)
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}
