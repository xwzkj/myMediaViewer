import type { OcrRegion } from './types.js'

/**
 * 过滤与排序规则，阈值全部对齐 Pixiv-Shaft 的 MangaOcr.kt。
 * 这些数字是在真实漫画上攒出来的，不要凭感觉调。
 */

/** CTD 自身已按 0.4 筛过，这里再兜一道。 */
export const MIN_DETECTION_PROB = 0.3
/** manga-ocr 自己的置信度下限。真文本典型 0.6-0.95，噪声幻觉通常 < 0.3。 */
export const MIN_RECOG_CONFIDENCE = 0.3
/** 单字 region 需要两个置信度同时达到这个值才认。 */
export const STRICT_SINGLE_CHAR_CONFIDENCE = 0.85

/** 省略号、句末符号、各种括号引号 —— 不计入「实际字符」。 */
const PUNCTUATION_TO_IGNORE = new Set([
  '.', '…', '。', ',', '、', ' ', '\n', '\t',
  '!', '！', '?', '？', '~', '〜', '・',
  '〈', '〉', '《', '》', '「', '」', '『', '』', '【', '】',
  '(', ')', '（', '）', '[', ']', '［', '］',
  '"', '\'', '‘', '’', '“', '”',
])

/**
 * manga-ocr 在真气泡识别完后常多吐一个尾部括号字（实测「フォルネウス王子〉」这类）。
 * 只 trim 这些不会合法出现在句末的字符 —— ! ? 是合法句末，不能动。
 */
const TRAILING_NOISE_CHARS = new Set([
  '〈', '〉', '《', '》', '「', '」', '『', '』', '【', '】',
  '(', ')', '（', '）', '[', ']', '［', '］', '〔', '〕',
  '"', '\'', '‘', '’', '“', '”',
])

export function trimTrailingNoise(text: string): string {
  let end = text.length
  while (end > 0 && TRAILING_NOISE_CHARS.has(text[end - 1]!)) end--
  return text.slice(0, end)
}

/** region 短边的合理性下限：按图短边的 0.8% 估算小字，最低 8px。 */
export function minRegionShortSide(imageShortEdge: number): number {
  return Math.max(imageShortEdge * 0.008, 8)
}

/** 是否含日文假名或汉字。 */
export function hasJapanese(text: string): boolean {
  return /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(text)
}

export interface RegionVerdict {
  keep: boolean
  reasons: string[]
}

/**
 * 按上游规则判断一个 region 是否值得保留。
 * 不直接丢弃而是返回原因，便于调试阶段观察被过滤掉的内容。
 */
export function judgeRegion(
  region: OcrRegion,
  imageShortEdge: number,
): RegionVerdict {
  const reasons: string[] = []
  if (region.prob < MIN_DETECTION_PROB) reasons.push(`det ${region.prob.toFixed(2)}<${MIN_DETECTION_PROB}`)
  if (region.confidence < MIN_RECOG_CONFIDENCE) reasons.push(`ocr ${region.confidence.toFixed(2)}<${MIN_RECOG_CONFIDENCE}`)

  const minSide = minRegionShortSide(imageShortEdge)
  const shortSide = Math.min(region.width, region.height)
  if (shortSide < minSide) reasons.push(`box ${shortSide.toFixed(0)}px<${minSide.toFixed(0)}px`)

  const coreChars = [...region.text].filter(c => !PUNCTUATION_TO_IGNORE.has(c)).length
  if (coreChars === 0) reasons.push('no content')
  else if (!hasJapanese(region.text)) reasons.push('not ja')
  else if (coreChars < 2
    && !(region.prob >= STRICT_SINGLE_CHAR_CONFIDENCE && region.confidence >= STRICT_SINGLE_CHAR_CONFIDENCE)) {
    reasons.push('single char & low conf')
  }
  return { keep: reasons.length === 0, reasons }
}

/**
 * 阅读顺序：cy 升序贪心分行（下一个 region 的 cy 落在当前行累计纵向区间内就并入），
 * 每行内按 cx 从右到左 —— 日漫是右起排版。
 */
export function mangaReadingOrder(regions: OcrRegion[]): OcrRegion[] {
  if (regions.length <= 1) return [...regions]
  const byCy = [...regions].sort((a, b) => a.cy - b.cy)
  const rows: OcrRegion[][] = []
  for (const region of byCy) {
    const current = rows[rows.length - 1]
    if (!current) { rows.push([region]); continue }
    const rowBottom = Math.max(...current.map(r => r.cy + r.height / 2))
    if (region.cy - region.height / 2 < rowBottom) current.push(region)
    else rows.push([region])
  }
  return rows.flatMap(row => row.sort((a, b) => b.cx - a.cx))
}
