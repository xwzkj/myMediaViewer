import sharp from 'sharp'
import type { TextMask } from './types.js'

export interface EraseRegion {
  left: number
  top: number
  width: number
  height: number
}

export interface ErasedPage {
  data: Buffer
  width: number
  height: number
  colors: Array<{ background: string; textColor: string }>
}

/**
 * 擦除已翻译的漫画文字。
 *
 * CTD 的 seg mask 已经很贴笔画，但抗锯齿边缘常留下一圈灰。这里按 8 邻域膨胀
 * 1px（不做多轮，避免把相邻笔画和气泡边线粘成块），再用每个框边缘的非文字像素
 * 估一个主色回填。框内没有 mask 输出时退化为填满该框，保证不会把日文留在译文下面。
 */
export async function eraseTranslatedRegions(
  imagePath: string,
  pageWidth: number,
  pageHeight: number,
  textMask: TextMask | null,
  regions: EraseRegion[],
): Promise<ErasedPage> {
  const { data, info } = await sharp(imagePath, { limitInputPixels: 500_000_000 })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.width !== pageWidth || info.height !== pageHeight) {
    throw new Error(`图片尺寸在检测后发生变化：${pageWidth}x${pageHeight} -> ${info.width}x${info.height}`)
  }

  const channels = info.channels
  const mask = textMask && textMask.width === pageWidth && textMask.height === pageHeight ? textMask.data : null
  const colors: Array<{ background: string; textColor: string }> = []

  for (const region of regions) {
    const rect = clampRect(region, pageWidth, pageHeight)
    if (!rect.width || !rect.height) {
      colors.push({ background: '#ffffff', textColor: '#111111' })
      continue
    }
    const fill = estimateBackground(data, channels, pageWidth, pageHeight, rect, mask)
    colors.push({ background: rgbToHex(fill), textColor: luminance(fill) > 160 ? '#111111' : '#ffffff' })
    fillRegion(data, channels, pageWidth, pageHeight, rect, mask, fill)
  }

  return { data, width: pageWidth, height: pageHeight, colors }
}

function clampRect(region: EraseRegion, width: number, height: number): EraseRegion {
  const left = Math.max(0, Math.min(width, Math.floor(region.left)))
  const top = Math.max(0, Math.min(height, Math.floor(region.top)))
  const right = Math.max(left, Math.min(width, Math.ceil(region.left + region.width)))
  const bottom = Math.max(top, Math.min(height, Math.ceil(region.top + region.height)))
  return { left, top, width: right - left, height: bottom - top }
}

function maskedNear(mask: Uint8Array | null, width: number, height: number, x: number, y: number): boolean {
  if (!mask) return true
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy
    if (yy < 0 || yy >= height) continue
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx
      if (xx < 0 || xx >= width) continue
      if (mask[yy * width + xx]) return true
    }
  }
  return false
}

function estimateBackground(
  data: Buffer,
  channels: number,
  pageWidth: number,
  pageHeight: number,
  rect: EraseRegion,
  mask: Uint8Array | null,
): [number, number, number] {
  const border = Math.max(2, Math.round(Math.min(rect.width, rect.height) * 0.12))
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const edge = x < rect.left + border || x >= rect.left + rect.width - border
        || y < rect.top + border || y >= rect.top + rect.height - border
      if (mask) {
        if (!edge) continue
        if (maskedNear(mask, pageWidth, pageHeight, x, y)) continue
      } else if (!edge) {
        continue
      }
      const offset = (y * pageWidth + x) * channels
      const r = data[offset]!
      const g = data[offset + 1]!
      const b = data[offset + 2]!
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
      bin.count++
      bin.r += r; bin.g += g; bin.b += b
      bins.set(key, bin)
    }
  }
  let best: { count: number; r: number; g: number; b: number } | null = null
  for (const bin of bins.values()) if (!best || bin.count > best.count) best = bin
  if (!best) return [255, 255, 255]
  return [Math.round(best.r / best.count), Math.round(best.g / best.count), Math.round(best.b / best.count)]
}

function fillRegion(
  data: Buffer,
  channels: number,
  pageWidth: number,
  pageHeight: number,
  rect: EraseRegion,
  mask: Uint8Array | null,
  fill: [number, number, number],
): void {
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      if (!maskedNear(mask, pageWidth, pageHeight, x, y)) continue
      const offset = (y * pageWidth + x) * channels
      data[offset] = fill[0]
      data[offset + 1] = fill[1]
      data[offset + 2] = fill[2]
      if (channels > 3) data[offset + 3] = 255
    }
  }
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}
