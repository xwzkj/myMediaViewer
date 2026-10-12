export const pixivSearchTargets = [
  { value: 'partial_match_for_tags', label: '标签部分一致' },
  { value: 'exact_match_for_tags', label: '标签完全一致' },
  { value: 'title_and_caption', label: '标题、简介' },
  { value: 'keyword', label: '标签、标题、简介' },
] as const

export type PixivSearchTarget = typeof pixivSearchTargets[number]['value']
export const defaultPixivSearchTarget: PixivSearchTarget = 'partial_match_for_tags'

export function isPixivSearchTarget(value: unknown): value is PixivSearchTarget {
  return pixivSearchTargets.some(target => target.value === value)
}
