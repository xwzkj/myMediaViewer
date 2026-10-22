import type { Work } from '../shared/types.js'

export type SortDirection = 'newest' | 'oldest'

/** 媒体已确认不可用的作品（server/pixiv/catalog.ts 归一化时写入 Work.unavailable）。 */
export function isUnavailableWork(work: Pick<Work, 'unavailable'>): boolean {
  return work.unavailable === true
}

/**
 * 作品是否带真实收藏序号。
 *
 * server/scanner.ts 过去在文件名里解析不出收藏序号时，会把 updated（毫秒时间戳）
 * 当成 collected 写进库，于是这些「没有序号」的作品在按收藏时间排序时永远排在最前
 * （Pixiv 的真实 bmk_id 是亿级，和毫秒时间戳差三个数量级）。判定规则：
 *   - collected <= 0：明确没有序号（新扫描统一写 0）；
 *   - collected === updated：老库里留下的 updated 兜底值。
 * 两种情况都归入「无序号」组，稳定地排在有真实序号的作品之后；存量数据不必迁移。
 */
export function hasCollectedSequence(work: Pick<Work, 'collected' | 'updated'>): boolean {
  return Number.isFinite(work.collected) && work.collected > 0 && work.collected !== work.updated
}

function byUpdated(a: Work, b: Work, direction: SortDirection): number {
  return direction === 'newest' ? b.updated - a.updated : a.updated - b.updated
}

function byId(a: Work, b: Work): number {
  return a.id.localeCompare(b.id)
}

/**
 * 发布日期排序（「最新 / 最早」= newest / oldest）。
 *
 * 收藏夹里已删除/不可见的作品可能没有 create_date，日期不可信；直接比日期会让它们
 * 排到最前面（第一屏全是死缩略图）。所以媒体不可用的作品一律排在可用作品之后，
 * 组内仍保持用户选择的方向，再用 updated / id 作次级键，保证同一份输入下顺序确定：
 * 翻页不会重排，也不会漏项。可用作品的相对顺序与过去完全一致。
 */
export function compareWorksByDate(a: Work, b: Work, direction: SortDirection): number {
  return Number(isUnavailableWork(a)) - Number(isUnavailableWork(b))
    || (direction === 'newest' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date))
    || byUpdated(a, b, direction)
    || byId(a, b)
}

/**
 * 收藏顺序排序。分三档：有真实序号 > 无序号 > 媒体不可用；档内按用户选择的方向比
 * 较序号（无序号档退化为 updated），最后用 id 收尾。这样即使老库里存着
 * collected = updated 的兜底值，它们也不会再霸占列表最前面。
 */
export function compareWorksByCollected(a: Work, b: Work, direction: SortDirection): number {
  const rank = (work: Work) => isUnavailableWork(work) ? 2 : hasCollectedSequence(work) ? 0 : 1
  return rank(a) - rank(b)
    || (direction === 'newest' ? b.collected - a.collected : a.collected - b.collected)
    || byUpdated(a, b, direction)
    || byId(a, b)
}
