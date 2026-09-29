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
