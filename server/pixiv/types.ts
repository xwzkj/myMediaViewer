import type { MediaKind, PixivBookmarkRestrict, PixivUserProfile, PixivUserSummary, Work } from '../../shared/types.js'

export interface PixivRawTag { name?: string; translated_name?: string | null }
export interface PixivRawUser {
  id?: number | string
  name?: string
  account?: string
  comment?: string
  is_followed?: boolean
  profile_image_urls?: { medium?: string }
}
export interface PixivRawImageUrls {
  square_medium?: string
  medium?: string
  large?: string
  original?: string
}
export interface PixivRawPage { image_urls?: PixivRawImageUrls }
export interface PixivRawIllust {
  id?: number | string
  title?: string
  caption?: string
  create_date?: string
  page_count?: number
  width?: number
  height?: number
  type?: string
  user?: PixivRawUser
  tags?: PixivRawTag[]
  image_urls?: PixivRawImageUrls
  meta_single_page?: { original_image_url?: string }
  meta_pages?: PixivRawPage[]
  total_bookmarks?: number
  total_view?: number
  is_bookmarked?: boolean
  illust_ai_type?: number
  x_restrict?: number
  sanity_level?: number
  visible?: boolean
}
export interface PixivPageMeta {
  page: number
  preview: string
  original: string
  width?: number
  height?: number
}
export interface PixivUgoiraMeta {
  zipUrl: string
  frames: Array<{ file: string; delay: number }>
}
export interface PixivWorkMeta {
  pages: PixivPageMeta[]
  bookmarkTags?: string[]
  detailFetchedAt?: number
  /**
   * 画师 ID 回填检查的时间戳（版本化 marker，30 分钟 TTL）。
   * detail 抓取时必写：上游有 user 则回填 UID，无则仅留此标记避免重复抓取。
   */
  userCheckedAt?: number
  ugoira?: PixivUgoiraMeta
  kind: MediaKind
}
export interface PixivStoredWork { work: Work; meta: PixivWorkMeta }
export interface PixivBookmarkRecord { work: Work; restrict: PixivBookmarkRestrict; sequence: number }
/** v2/user/detail 原始响应：仅取公开档案字段，缺失一律降级为 undefined。 */
export interface PixivRawUserDetail {
  user?: PixivRawUser
  profile?: {
    webpage?: string
    gender?: string
    birth?: string
    birth_day?: string
    birth_year?: number | string
    region?: string
    address_id?: number | string
    country_code?: string
    job?: string
    job_id?: number | string
    total_follow_users?: number | string
    total_mypixiv_users?: number | string
    total_illusts?: number | string
    total_manga?: number | string
    total_novels?: number | string
    total_illust_bookmarks_public?: number | string
    background_image_url?: string
    twitter_account?: string
    twitter_url?: string
    pawoo_url?: string
    is_premium?: boolean
    is_using_custom_profile_image?: boolean
  }
  workspace?: Record<string, string | undefined>
}
/** v1/search/user 原始响应：单项只取 user 部分，不做作品归一化。 */
export interface PixivRawUserPreview {
  user?: PixivRawUser
  illusts?: PixivRawIllust[]
  novels?: unknown
  is_muted?: boolean
}
export interface PixivUserSearchPage { user_previews?: PixivRawUserPreview[]; next_url?: string | null }
export interface PixivNormalizedUser { profile: PixivUserProfile; summary: PixivUserSummary }
