import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import type { PixivBookmarkRestrict, PixivBookmarkUpdateResult, PixivSearchResponse, PixivSearchSuggestionsResponse, PixivStatus, PixivUserProfile, PixivUserSearchResponse, Work, WorkDetail } from '../../shared/types.js'
import { allWorks, favoriteIds, toWork } from '../database.js'
import { clearPixivApiCache, allPixivMirrorStates, savePixivWorkRecords, setPixivApiCache, getPixivApiCache, updatePixivBookmark } from './store.js'
import { assertPixivSession, getPixivSessionVersion, clearPixivAccount, getPixivRuntime, getPixivSettings, requirePixivReady, savePixivSettings, PixivApiError } from './auth.js'
import { pixivFetch, pixivForm } from './client.js'
import { cleanCacheLimitDays, clearPixivCache, enforcePixivCacheLimit, getOrCachePixivResource, pixivCacheStatus, pixivCacheKey, type CachedResource } from './cache.js'
import { prepareUgoira } from './ugoira.js'
import { asPixivCloudOrigin, buildUnifiedCatalog, clearUnifiedCatalogCache, cloudAssets, localRelatedWorks, normalizePixivIllust, pixivBookmarkTags, pixivCloudSource, pixivSourceId, pixivSourceName } from './catalog.js'
import type { PixivCloudOrigin } from './catalog.js'
import { sendMedia } from '../media.js'
import { resumePixivMirrors, startPixivMirror, stopPixivMirrors } from './mirror.js'
import type { PixivRawIllust, PixivUgoiraMeta } from './types.js'
import { fetchIllustRecord, pixivIllustPage, isPixivPlaceholder } from './service.js'
import type { PixivIllustPage } from './service.js'
import { fetchUserProfile, getUserSummary, getCachedUserProfile, publicUserProfile, publicUserSummary, normalizeUserSearch, normalizeUserWork, saveUserSummaries, validateUserSearchPage, USER_WORKS_CACHE_MS } from './user.js'
import type { PixivUserSearchPage } from './types.js'
import { pixivIllustId, pixivPageUrl, pixivUserId } from './protocol.js'
import { defaultPixivSearchTarget, isPixivSearchTarget } from '../../shared/pixiv-search.js'

const SEARCH_CACHE_MS = 5 * 60_000
const RELATED_CACHE_MS = 30 * 60_000

interface IllustResponse { illusts?: PixivRawIllust[]; next_url?: string | null }
interface RelatedResponse { illusts?: PixivRawIllust[]; next_url?: string | null }

function asRestrict(value: string): PixivBookmarkRestrict {
  return value === 'private' ? 'private' : 'public'
}

function encodeCursor(url: string | null | undefined): string | null {
  return url && url.trim() ? Buffer.from(url, 'utf8').toString('base64url') : null
}

function decodeCursor(cursor: string | undefined, fallback: string): string {
  if (!cursor) return fallback
  try {
    const url = Buffer.from(cursor, 'base64url').toString('utf8')
    return pixivPageUrl(url, fallback)
  } catch {
    throw new PixivApiError('分页游标无效', 400, 'invalid_cursor')
  }
}

/**
 * 搜索与推荐都是「不在收藏夹里」的云作品，只按入口贴标签：搜索是「Pixiv 云搜索」，
 * 推荐是「Pixiv 云推荐」。归一化出来的记录本身用中性的「Pixiv 云作品」，避免没有
 * 收藏夹 restrict 的作品被误标成「Pixiv 公开收藏」。
 */
function normalizeCloudWorks(raw: PixivRawIllust[], origin: PixivCloudOrigin): Work[] {
  const records = raw.map(illust => normalizePixivIllust(illust))
  const uid = getPixivRuntime().account?.id
  if (uid) savePixivWorkRecords(uid, records)
  const source = pixivCloudSource(origin)
  return records.map(record => ({
    ...record.work,
    sourceId: source.id,
    sourceName: source.name,
    memberships: undefined,
  }))
}

async function bookmarkState(illustId: string): Promise<{ bookmarked: boolean; restrict: PixivBookmarkRestrict } | null> {
  try {
    const detail = await pixivFetch<{ bookmark_detail?: { is_bookmarked?: boolean; restrict?: string } }>(
      `/v2/illust/bookmark/detail?illust_id=${encodeURIComponent(illustId)}`,
    )
    if (typeof detail.bookmark_detail?.is_bookmarked !== 'boolean') return null
    return { bookmarked: detail.bookmark_detail.is_bookmarked, restrict: asRestrict(detail.bookmark_detail.restrict || 'public') }
  } catch (error) {
    if (error instanceof PixivApiError && ['session_changed', 'local_mode', 'not_configured', 'unauthorized', 'invalid_refresh_token'].includes(error.code || '')) throw error
    return null
  }
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes('webm')) return 'webm'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('gif')) return 'gif'
  if (contentType.includes('avif')) return 'avif'
  return 'jpg'
}

export async function registerPixivRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onClose', stopPixivMirrors)
  app.get('/api/pixiv/settings', async () => getPixivSettings())
  app.put<{ Body: Record<string, unknown> }>('/api/pixiv/settings', async request => {
    const saved = await savePixivSettings(request.body)
    clearUnifiedCatalogCache()
    if (saved.localMode) await stopPixivMirrors()
    else resumePixivMirrors()
    enforcePixivCacheLimit(saved.cacheLimitMb * 1024 * 1024)
    return saved
  })
  app.delete('/api/pixiv/account', async () => { clearPixivAccount(); await stopPixivMirrors(); clearUnifiedCatalogCache(); return { ok: true } })

  app.get('/api/pixiv/status', async (): Promise<PixivStatus> => {
    const settings = getPixivSettings()
    const uid = settings.account?.id || ''
    return {
      settings,
      cache: pixivCacheStatus(settings.cacheLimitMb * 1024 * 1024),
      mirrors: uid ? allPixivMirrorStates(uid) : {
        public: { restrict: 'public', started: false, phase: 'idle', pages: 0, items: 0, lastSynced: null, lastFullSweep: null, error: '' },
        private: { restrict: 'private', started: false, phase: 'idle', pages: 0, items: 0, lastSynced: null, lastFullSweep: null, error: '' },
      },
    }
  })

  app.post<{ Body: { olderThanDays?: number | null; all?: boolean } }>('/api/pixiv/cache/clear', async request => {
    const all = request.body?.all === true
    const days = all ? null : cleanCacheLimitDays(request.body?.olderThanDays)
    if (!all && days == null) throw new PixivApiError('请指定要清理的天数或全部清理', 400, 'invalid_days')
    clearPixivApiCache()
    return clearPixivCache(days)
  })

  app.post<{ Params: { restrict: string }; Querystring: { force?: string; mode?: string } }>('/api/pixiv/mirror/:restrict', async request => {
    requirePixivReady()
    if (!['public', 'private'].includes(request.params.restrict)) throw new PixivApiError('收藏可见性无效', 400, 'invalid_restrict')
    const restrict = asRestrict(request.params.restrict)
    const mode = request.query.mode === 'incremental' ? 'incremental' : 'full'
    const manual = request.query.mode === 'incremental' || request.query.mode === 'full' || request.query.force === 'true'
    startPixivMirror(restrict, { mode, manual })
    return { ok: true, restrict, mode }
  })

  app.get<{ Querystring: { q?: string; sort?: string; target?: string; cursor?: string } }>('/api/pixiv/search', async (request): Promise<PixivSearchResponse> => {
    const started = performance.now()
    requirePixivReady()
    const target = request.query.target ?? defaultPixivSearchTarget
    if (!isPixivSearchTarget(target)) throw new PixivApiError('云搜索匹配规则无效', 400, 'invalid_search_target')
    const query = (request.query.q || '').trim().slice(0, 500)
    if (!query) return { items: [], nextCursor: null, elapsed: 0 }
    const sort = request.query.sort === 'date_desc' || request.query.sort === 'date_asc' ? request.query.sort : 'popular_preview'
    const params = new URLSearchParams({ word: query, sort: sort === 'popular_preview' ? 'popular_desc' : sort, search_target: target, filter: 'for_ios', include_translated_tag_results: 'true', merge_plain_keyword_results: 'true', search_ai_type: '0' })
    const path = `${sort === 'popular_preview' ? '/v1/search/popular-preview/illust' : '/v1/search/illust'}?${params}`
    const url = decodeCursor(request.query.cursor, path)
    const cacheKey = `search:${getPixivRuntime().account?.id || ''}:${url}`
    let response = getPixivApiCache<IllustResponse>(cacheKey)
    if (!response) {
      response = pixivIllustPage(await pixivFetch(url))
      setPixivApiCache(cacheKey, response, SEARCH_CACHE_MS)
    }
    return { items: normalizeCloudWorks(response.illusts || [], 'search'), nextCursor: encodeCursor(response.next_url), elapsed: Math.round(performance.now() - started) }
  })

  app.get<{ Querystring: { q?: string; cursor?: string } }>('/api/pixiv/users/search', async (request): Promise<PixivUserSearchResponse> => {
    const started = performance.now()
    requirePixivReady()
    const version = getPixivSessionVersion()
    const query = (request.query.q || '').trim().slice(0, 100)
    if (!query) return { items: [], nextCursor: null, elapsed: 0 }
    const params = new URLSearchParams({ word: query, filter: 'for_ios' })
    const path = `/v1/search/user?${params}`
    const url = decodeCursor(request.query.cursor, path)
    const uid = getPixivRuntime().account?.id || ''
    const cacheKey = `user-search:${uid}:${url}`
    let page = getPixivApiCache<PixivUserSearchPage>(cacheKey)
    if (!page) {
      page = validateUserSearchPage(await pixivFetch<PixivUserSearchPage>(url))
      assertPixivSession(version)
      setPixivApiCache(cacheKey, page, SEARCH_CACHE_MS)
    }
    // 原始缓存命中也要保证 summary 落盘，供头像路由使用。
    const items = normalizeUserSearch(page)
    assertPixivSession(version)
    saveUserSummaries(uid, items)
    assertPixivSession(version)
    return { items: items.map(item => publicUserSummary(getUserSummary(uid, item.id) || item)), nextCursor: encodeCursor(page.next_url), elapsed: Math.round(performance.now() - started) }
  })

  app.get<{ Params: { id: string } }>('/api/pixiv/users/:id', async (request): Promise<PixivUserProfile> => {
    requirePixivReady()
    const version = getPixivSessionVersion()
    const profile = await fetchUserProfile(request.params.id)
    assertPixivSession(version)
    return publicUserProfile(profile)
  })

  app.get<{ Params: { id: string }; Querystring: { type?: string; cursor?: string } }>('/api/pixiv/users/:id/works', async (request): Promise<PixivSearchResponse> => {
    const started = performance.now()
    requirePixivReady()
    const version = getPixivSessionVersion()
    const userId = pixivUserId(request.params.id)
    const type = request.query.type === 'manga' ? 'manga' : request.query.type === undefined || request.query.type === 'illust' ? 'illust' : null
    if (!type) throw new PixivApiError('画师作品类型无效', 400, 'invalid_type')
    const params = new URLSearchParams({ user_id: userId, type, filter: 'for_ios' })
    const path = `/v1/user/illusts?${params}`
    const url = decodeCursor(request.query.cursor, path)
    const uid = getPixivRuntime().account?.id || ''
    const cacheKey = `user-works:${uid}:${url}`
    let response = getPixivApiCache<PixivIllustPage>(cacheKey)
    if (!response) {
      response = pixivIllustPage(await pixivFetch<PixivIllustPage>(url))
      assertPixivSession(version)
      setPixivApiCache(cacheKey, response, USER_WORKS_CACHE_MS)
    }
    const records = (response.illusts || []).map(raw => normalizeUserWork(raw))
    assertPixivSession(version)
    if (uid) savePixivWorkRecords(uid, records)
    assertPixivSession(version)
    return {
      items: records.map(record => ({
        ...record.work,
        sourceId: `pixiv:user:${userId}`,
        sourceName: `Pixiv 画师 ${userId} 的${type === 'manga' ? '漫画' : '插画'}`,
        memberships: undefined,
      })),
      nextCursor: encodeCursor(response.next_url),
      elapsed: Math.round(performance.now() - started),
    }
  })

  /** 画师头像/背景：只读服务端已知的 pximg URL，无任意 u/url 参数，缺失直接 404。 */
  async function serveUserImage(userId: string, kind: 'avatar' | 'background', request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    requirePixivReady()
    const version = getPixivSessionVersion()
    const id = pixivUserId(userId)
    const uid = getPixivRuntime().account!.id
    const summary = getUserSummary(uid, id)
    const profile = getCachedUserProfile(uid, id)
    const url = kind === 'avatar' ? summary?.avatarUrl || profile?.avatarUrl : profile?.backgroundUrl
    assertPixivSession(version)
    if (!url) return reply.code(404).send({ message: '画师图片不存在' })
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16)
    const cacheKey = pixivCacheKey('meta', id, 0, `user:${kind}:${hash}`)
    const resource = await getOrCachePixivResource(cacheKey, url, undefined, 32 * 1024 * 1024)
    assertPixivSession(version)
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(resource.contentType.split(';')[0] || '')) throw new PixivApiError('画师图片响应无效', 502, 'invalid_resource')
    enforcePixivCacheLimit(getPixivSettings().cacheLimitMb * 1024 * 1024)
    return sendMedia(request, reply, resource.path, extensionForContentType(resource.contentType))
  }

  app.get<{ Params: { id: string } }>('/api/pixiv/users/:id/avatar', async (request, reply) => {
    return serveUserImage(request.params.id, 'avatar', request, reply)
  })

  app.get<{ Params: { id: string } }>('/api/pixiv/users/:id/background', async (request, reply) => {
    return serveUserImage(request.params.id, 'background', request, reply)
  })

  app.get<{ Querystring: { q?: string } }>('/api/pixiv/suggestions', async (request): Promise<PixivSearchSuggestionsResponse> => {
    requirePixivReady()
    const word = (request.query.q || '').trim().slice(0, 100)
    if (!word) return { items: [] }
    const version = getPixivSessionVersion()
    const uid = getPixivRuntime().account!.id
    const key = `suggestions:${uid}:${word}`
    const cached = getPixivApiCache<PixivSearchSuggestionsResponse>(key)
    if (cached) return cached
    const response = await pixivFetch<{ tags?: Array<{ name?: string; translated_name?: string }> }>(`/v2/search/autocomplete?${new URLSearchParams({ word })}`)
    assertPixivSession(version)
    if (!Array.isArray(response.tags)) throw new PixivApiError('Pixiv 搜索建议响应不完整', 502, 'invalid_response')
    const seen = new Set<string>()
    const items = response.tags.flatMap(tag => {
      const name = typeof tag?.name === 'string' ? tag.name.trim() : ''
      if (!name || seen.has(name)) return []
      seen.add(name)
      return [{ name, translatedName: typeof tag.translated_name === 'string' ? tag.translated_name.trim() : '' }]
    }).slice(0, 30)
    const result = { items }
    setPixivApiCache(key, result, SEARCH_CACHE_MS)
    return result
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string } }>('/api/pixiv/works/:id', async (request): Promise<WorkDetail> => {
    requirePixivReady()
    const version = getPixivSessionVersion()
    const record = await fetchIllustRecord(request.params.id)
    assertPixivSession(version)
    const bookmark = await bookmarkState(request.params.id)
    assertPixivSession(version)
    const cloudBookmark = bookmark ?? record.work.cloudBookmark ?? null
    // 详情接口是唯一不经过列表的来源入口：前端不把「从搜索/推荐进来」的上下文传给
    // 服务端（route query 里的 from/list 不会带进来），所以这里按收藏状态重新标注，
    // 收藏夹里的作品保留收藏夹来源名，其余用中性的「Pixiv 云作品」；调用方若确实知道
    // 入口，可用 ?from=search|related|cloud 覆盖，但覆盖不了收藏夹来源。
    const bookmarkedRestrict = cloudBookmark?.bookmarked ? cloudBookmark.restrict : null
    const source = bookmarkedRestrict
      ? { id: pixivSourceId(bookmarkedRestrict), name: pixivSourceName(bookmarkedRestrict) }
      : pixivCloudSource(asPixivCloudOrigin(request.query.from))
    const work: Work = {
      ...record.work,
      cloudBookmark,
      sourceId: source.id,
      sourceName: source.name,
      memberships: [{ id: source.id, name: source.name, kind: 'pixiv', origin: 'pixiv' }],
    }
    return {
      ...work,
      originalUrl: `https://www.pixiv.net/artworks/${request.params.id}`,
      assets: cloudAssets(request.params.id, work, record.meta),
    }
  })

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/api/pixiv/works/:id/related', async (request): Promise<PixivSearchResponse> => {
    requirePixivReady()
    const started = performance.now()
    const fallback = `/v2/illust/related?illust_id=${pixivIllustId(request.params.id)}`
    const url = decodeCursor(request.query.cursor, fallback)
    const cacheKey = `related:${getPixivRuntime().account?.id || ''}:${url}`
    let response = getPixivApiCache<RelatedResponse>(cacheKey)
    if (!response) {
      response = pixivIllustPage(await pixivFetch(url))
      setPixivApiCache(cacheKey, response, RELATED_CACHE_MS)
    }
    return { items: normalizeCloudWorks(response.illusts || [], 'related'), nextCursor: encodeCursor(response.next_url), elapsed: Math.round(performance.now() - started) }
  })

  app.put<{ Params: { id: string }; Body: { bookmarked?: boolean } }>('/api/pixiv/works/:id/bookmark', async (request): Promise<PixivBookmarkUpdateResult> => {
    requirePixivReady()
    const runtime = getPixivRuntime()
    const version = getPixivSessionVersion()
    const uid = runtime.account?.id
    if (!uid) throw new PixivApiError('请先配置 Pixiv 账号', 409, 'not_configured')
    const illustId = pixivIllustId(request.params.id)
    if (typeof request.body?.bookmarked !== 'boolean') throw new PixivApiError('请指定是否收藏', 400, 'invalid_body')
    const bookmarked = request.body?.bookmarked === true
    if (!bookmarked) {
      await pixivForm('/v1/illust/bookmark/delete', { illust_id: illustId })
      updatePixivBookmark(uid, illustId, 'public', false)
      clearPixivApiCache()
      clearUnifiedCatalogCache()
      return { bookmarked: false, restrict: runtime.defaultBookmarkRestrict, tagsApplied: false }
    }
    const record = await fetchIllustRecord(illustId)
    assertPixivSession(version)
    const fields: Record<string, string | string[]> = {
      illust_id: illustId,
      restrict: runtime.defaultBookmarkRestrict,
    }
    let tagsApplied = false
    if (runtime.autoBookmarkTags && record.work.tags.length) {
      const tags = pixivBookmarkTags(record.meta.bookmarkTags ?? record.work.tags)
      if (tags.length) fields['tags[]'] = tags
    }
    try {
      await pixivForm('/v2/illust/bookmark/add', fields)
      tagsApplied = Array.isArray(fields['tags[]']) && fields['tags[]'].length > 0
    } catch (error) {
      // Pixiv may return only a localized generic message for invalid bookmark tags.
      // A rejected 400 can safely retry once with the minimal bookmark form.
      if (!fields['tags[]'] || !(error instanceof PixivApiError) || error.statusCode !== 400 || error.code !== 'pixiv_error') throw error
      delete fields['tags[]']
      await pixivForm('/v2/illust/bookmark/add', fields)
      tagsApplied = false
    }
    updatePixivBookmark(uid, illustId, runtime.defaultBookmarkRestrict, true, record.work)
    clearPixivApiCache()
    clearUnifiedCatalogCache()
    return {
      bookmarked: true,
      restrict: runtime.defaultBookmarkRestrict,
      tagsApplied,
      warning: runtime.autoBookmarkTags && record.work.tags.length && !tagsApplied ? '作品已收藏，但标签未附加' : undefined,
    }
  })

  app.get<{ Params: { illustId: string; page: string; variant: string } }>('/api/pixiv/assets/:illustId/:page/:variant', async (request, reply) => {
    requirePixivReady()
    const version = getPixivSessionVersion()
    if (!/^\d+$/.test(request.params.page) || !['preview', 'original'].includes(request.params.variant)) throw new PixivApiError('图片页码或类型无效', 400, 'invalid_asset')
    const page = Number(request.params.page)
    let record = await fetchIllustRecord(request.params.illustId, false)
    if (!record.meta.pages[page] || request.params.variant === 'original') record = await fetchIllustRecord(request.params.illustId)
    assertPixivSession(version)
    const meta = record.meta.pages[page]
    if (!meta) return reply.code(404).send({ message: 'Pixiv 图片不存在' })
    const url = request.params.variant === 'original' ? (meta.original || meta.preview) : meta.preview
    if (isPixivPlaceholder(url)) throw new PixivApiError('Pixiv 图片已删除或当前账号不可见', 403, 'content_unavailable')
    const cacheKey = pixivCacheKey('page', request.params.illustId, page, request.params.variant)
    const resource = await getOrCachePixivResource(cacheKey, url, undefined, 256 * 1024 * 1024)
    assertPixivSession(version)
    enforcePixivCacheLimit(getPixivSettings().cacheLimitMb * 1024 * 1024)
    return sendMedia(request, reply, resource.path, extensionForContentType(resource.contentType))
  })

  /** 读取/补齐 Ugoira 元数据并转码；二进制 GET 与 JSON 准备接口共用这一条路径。 */
  async function resolveUgoira(illustId: string, format: 'auto' | 'webp'): Promise<CachedResource> {
    requirePixivReady()
    const version = getPixivSessionVersion()
    const uid = getPixivRuntime().account!.id
    let record = await fetchIllustRecord(illustId, false)
    assertPixivSession(version)
    if (record.work.kind !== 'animation') throw new PixivApiError('该作品不是 Ugoira 动图', 400, 'invalid_asset')
    if (!record.meta.ugoira) {
      const detail = await pixivFetch<{ ugoira_metadata?: { zip_urls?: { medium?: string }; frames?: Array<{ file?: string; delay?: number }> } }>(
        `/v1/ugoira/metadata?illust_id=${encodeURIComponent(illustId)}`,
      )
      const zipUrl = String(detail.ugoira_metadata?.zip_urls?.medium || '')
      const frames = (detail.ugoira_metadata?.frames || []).flatMap(frame => frame.file ? [{ file: frame.file, delay: Math.max(10, Number(frame.delay) || 100) }] : [])
      if (!zipUrl || !frames.length) throw new PixivApiError('Ugoira 元数据不可用', 404, 'invalid_asset')
      const meta: PixivUgoiraMeta = { zipUrl, frames }
      record = { ...record, meta: { ...record.meta, ugoira: meta } }
      assertPixivSession(version)
      savePixivWorkRecords(uid, [record])
    }
    const ugoira = record.meta.ugoira
    if (!ugoira) throw new PixivApiError('Ugoira 元数据不可用', 404, 'invalid_asset')
    const resource = await prepareUgoira(illustId, ugoira.zipUrl, ugoira.frames, format)
    assertPixivSession(version)
    enforcePixivCacheLimit(getPixivSettings().cacheLimitMb * 1024 * 1024)
    return resource
  }

  app.get<{ Params: { illustId: string; variant: string }; Querystring: { format?: string } }>('/api/pixiv/ugoira/:illustId/:variant', async (request, reply) => {
    if (request.params.variant !== 'animation') throw new PixivApiError('Ugoira 资源类型无效', 400, 'invalid_asset')
    const format = request.query.format || 'auto'
    if (format !== 'auto' && format !== 'webp') throw new PixivApiError('Ugoira 格式无效', 400, 'invalid_asset')
    const resource = await resolveUgoira(request.params.illustId, format)
    return sendMedia(request, reply, resource.path, extensionForContentType(resource.contentType))
  })

  // 播放器先问"能不能放、该用 video 还是 img"。准备失败时这里能返回具体原因
  // （帧数、解压/像素上限、超时），而不是让 <video>/<img> 只报一个笼统的加载失败。
  app.post<{ Params: { illustId: string }; Body: { format?: string } }>('/api/pixiv/ugoira/:illustId/prepare', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: { format: { type: 'string', enum: ['auto', 'webp'] } },
      },
    },
  }, async request => {
    const format = request.body?.format === 'webp' ? 'webp' : 'auto'
    const resource = await resolveUgoira(request.params.illustId, format)
    return {
      url: `/api/pixiv/ugoira/${encodeURIComponent(request.params.illustId)}/animation${format === 'webp' ? '?format=webp' : ''}`,
      contentType: resource.contentType,
    }
  })

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>('/api/works/:id/related', async request => {
    const page = Math.max(1, Math.floor(Number(request.query.page)) || 1)
    const favorites = favoriteIds()
    const localWorks = buildUnifiedCatalog(null, allWorks().map(work => toWork(work, favorites)))
    let seed: string | Work = request.params.id
    if (seed.startsWith('pixiv:')) {
      requirePixivReady()
      const version = getPixivSessionVersion()
      seed = (await fetchIllustRecord(seed.slice(6), false)).work
      assertPixivSession(version)
    }
    const related = localRelatedWorks(seed, localWorks.length, 0, localWorks)
    const total = related.length
    return {
      items: related.slice((page - 1) * 24, page * 24),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / 24)),
      elapsed: 0,
    }
  })

  resumePixivMirrors()
}
