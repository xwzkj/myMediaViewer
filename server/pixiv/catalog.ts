import path from 'node:path'
import { UGOIRA_ENCODING_VERSION } from '../../shared/ugoira.js'
import { localPixivId } from './identity.js'
import type { Asset, MediaKind, PixivBookmarkRestrict, Work, WorkMembership } from '../../shared/types.js'
import { allWorks } from '../database.js'
import { getPixivBookmarkRecords, getPixivWorkRecords, getPixivBookmarkStates } from './store.js'
import type { PixivPageMeta, PixivRawIllust, PixivStoredWork, PixivUgoiraMeta, PixivWorkMeta } from './types.js'

export const PIXIV_PUBLIC_SOURCE = 'pixiv:public'
export const PIXIV_PRIVATE_SOURCE = 'pixiv:private'

/**
 * 不在收藏夹里的云作品（详情直达 / 搜索 / 推荐）的来源。
 *
 * 过去没有收藏夹 restrict 的作品一律套用 pixivSourceName()，于是每个从搜索或推荐
 * 点进来的作品都被标成「Pixiv 公开收藏」。这里给云作品一个中性来源，只在确实读过
 * 收藏夹（restrict 已知）时才使用收藏夹来源名。
 */
export type PixivCloudOrigin = 'cloud' | 'search' | 'related'
const CLOUD_SOURCES: Record<PixivCloudOrigin, { id: string; name: string }> = {
  cloud: { id: 'pixiv:cloud', name: 'Pixiv 云作品' },
  search: { id: 'pixiv:search', name: 'Pixiv 云搜索' },
  related: { id: 'pixiv:related', name: 'Pixiv 云推荐' },
}

export function pixivCloudSource(origin: PixivCloudOrigin): { id: string; name: string } {
  return CLOUD_SOURCES[origin]
}

export function asPixivCloudOrigin(value: unknown): PixivCloudOrigin {
  return value === 'search' || value === 'related' || value === 'cloud' ? value : 'cloud'
}

/**
 * Pixiv 对已删除 / 当前账号不可见的作品只返回 placeholder、limit 或 privacy 图 URL。
 * 该判定只在这里实现一次，归一化、缓存合并与列表排序统一复用它。
 */
export function isPixivPlaceholder(url: string): boolean {
  return !url || /pximg\.net\/common\/|limit[_-]?illust|privacy/i.test(url)
}

/**
 * 页元数据里没有任何可用媒体：每一页的 preview 和 original 都是 placeholder，
 * 或干脆没有页（pages 为空数组）。undefined 表示没有页元数据，不做判定，避免误伤。
 */
export function isUnavailablePages(pages?: PixivPageMeta[]): boolean {
  if (!Array.isArray(pages)) return false
  return !pages.some(page => !isPixivPlaceholder(page.preview) || !isPixivPlaceholder(page.original))
}

type CatalogCacheEntry = { key: string; at: number; works: Work[] }
const catalogCache = new Map<string, CatalogCacheEntry>()
const CATALOG_CACHE_MS = 1500

export function pixivSourceId(restrict: PixivBookmarkRestrict): string {
  return restrict === 'private' ? PIXIV_PRIVATE_SOURCE : PIXIV_PUBLIC_SOURCE
}

export function isPixivVirtualSource(source: string): source is typeof PIXIV_PUBLIC_SOURCE | typeof PIXIV_PRIVATE_SOURCE {
  return source === PIXIV_PUBLIC_SOURCE || source === PIXIV_PRIVATE_SOURCE
}

export function pixivSourceName(restrict: PixivBookmarkRestrict): string {
  return restrict === 'private' ? 'Pixiv 私密收藏' : 'Pixiv 公开收藏'
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
// Pixiv allows at most 10 bookmark tags per work (help article 235585488).
export function pixivBookmarkTags(tags: string[]): string[] {
  return [...new Set(tags.map(text).filter(Boolean))].slice(0, 10)
}
function number(value: unknown, fallback = 0): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }
function numericId(value: unknown): string { return String(value ?? '').replace(/\D/g, '') }

function extensionFromUrl(url: string, fallback = 'jpg'): string {
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase()
    return ext || fallback
  } catch { return fallback }
}

function imagePreview(urls: PixivRawIllust['image_urls']): string {
  return text(urls?.large || urls?.medium || urls?.square_medium)
}

function imageOriginal(raw: PixivRawIllust, preview: string): string {
  return text(raw.meta_single_page?.original_image_url || raw.image_urls?.original || preview)
}

function pageMeta(raw: PixivRawIllust): PixivPageMeta[] {
  const count = Math.max(1, number(raw.page_count, 1))
  if (count <= 1) {
    const preview = imagePreview(raw.image_urls)
    return [{ page: 0, preview, original: imageOriginal(raw, preview), width: number(raw.width), height: number(raw.height) }]
  }
  const sourcePages = raw.meta_pages || []
  // bookmark 接口有时只返回 page_count 和首图，不带 meta_pages。不能把它
  // 归一化成空资源，否则前端会显示 Pixiv 限制图，点击后再得到 404。
  if (!sourcePages.length) {
    const preview = imagePreview(raw.image_urls)
    return [{ page: 0, preview, original: imageOriginal(raw, preview), width: number(raw.width), height: number(raw.height) }]
  }
  return sourcePages.slice(0, count).map((page, index) => {
    const preview = imagePreview(page.image_urls)
    return {
      page: index,
      preview,
      original: text(page.image_urls?.original || imagePreview(page.image_urls)),
      width: number(raw.width),
      height: number(raw.height),
    }
  })
}

export function normalizePixivIllust(
  raw: PixivRawIllust,
  restrict?: PixivBookmarkRestrict,
  ugoira?: PixivUgoiraMeta,
): PixivStoredWork {
  const illustId = numericId(raw.id)
  if (!illustId) throw new Error('Pixiv 作品缺少 ID')
  const userId = String(raw.user?.id ?? '')
  const pixivUserId = /^[1-9]\d*$/.test(userId) ? userId : undefined
  const kind: MediaKind = raw.type === 'ugoira' ? 'animation' : 'image'
  const animationPreview = imagePreview(raw.image_urls)
  const pages = kind === 'animation'
    ? [{ page: 0, preview: animationPreview, original: animationPreview, width: number(raw.width), height: number(raw.height) }]
    : pageMeta(raw)
  const meta: PixivWorkMeta = {
    pages, ugoira, kind,
    bookmarkTags: pixivBookmarkTags([
      ...(raw.tags || []).map(tag => text(tag.name)),
      ...(raw.tags || []).map(tag => text(tag.translated_name)),
    ]),
  }
  const tags = [...new Set((raw.tags || []).flatMap(tag => [
    text(tag.name),
    text(tag.translated_name),
  ]).filter(Boolean))]
  // 只有真正读过收藏夹（restrict 已知）的作品才用收藏夹来源名；其余云作品用中性来源，
  // 否则从搜索/推荐/详情点进来的作品会被错误地标成「Pixiv 公开收藏」。
  const source = restrict ? { id: pixivSourceId(restrict), name: pixivSourceName(restrict) } : pixivCloudSource('cloud')
  // 收藏接口对已删除/不可见的作品可能没有 create_date。不要用「现在」兜底：那会让
  // 坏作品看起来永远是最新的。退到 0（1970-01-01）并标记 Work.unavailable，排序既有
  // 分组兜底，日期本身也不再撒谎。
  const unavailable = isUnavailablePages(pages)
  const updated = Date.parse(raw.create_date || '') || 0
  const work: Work = {
    id: `pixiv:${illustId}`,
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: 'pixiv',
    externalId: illustId,
    title: text(raw.title) || `Pixiv #${illustId}`,
    author: text(raw.user?.name),
    description: text(raw.caption),
    tags,
    date: raw.create_date || new Date(updated).toISOString(),
    collected: 0,
    updated,
    count: kind === 'animation' ? 1 : Math.max(1, number(raw.page_count, 1)),
    kind,
    favorite: false,
    cover: `/api/pixiv/assets/${illustId}/0/preview?v=${updated}`,
    origin: 'pixiv',
    hasLocal: false,
    pixivId: illustId,
    ...(pixivUserId ? { pixivUserId } : {}),
    ...(unavailable ? { unavailable: true } : {}),
    memberships: [{ id: source.id, name: source.name, kind: 'pixiv', origin: 'pixiv' }],
    cloudBookmark: restrict
      ? { bookmarked: true, restrict }
      : raw.is_bookmarked === undefined ? null : { bookmarked: raw.is_bookmarked === true, restrict: 'public' },
  }
  return { work, meta }
}

export function cloudAssets(illustId: string, work: Work, meta: PixivWorkMeta): Asset[] {
  if (work.kind === 'animation') {
    return [{
      id: `pixiv:${illustId}:ugoira`,
      workId: work.id,
      filename: `${illustId}_ugoira.webm`,
      page: 0,
      kind: 'animation',
      extension: 'webm',
      size: 0,
      modified: work.updated,
      url: `/api/pixiv/ugoira/${illustId}/animation?v=${UGOIRA_ENCODING_VERSION}`,
      thumbnail: `/api/pixiv/assets/${illustId}/0/preview?v=${work.updated}`,
      origin: 'pixiv',
      illustId,
    }]
  }
  return meta.pages.map(page => ({
    id: `pixiv:${illustId}:${page.page}`,
    workId: work.id,
    filename: `${illustId}_p${page.page}.${extensionFromUrl(page.original || page.preview)}`,
    page: page.page,
    kind: 'image',
    extension: extensionFromUrl(page.original || page.preview),
    size: 0,
    modified: work.updated,
    url: `/api/pixiv/assets/${illustId}/${page.page}/preview`,
    thumbnail: `/api/pixiv/assets/${illustId}/${page.page}/preview`,
    origin: 'pixiv',
    illustId,
  }))
}

function localMembership(work: Work): WorkMembership {
  return { id: work.sourceId, name: work.sourceName, kind: work.sourceKind, origin: 'local' }
}

/**
 * 读取镜像记录时回填媒体可用性。旧库里的 Work 还没有 unavailable 字段，
 * 但页元数据已经能判定「已删除/当前账号不可见」的收藏，无需等下一次收藏夹同步。
 */
function withAvailability(work: Work, meta?: PixivWorkMeta): Work {
  return isUnavailablePages(meta?.pages) ? { ...work, unavailable: true } : work
}

function mergeLocalAndCloud(local: Work, cloud: Work, records: Array<{ restrict: PixivBookmarkRestrict; work: Work }>): Work {
  const memberships = [localMembership(local)]
  const tags = new Set(local.tags.filter(Boolean))
  for (const item of records) {
    memberships.push({ id: pixivSourceId(item.restrict), name: pixivSourceName(item.restrict), kind: 'pixiv', origin: 'pixiv' })
    for (const tag of item.work.tags) if (tag.trim()) tags.add(tag.trim())
  }
  const privateRestrict = records.some(item => item.restrict === 'private')
  return {
    ...local,
    title: local.title || cloud.title,
    author: local.author || cloud.author,
    description: local.description || cloud.description,
    tags: [...tags],
    origin: 'local',
    hasLocal: true,
    pixivId: localPixivId(local) || cloud.pixivId,
    memberships,
    cloudBookmark: { bookmarked: true, restrict: privateRestrict ? 'private' : 'public' },
  }
}

export function buildUnifiedCatalog(accountId: string | null, localWorks?: Work[]): Work[] {
  const local = (localWorks || allWorks().map((work): Work => ({ ...work, favorite: false, cover: '' }))).map((work): Work => ({
    ...work,
    origin: 'local',
    hasLocal: true,
    pixivId: localPixivId(work) || undefined,
    memberships: [localMembership(work)],
  }))
  if (!accountId) return local

  // 来源切换会在短时间内连续请求 status、works 和 tags。镜像数据本身只在
  // 后台分页同步时变化，短 TTL 可以避免每个请求都反序列化整套 Pixiv 目录。
  const cacheKey = `${accountId}|${local.map(work => `${work.id}:${work.updated}:${work.count}:${work.favorite ? 1 : 0}:${work.pixivId || ''}`).join(';')}`
  const cached = catalogCache.get(accountId)
  if (cached && cached.key === cacheKey && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.works

  const cloudRecords = getPixivWorkRecords(accountId)
  const cloudById = new Map(cloudRecords.map(record => [record.work.pixivId || record.work.externalId, record]))
  const bookmarkRecords = new Map<string, Array<{ restrict: PixivBookmarkRestrict; work: Work; meta?: PixivWorkMeta }>>()
  for (const restrict of ['public', 'private'] as const) {
    for (const record of getPixivBookmarkRecords(accountId, restrict)) {
      const id = record.work.pixivId || record.work.externalId
      const list = bookmarkRecords.get(id) || []
      list.push({ restrict, work: record.work, meta: record.meta })
      bookmarkRecords.set(id, list)
    }
  }

  const mergedLocalIds = new Set<string>()
  const output: Work[] = []
  for (const work of local) {
    const id = work.pixivId
    const records = id ? bookmarkRecords.get(id) : undefined
    if (!id || !records?.length) { output.push(work); continue }
    const cloud = cloudById.get(id)?.work || records[0].work
    output.push(mergeLocalAndCloud(work, cloud, records))
    mergedLocalIds.add(id)
  }

  for (const [id, records] of bookmarkRecords) {
    if (mergedLocalIds.has(id)) continue
    const record = cloudById.get(id) || { work: records[0].work, meta: { pages: [], kind: records[0].work.kind } }
    const memberships = records.map(item => ({
      id: pixivSourceId(item.restrict), name: pixivSourceName(item.restrict), kind: 'pixiv' as const, origin: 'pixiv' as const,
    }))
    const primary = memberships.some(item => item.id === PIXIV_PRIVATE_SOURCE) ? PIXIV_PRIVATE_SOURCE : PIXIV_PUBLIC_SOURCE
    output.push({
      ...withAvailability(record.work, record.meta),
      id: `pixiv:${id}`,
      sourceId: primary,
      sourceName: primary === PIXIV_PRIVATE_SOURCE ? pixivSourceName('private') : pixivSourceName('public'),
      memberships,
      favorite: false,
      hasLocal: false,
      origin: 'pixiv',
      pixivId: id,
      cloudBookmark: { bookmarked: true, restrict: primary === PIXIV_PRIVATE_SOURCE ? 'private' : 'public' },
    })
  }
  catalogCache.set(accountId, { key: cacheKey, at: Date.now(), works: output })
  return output
}

export function clearUnifiedCatalogCache(): void {
  catalogCache.clear()
}

/** Annotate local source lists without adding cloud-only works to the source. */
export function withLocalCloudBookmarks(accountId: string | null, works: Work[]): Work[] {
  const states = accountId ? getPixivBookmarkStates(accountId) : null
  return works.map(work => {
    const pixivId = localPixivId(work) || undefined
    const restrict = pixivId ? states?.get(pixivId) : undefined
    return { ...work, origin: 'local', hasLocal: true, pixivId,
      cloudBookmark: pixivId && states ? { bookmarked: Boolean(restrict), restrict: restrict || 'public' } : undefined }
  })
}

export function pixivBookmarkCatalog(accountId: string, restrict: PixivBookmarkRestrict): Work[] {
  return getPixivBookmarkRecords(accountId, restrict).map(record => ({
    ...withAvailability(record.work, record.meta),
    id: `pixiv:${record.work.pixivId || record.work.externalId}`,
    sourceId: pixivSourceId(restrict),
    sourceName: pixivSourceName(restrict),
    sourceKind: 'pixiv' as const,
    origin: 'pixiv' as const,
    hasLocal: false,
    favorite: false,
    collected: record.sequence,
    memberships: [{ id: pixivSourceId(restrict), name: pixivSourceName(restrict), kind: 'pixiv' as const, origin: 'pixiv' as const }],
    cloudBookmark: { bookmarked: true, restrict },
  }))
}

export function workMatchesSource(work: Work, source: string): boolean {
  if (!source) return true
  if (work.sourceId === source) return true
  return work.memberships?.some(membership => membership.id === source) || false
}

export function localRelatedWorks(seed: string | Work, limit = 24, offset = 0, localWorks?: Work[]): Work[] {
  const source = localWorks || allWorks().map((work): Work => ({ ...work, favorite: false, cover: '' }))
  const current = typeof seed === 'string'
    ? source.find(work => work.id === seed) || source.find(work => (work.pixivId || localPixivId(work)) === seed.replace(/^pixiv:/, ''))
    : seed
  if (!current) return []
  const currentPixivId = current.pixivId || localPixivId(current)
  const works = source.filter(work => work.id !== current.id && (!currentPixivId || (work.pixivId || localPixivId(work)) !== currentPixivId))
  if (!works.length) return []
  const tagFrequency = new Map<string, number>()
  for (const work of works) for (const tag of new Set(work.tags.map(tag => tag.trim()).filter(Boolean))) {
    tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1)
  }
  const currentTags = new Set(current.tags.map(tag => tag.trim()).filter(Boolean))
  const currentText = normalizeText(`${current.title} ${current.description} ${current.tags.join(' ')}`)
  const maxIdf = Math.log((works.length + 1) / 1)
  const now = Date.now()
  return works.map(work => {
    const tags = new Set(work.tags.map(tag => tag.trim()).filter(Boolean))
    let sharedWeight = 0
    for (const tag of currentTags) {
      if (!tags.has(tag)) continue
      sharedWeight += Math.log((works.length + 1) / (1 + (tagFrequency.get(tag) || 1))) / Math.max(1, maxIdf)
    }
    const tagScore = currentTags.size ? Math.min(1, sharedWeight / Math.sqrt(currentTags.size * Math.max(1, tags.size))) : 0
    const textScore = bigramSimilarity(currentText, normalizeText(`${work.title} ${work.description} ${work.tags.join(' ')}`))
    const ageDays = Math.max(0, (now - Date.parse(work.date || '') || 0) / 86_400_000)
    const recency = Math.exp(-ageDays / 730)
    const authorScore = current.author && current.author === work.author ? 1 : 0
    return { work, score: tagScore * 0.55 + textScore * 0.30 + recency * 0.10 + authorScore * 0.05 }
  }).sort((a, b) => b.score - a.score || b.work.updated - a.work.updated || a.work.id.localeCompare(b.work.id))
    .slice(offset, offset + limit).map(item => item.work)
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigrams(value: string): Set<string> {
  const out = new Set<string>()
  if (value.length < 2) { if (value) out.add(value); return out }
  for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2))
  return out
}

function bigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const left = bigrams(a), right = bigrams(b)
  let shared = 0
  for (const item of left) if (right.has(item)) shared++
  return (2 * shared) / (left.size + right.size)
}
