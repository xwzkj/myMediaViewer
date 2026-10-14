import { defaultPixivSearchTarget, isPixivSearchTarget, type PixivSearchTarget } from '../shared/pixiv-search'

export type LibraryScope = 'works' | 'localSearch' | 'cloudSearch' | 'cloudFavorites'
export type SearchSource = 'local' | 'cloud'

export interface LibraryWorksState {
  view: 'library' | 'favorites'
  source: string
  kind: '' | 'image' | 'video'
  fuzzy: boolean
  sort: 'newest' | 'oldest' | 'title' | 'random'
  order: 'collected' | 'published'
  seed: string
}

export interface LocalSearchState {
  source: string
  kind: '' | 'image' | 'video'
  fuzzy: boolean
  sort: 'relevance' | 'newest' | 'oldest' | 'title' | 'random'
  order: 'collected' | 'published'
  seed: string
}

export type CloudSearchEntity = 'works' | 'users'

export function asCloudSearchEntity(value: unknown): CloudSearchEntity {
  return value === 'users' ? 'users' : 'works'
}

export interface CloudSearchState { sort: 'popular_preview' | 'date_desc' | 'date_asc'; target: PixivSearchTarget; entity: CloudSearchEntity }
export interface CloudFavoritesState { restrict: 'public' | 'private' }
export interface LibraryStateMap {
  works: LibraryWorksState
  localSearch: LocalSearchState
  cloudSearch: CloudSearchState
  cloudFavorites: CloudFavoritesState
}

const keys: Record<LibraryScope, string> = {
  works: 'library.works.v2',
  localSearch: 'library.localSearch.v2',
  cloudSearch: 'library.cloudSearch.v2',
  cloudFavorites: 'library.cloudFavorites.v2',
}

const defaults: LibraryStateMap = {
  works: { view: 'library', source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', seed: '' },
  localSearch: { source: '', kind: '', fuzzy: false, sort: 'relevance', order: 'published', seed: '' },
  cloudSearch: { sort: 'popular_preview', target: defaultPixivSearchTarget, entity: 'works' },
  cloudFavorites: { restrict: 'public' },
}

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage }
  catch { return null }
}

function readJson(key: string): unknown {
  try {
    const value = storage()?.getItem(key)
    return value ? JSON.parse(value) : null
  } catch { return null }
}

function writeJson(key: string, value: unknown): void {
  try { storage()?.setItem(key, JSON.stringify(value)) } catch { /* Best-effort UI memory. */ }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function normalizeWorks(value: unknown): LibraryWorksState {
  const raw = asRecord(value)
  return {
    view: raw.view === 'favorites' ? 'favorites' : 'library',
    source: typeof raw.source === 'string' && !raw.source.startsWith('pixiv:') ? raw.source : '',
    kind: asString(raw.kind, ['', 'image', 'video'] as const, ''),
    fuzzy: raw.fuzzy === true,
    sort: asString(raw.sort, ['newest', 'oldest', 'title', 'random'] as const, 'newest'),
    order: asString(raw.order, ['collected', 'published'] as const, 'collected'),
    seed: typeof raw.seed === 'string' ? raw.seed : '',
  }
}

function normalizeLocalSearch(value: unknown): LocalSearchState {
  const raw = asRecord(value)
  return {
    source: typeof raw.source === 'string' && !raw.source.startsWith('pixiv:') ? raw.source : '',
    kind: asString(raw.kind, ['', 'image', 'video'] as const, ''),
    fuzzy: raw.fuzzy === true,
    sort: asString(raw.sort, ['relevance', 'newest', 'oldest', 'title', 'random'] as const, 'relevance'),
    order: asString(raw.order, ['collected', 'published'] as const, 'published'),
    seed: typeof raw.seed === 'string' ? raw.seed : '',
  }
}

function normalizeCloudSearch(value: unknown): CloudSearchState {
  const raw = asRecord(value)
  return {
    sort: asString(raw.sort, ['popular_preview', 'date_desc', 'date_asc'] as const, 'popular_preview'),
    target: isPixivSearchTarget(raw.target) ? raw.target : defaultPixivSearchTarget,
    entity: asCloudSearchEntity(raw.entity),
  }
}

export function readLibraryState(scope: 'works'): LibraryWorksState
export function readLibraryState(scope: 'localSearch'): LocalSearchState
export function readLibraryState(scope: 'cloudSearch'): CloudSearchState
export function readLibraryState(scope: 'cloudFavorites'): CloudFavoritesState
export function readLibraryState(scope: LibraryScope): LibraryStateMap[LibraryScope] {
  const raw = readJson(keys[scope])
  if (scope === 'works') return normalizeWorks(raw ?? defaults.works)
  if (scope === 'localSearch') return normalizeLocalSearch(raw ?? defaults.localSearch)
  if (scope === 'cloudSearch') return normalizeCloudSearch(raw ?? defaults.cloudSearch)
  return { restrict: asRecord(raw).restrict === 'private' ? 'private' : 'public' }
}

export function writeLibraryState(scope: 'works', state: LibraryWorksState): void
export function writeLibraryState(scope: 'localSearch', state: LocalSearchState): void
export function writeLibraryState(scope: 'cloudSearch', state: CloudSearchState): void
export function writeLibraryState(scope: 'cloudFavorites', state: CloudFavoritesState): void
export function writeLibraryState(scope: LibraryScope, state: LibraryStateMap[LibraryScope]): void {
  if (scope === 'works') writeJson(keys.works, normalizeWorks(state))
  else if (scope === 'localSearch') writeJson(keys.localSearch, normalizeLocalSearch(state))
  else if (scope === 'cloudSearch') writeJson(keys.cloudSearch, normalizeCloudSearch(state))
  else writeJson(keys.cloudFavorites, { restrict: asRecord(state).restrict === 'private' ? 'private' : 'public' })
}

export function migrateLegacyLibraryState(): void {
  try {
    const store = storage()
    if (!store || readJson(keys.works) !== null) return
    const raw = asRecord(readJson('libraryState'))
    if (!Object.keys(raw).length) return
    const order = raw.order === 'published' ? 'published' : 'collected'
    writeLibraryState('works', {
      view: raw.view === 'favorites' ? 'favorites' : 'library',
      source: typeof raw.source === 'string' ? raw.source : '',
      kind: asString(raw.kind, ['', 'image', 'video'] as const, ''),
      fuzzy: raw.fuzzy === true,
      sort: asString(raw.sort, ['newest', 'oldest', 'title', 'random'] as const, 'newest'),
      order,
      seed: typeof raw.seed === 'string' ? raw.seed : '',
    })
    writeLibraryState('localSearch', {
      source: typeof raw.source === 'string' ? raw.source : '',
      kind: asString(raw.kind, ['', 'image', 'video'] as const, ''),
      fuzzy: raw.fuzzy === true,
      sort: 'relevance',
      order,
      seed: typeof raw.seed === 'string' ? raw.seed : '',
    })
  } catch { /* Ignore broken legacy state. */ }
}

export function readRecommendationSource(): SearchSource {
  try { return storage()?.getItem('library.recommendationSource.v1') === 'cloud' ? 'cloud' : 'local' }
  catch { return 'local' }
}

export function writeRecommendationSource(source: SearchSource): void {
  try { storage()?.setItem('library.recommendationSource.v1', source) } catch { /* Best-effort UI memory. */ }
}
