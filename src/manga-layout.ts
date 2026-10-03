/**
 * 漫画译文的排版：把一段译文塞进检测框里，横排塞不下、或者窄高气泡横排后
 * 每行只剩两三个字时改用竖排（从左往右），列内自上而下。
 *
 * 这里只做「选哪种排法、每行/每列放哪些字、用多大字号」，具体绘制由调用方
 * 负责，便于用假的测量上下文做单元测试。
 */

export const MANGA_FONT_FAMILY = '"Noto Sans SC","Microsoft YaHei","PingFang SC",sans-serif'
export const MANGA_LINE_HEIGHT = 1.14
export const MANGA_COLUMN_PITCH = 1.05
export const MANGA_MIN_FONT_SIZE = 7
/** 竖排字号不得小于横排的这个比例，避免为了竖排把字缩得太小。 */
const VERTICAL_MIN_FONT_RATIO = 0.85

/** 只用到绘制文字需要的这些 Canvas 能力，便于在测试里替换。 */
export interface TextDrawContext extends TextMeasureContext {
  save(): void
  restore(): void
  beginPath(): void
  rect(x: number, y: number, width: number, height: number): void
  clip(): void
  fillText(text: string, x: number, y: number): void
  fillStyle: string | CanvasGradient | CanvasPattern
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
}

/** 只用到 measureText 和 font，方便测试里用假实现。 */
export interface TextMeasureContext {
  font: string
  measureText(text: string): { width: number }
}

/** 绘制一页里某个气泡需要的字段。 */
export interface MangaDrawRegion {
  x: number
  y: number
  width: number
  height: number
  translation: string
  textColor?: string
}

export interface MangaTextLayout {
  size: number
  /** true 表示 lines 是竖排列（每列自上而下，整体从左往右），否则是横排行。 */
  vertical: boolean
  lines: string[]
}

/**
 * 窄高的气泡里横排每行只剩两三个字，读起来很费劲，所以对以方块字为主的
 * 译文改用竖排。只有竖排确实更划算时才用：字号不能比横排小太多，每列字数
 * 也必须比横排每行多，否则仍走横排。
 */
export function chooseMangaTextLayout(
  ctx: TextMeasureContext,
  text: string,
  maxWidth: number,
  maxHeight: number,
): MangaTextLayout {
  const horizontal = fitHorizontalText(ctx, text, maxWidth, maxHeight)
  if (maxHeight <= maxWidth) return horizontal
  const chars = [...text.replace(/\s*\r?\n\s*/g, '')]
  if (!isVerticalFriendly(chars)) return horizontal
  const vertical = fitVerticalText(ctx, chars, maxWidth, maxHeight)
  if (!vertical) return horizontal
  if (vertical.size < horizontal.size * VERTICAL_MIN_FONT_RATIO) return horizontal
  if (longestLineLength(vertical.lines) <= longestLineLength(horizontal.lines)) return horizontal
  return vertical
}

/** 横排：从大到小找到能塞进区域的字号，都塞不下时用最小字号并交给调用方裁剪。 */
export function fitHorizontalText(ctx: TextMeasureContext, text: string, maxWidth: number, maxHeight: number): MangaTextLayout {
  const maxSize = Math.max(8, Math.floor(Math.min(maxWidth, maxHeight)))
  for (let size = maxSize; size >= MANGA_MIN_FONT_SIZE; size--) {
    const lines = wrapCanvasText(ctx, text, size, MANGA_FONT_FAMILY, maxWidth)
    if (lines.every(line => ctx.measureText(line).width <= maxWidth) && lines.length * size * MANGA_LINE_HEIGHT <= maxHeight) {
      return { size, lines, vertical: false }
    }
  }
  return { size: MANGA_MIN_FONT_SIZE, lines: wrapCanvasText(ctx, text, MANGA_MIN_FONT_SIZE, MANGA_FONT_FAMILY, maxWidth), vertical: false }
}

/** 竖排：按字号算出每列能放几个字，再要求所有列加起来的宽度不超出气泡。 */
export function fitVerticalText(ctx: TextMeasureContext, chars: string[], maxWidth: number, maxHeight: number): MangaTextLayout | null {
  const maxSize = Math.max(8, Math.floor(Math.min(maxWidth, maxHeight)))
  for (let size = maxSize; size >= MANGA_MIN_FONT_SIZE; size--) {
    const pitch = size * MANGA_COLUMN_PITCH
    const perColumn = Math.max(1, Math.floor(maxHeight / pitch))
    const columns = Math.ceil(chars.length / perColumn)
    if (columns * pitch > maxWidth) continue
    ctx.font = `600 ${size}px ${MANGA_FONT_FAMILY}`
    let widest = 0
    for (const char of chars) widest = Math.max(widest, ctx.measureText(char).width)
    if (widest > maxWidth) continue
    const lines: string[] = []
    for (let i = 0; i < chars.length; i += perColumn) lines.push(chars.slice(i, i + perColumn).join(''))
    return { size, lines, vertical: true }
  }
  return null
}

/** 竖排只适合方块字：英文、数字竖起来会变成一列难认的单字母。 */
export function isVerticalFriendly(chars: string[]): boolean {
  if (!chars.length) return false
  let wide = 0
  for (const char of chars) if (isCjkChar(char)) wide++
  return wide * 2 >= chars.length
}

export function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) || 0
  return (code >= 0x2e80 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)
    || (code >= 0x20000 && code <= 0x2ffff)
}

export function longestLineLength(lines: string[]): number {
  let longest = 0
  for (const line of lines) longest = Math.max(longest, [...line].length)
  return longest
}

export function wrapCanvasText(
  ctx: TextMeasureContext,
  text: string,
  size: number,
  family: string,
  maxWidth: number,
): string[] {
  ctx.font = `600 ${size}px ${family}`
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    for (const char of paragraph) {
      const next = line + char
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line = next
      }
    }
    lines.push(line)
  }
  return lines.length ? lines : [text]
}

export function drawMangaRegion(ctx: TextDrawContext, region: MangaDrawRegion) {
  const translation = region.translation.trim()
  if (!translation) return
  const padding = Math.max(2, Math.round(Math.min(region.width, region.height) * 0.06))
  const maxWidth = Math.max(4, region.width - padding * 2)
  const maxHeight = Math.max(4, region.height - padding * 2)
  const layout = chooseMangaTextLayout(ctx, translation, maxWidth, maxHeight)
  ctx.save()
  ctx.beginPath()
  ctx.rect(region.x + 1, region.y + 1, Math.max(1, region.width - 2), Math.max(1, region.height - 2))
  ctx.clip()
  ctx.fillStyle = region.textColor || '#111111'
  ctx.font = `600 ${layout.size}px ${MANGA_FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (layout.vertical) {
    // 竖排：从左往右排列，列内自上而下，整块文字在气泡里居中。
    const pitch = layout.size * MANGA_COLUMN_PITCH
    const blockWidth = layout.lines.length * pitch
    const firstX = region.x + (region.width - blockWidth) / 2 + pitch / 2
    layout.lines.forEach((column, columnIndex) => {
      const x = firstX + columnIndex * pitch
      const startY = region.y + (region.height - (column.length - 1) * pitch) / 2
      for (let i = 0; i < column.length; i++) ctx.fillText(column[i]!, x, startY + i * pitch)
    })
  } else {
    const lineHeight = layout.size * MANGA_LINE_HEIGHT
    const startY = region.y + (region.height - layout.lines.length * lineHeight) / 2 + lineHeight / 2
    const centerX = region.x + region.width / 2
    layout.lines.forEach((line, index) => ctx.fillText(line, centerX, startY + index * lineHeight))
  }
  ctx.restore()
}
