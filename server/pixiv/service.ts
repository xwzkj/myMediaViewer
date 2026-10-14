import { assertPixivSession, getPixivRuntime, getPixivSessionVersion, requirePixivReady } from './auth.js'
import { normalizePixivIllust } from './catalog.js'
import { pixivFetch } from './client.js'
import { PixivApiError } from './errors.js'
import { pixivIllustId } from './protocol.js'
import { getPixivBookmarkRestrict, getPixivWorkRecord, savePixivWorkRecords } from './store.js'
import type { PixivRawIllust, PixivStoredWork } from './types.js'

export interface PixivIllustPage { illusts: PixivRawIllust[]; next_url?: string | null }
const details = new Map<string, Promise<PixivStoredWork>>()
const DETAIL_TTL_MS = 30 * 60_000

export function pixivIllustPage(payload: PixivIllustPage): PixivIllustPage {
  if (!Array.isArray(payload.illusts) || payload.illusts.some(item => !item || typeof item !== 'object' || !/^[1-9]\d*$/.test(String(item.id))) || (payload.next_url != null && typeof payload.next_url !== 'string')) {
    throw new PixivApiError('Pixiv 作品列表响应不完整，请重试', 502, 'invalid_response')
  }
  return payload
}

export function isPixivPlaceholder(url: string): boolean {
  return !url || /pximg\.net\/common\/|limit[_-]?illust|privacy/i.test(url)
}

export function fetchIllustRecord(value: string, fullDetail = true): Promise<PixivStoredWork> {
  const id = pixivIllustId(value)
  requirePixivReady()
  const uid = getPixivRuntime().account!.id
  const version = getPixivSessionVersion()
  const stored = getPixivWorkRecord(uid, id)
  const complete = stored && stored.meta.pages.length === stored.work.count && stored.meta.pages.every(page => !isPixivPlaceholder(page.preview) && !isPixivPlaceholder(page.original))
  const storedUser = stored?.work.pixivUserId && /^[1-9]\d*$/.test(stored.work.pixivUserId) ? stored.work.pixivUserId : undefined
  // fullDetail 且旧记录缺画师 ID 时刷新一次回填；上游确实缺 user 则标记避免重复。
  const needsUser = fullDetail && !storedUser && Date.now() - (stored?.meta.userCheckedAt || 0) >= DETAIL_TTL_MS
  if (stored && !needsUser && ((!fullDetail && stored.meta.pages.some(page => !isPixivPlaceholder(page.preview))) || (complete && stored.meta.bookmarkTags !== undefined && Date.now() - (stored.meta.detailFetchedAt || 0) < DETAIL_TTL_MS))) return Promise.resolve(stored)
  const key = `${version}:${uid}:${id}`
  const existing = details.get(key)
  if (existing) return existing
  const task = (async () => {
    const response = await pixivFetch<{ illust?: PixivRawIllust }>(`/v1/illust/detail?illust_id=${id}`)
    assertPixivSession(version)
    if (!response.illust || String(response.illust.id) !== id) throw new PixivApiError('Pixiv 作品详情响应不完整', 502, 'invalid_response')
    const restrict = response.illust.is_bookmarked === false ? undefined : getPixivBookmarkRestrict(uid, id) || undefined
    const record = normalizePixivIllust(response.illust, restrict)
    if (response.illust.visible === false || record.meta.pages.some(page => isPixivPlaceholder(page.preview))) throw new PixivApiError('Pixiv 作品已删除或当前账号不可见', 403, 'content_unavailable')
    if (record.meta.pages.length !== record.work.count) throw new PixivApiError('Pixiv 多页作品详情不完整，请重试', 502, 'invalid_response')
    record.meta.detailFetchedAt = Date.now()
    record.meta.userCheckedAt = Date.now()
    if (stored?.meta.ugoira) record.meta.ugoira = stored.meta.ugoira
    if (!record.work.pixivUserId) {
      if (storedUser) record.work = { ...record.work, pixivUserId: storedUser }
    }
    savePixivWorkRecords(uid, [record])
    return record
  })().finally(() => details.delete(key))
  details.set(key, task)
  return task
}
