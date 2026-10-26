import { defaultPixivSearchTarget, isPixivSearchTarget, type PixivSearchTarget } from './pixiv-search.js'

/**
 * 筛选/排序等浏览偏好的唯一契约。
 *
 * 服务端持久化，前端启动时一次性取回，写入时按 scope 增量保存。
 * 语义搜索开关属于本地搜索结果页的筛选条件，只放在 localSearch 里。
 */

export type LibraryScope = 'works' | 'localSearch' | 'cloudSearch' | 'cloudFavorites' | 'recommendation'
export type SearchSource = 'local' | 'cloud'
export type LibraryView = 'library' | 'favorites'
export type LibraryKind = '' | 'image' | 'video'
export type LibraryOrder = 'collected' | 'published'
export type WorksSort = 'newest' | 'oldest' | 'title' | 'random'
export type LocalSort = 'relevance' | WorksSort

/** 所有可持久化 scope；顺序固定，便于 API 文档与测试断言。 */
export const libraryScopes = ['works', 'localSearch', 'cloudSearch', 'cloudFavorites', 'recommendation'] as const

export function isLibraryScope(value: unknown): value is LibraryScope {
  return typeof value === 'string' && (libraryScopes as readonly string[]).includes(value)
}

export interface LibraryWorksState {
  view: LibraryView
  source: string
  kind: LibraryKind
  fuzzy: boolean
  sort: WorksSort
  order: LibraryOrder
  seed: string
}

export interface LocalSearchState {
  source: string
  kind: LibraryKind
  fuzzy: boolean
  /** 画面语义（CLIP 以文搜图）开关；仅在本地搜索结果页可见。 */
  semantic: boolean
  sort: LocalSort
  order: LibraryOrder
  seed: string
}

export type CloudSearchEntity = 'works' | 'users'

export interface CloudSearchState {
  sort: 'popular_preview' | 'date_desc' | 'date_asc'
  target: PixivSearchTarget
  entity: CloudSearchEntity
}

export interface CloudFavoritesState {
  restrict: 'public' | 'private'
}

export interface RecommendationState {
  source: SearchSource
}

export interface LibraryStateMap {
  works: LibraryWorksState
  localSearch: LocalSearchState
  cloudSearch: CloudSearchState
  cloudFavorites: CloudFavoritesState
  recommendation: RecommendationState
}

export function asCloudSearchEntity(value: unknown): CloudSearchEntity {
  return value === 'users' ? 'users' : 'works'
}

export function defaultLibraryState(): LibraryStateMap {
  return {
    works: { view: 'library', source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', seed: '' },
    localSearch: { source: '', kind: '', fuzzy: false, semantic: false, sort: 'relevance', order: 'published', seed: '' },
    cloudSearch: { sort: 'popular_preview', target: defaultPixivSearchTarget, entity: 'works' },
    cloudFavorites: { restrict: 'public' },
    recommendation: { source: 'local' },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function asSeed(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asLocalSource(value: unknown): string {
  return typeof value === 'string' && !value.startsWith('pixiv:') ? value : ''
}

export function normalizeLibraryState(scope: 'works', value: unknown): LibraryWorksState
export function normalizeLibraryState(scope: 'localSearch', value: unknown): LocalSearchState
export function normalizeLibraryState(scope: 'cloudSearch', value: unknown): CloudSearchState
export function normalizeLibraryState(scope: 'cloudFavorites', value: unknown): CloudFavoritesState
export function normalizeLibraryState(scope: 'recommendation', value: unknown): RecommendationState
export function normalizeLibraryState(scope: LibraryScope, value: unknown): LibraryStateMap[LibraryScope]
export function normalizeLibraryState(scope: LibraryScope, value: unknown): LibraryStateMap[LibraryScope] {
  const raw = asRecord(value)
  if (scope === 'works') {
    return {
      view: raw.view === 'favorites' ? 'favorites' : 'library',
      source: asLocalSource(raw.source),
      kind: asString(raw.kind, ['', 'image', 'video'] as const, ''),
      fuzzy: raw.fuzzy === true,
      sort: asString(raw.sort, ['newest', 'oldest', 'title', 'random'] as const, 'newest'),
      order: asString(raw.order, ['collected', 'published'] as const, 'collected'),
      seed: asSeed(raw.seed),
    }
  }
  if (scope === 'localSearch') {
    return {
      source: asLocalSource(raw.source),
      kind: asString(raw.kind, ['', 'image', 'video'] as const, ''),
      fuzzy: raw.fuzzy === true,
      semantic: raw.semantic === true,
      sort: asString(raw.sort, ['relevance', 'newest', 'oldest', 'title', 'random'] as const, 'relevance'),
      order: asString(raw.order, ['collected', 'published'] as const, 'published'),
      seed: asSeed(raw.seed),
    }
  }
  if (scope === 'cloudSearch') {
    return {
      sort: asString(raw.sort, ['popular_preview', 'date_desc', 'date_asc'] as const, 'popular_preview'),
      target: isPixivSearchTarget(raw.target) ? raw.target : defaultPixivSearchTarget,
      entity: asCloudSearchEntity(raw.entity),
    }
  }
  if (scope === 'cloudFavorites') return { restrict: raw.restrict === 'private' ? 'private' : 'public' }
  return { source: raw.source === 'cloud' ? 'cloud' : 'local' }
}
