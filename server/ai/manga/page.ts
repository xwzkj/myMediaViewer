import sharp from 'sharp'

/**
 * 单页工作分辨率上限：超过这个像素数的源图会先等比缩小再识别。
 *
 * 40 MP 不是模型要求（检测固定 1024²、OCR 裁剪 224²），而是内存上限：
 * 整页 RGB、文字 mask、RGBA 擦字覆盖层和 PNG 编码都按页面像素数分配。
 */
export const MAX_PAGE_PIXELS = 40_000_000
/**
 * 源图绝对上限。再大就不做缩放，直接拒绝，避免一张解压炸弹把进程内存打满。
 * 1 亿像素约等于 11500×8700，已经覆盖常见超大 Pixiv 原图。
 */
export const MAX_SOURCE_PIXELS = 100_000_000

/** 已解码的整页 RGB；用于缩放后避免反复解码同一张大图。 */
export type PageImage = string | { data: Buffer; width: number; height: number; channels: 3 }

export interface PixelRect { left: number; top: number; width: number; height: number }

export interface PagePlan {
  /** 实际送进检测/OCR/擦字的页面尺寸。 */
  width: number
  height: number
  /** 工作坐标 × scaleX = 原图 x 坐标；scaleY 同理。 */
  scaleX: number
  scaleY: number
}

/** 统一的 sharp 入口：路径按文件读取，已解码页面按 raw 读取。 */
export function pageSharp(image: PageImage): sharp.Sharp {
  return typeof image === 'string'
    ? sharp(image, { limitInputPixels: MAX_SOURCE_PIXELS })
    : sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } })
}

export async function pageSize(image: PageImage): Promise<{ width: number; height: number }> {
  if (typeof image !== 'string') return { width: image.width, height: image.height }
  // 只读文件头，不分配整页像素；真正的解码上限由 MAX_SOURCE_PIXELS 控制。
  const metadata = await sharp(image, { limitInputPixels: false }).metadata()
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 }
}

/**
 * 计算工作尺寸。小于上限时原样返回；超过时按面积等比缩小，保证宽高都是整数
 * 且乘积不超过上限，并返回精确的坐标缩放比（x/y 分开，避免非等比尺寸误差）。
 */
export function planPageScale(sourceWidth: number, sourceHeight: number, maxPixels = MAX_PAGE_PIXELS): PagePlan {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error('页面尺寸无效')
  }
  const pixels = sourceWidth * sourceHeight
  if (pixels <= maxPixels) return { width: sourceWidth, height: sourceHeight, scaleX: 1, scaleY: 1 }

  const ratio = Math.sqrt(maxPixels / pixels)
  let width = Math.max(1, Math.floor(sourceWidth * ratio))
  let height = Math.max(1, Math.floor(sourceHeight * ratio))
  // 极端长宽比下 floor 后仍可能超出；按实际乘积再收几轮，最后兜底钳制。
  for (let attempt = 0; attempt < 8 && width * height > maxPixels; attempt++) {
    const correction = Math.sqrt(maxPixels / (width * height))
    width = Math.max(1, Math.floor(width * correction))
    height = Math.max(1, Math.floor(height * correction))
  }
  if (width * height > maxPixels) {
    if (width >= height) width = Math.max(1, Math.floor(maxPixels / height))
    else height = Math.max(1, Math.floor(maxPixels / width))
  }
  return { width, height, scaleX: sourceWidth / width, scaleY: sourceHeight / height }
}

/** 把工作分辨率下的透明覆盖层缩放到原图并编码成 PNG。 */
export async function encodeOverlayPng(
  overlay: Buffer,
  workingWidth: number,
  workingHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Buffer> {
  let pipeline = sharp(overlay, { raw: { width: workingWidth, height: workingHeight, channels: 4 } })
  if (workingWidth !== sourceWidth || workingHeight !== sourceHeight) {
    // 最近邻放大：透明边缘不会被插值成半透明，避免原文残影。
    pipeline = pipeline.resize(sourceWidth, sourceHeight, { fit: 'fill', kernel: 'nearest' })
  }
  return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
}

/** 把工作坐标里的矩形映射回原图，并保证落在页面内、宽高至少 1px。 */
export function scaleRectToSource(rect: PixelRect, plan: PagePlan, sourceWidth: number, sourceHeight: number): PixelRect {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const left = clamp(Math.round(rect.left * plan.scaleX), 0, Math.max(0, sourceWidth - 1))
  const top = clamp(Math.round(rect.top * plan.scaleY), 0, Math.max(0, sourceHeight - 1))
  const right = clamp(Math.round((rect.left + rect.width) * plan.scaleX), left + 1, sourceWidth)
  const bottom = clamp(Math.round((rect.top + rect.height) * plan.scaleY), top + 1, sourceHeight)
  return { left, top, width: right - left, height: bottom - top }
}
