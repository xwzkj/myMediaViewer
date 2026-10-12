import type { MediaKind, PixivBookmarkRestrict, Work } from '../../shared/types.js'

export interface PixivRawTag { name?: string; translated_name?: string | null }
export interface PixivRawUser { id?: number | string; name?: string; account?: string }
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
  ugoira?: PixivUgoiraMeta
  kind: MediaKind
}
export interface PixivStoredWork { work: Work; meta: PixivWorkMeta }
export interface PixivBookmarkRecord { work: Work; restrict: PixivBookmarkRestrict; sequence: number }
