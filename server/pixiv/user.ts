import { createHash } from 'node:crypto'
import type { PixivUserProfile, PixivUserSummary } from '../../shared/types.js'
import { assertPixivSession, getPixivRuntime, getPixivSessionVersion, requirePixivReady } from './auth.js'
import { normalizePixivIllust } from './catalog.js'
import { pixivFetch } from './client.js'
import { PixivApiError } from './errors.js'
import { pixivUserId } from './protocol.js'
import { getPixivApiCache, setPixivApiCache } from './store.js'
import type { PixivNormalizedUser, PixivRawIllust, PixivRawUser, PixivRawUserDetail, PixivRawUserPreview, PixivStoredWork, PixivUserSearchPage } from './types.js'

export const USER_SUMMARY_TTL_MS = 7 * 24 * 60 * 60_000
export const USER_WORKS_CACHE_MS = 5 * 60_000
export const PROFILE_CACHE_MS = 30 * 60_000

const SUMMARY_PREFIX = 'user-summary:'
const PROFILE_PREFIX = 'user-profile:'
const profiles = new Map<string, Promise<PixivUserProfile>>()

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function strictUserId(value: unknown): string {
  const raw = String(value ?? '')
  return /^[1-9]\d*$/.test(raw) ? raw : ''
}
function numericCount(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}
function httpUrl(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch { return undefined }
}
function twitterUrl(account: unknown, direct: unknown): string | undefined {
  const url = httpUrl(direct)
  if (url) return url
  const name = text(account).replace(/^@/, '')
  if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return undefined
  return `https://twitter.com/${name}`
}

function summaryKey(accountId: string, userId: string): string {
  return `${SUMMARY_PREFIX}${accountId}:${userId}`
}
function profileKey(accountId: string, userId: string): string {
  return `${PROFILE_PREFIX}${accountId}:${userId}`
}

function avatarOf(user?: PixivRawUser): string | undefined {
  return text(user?.profile_image_urls?.medium) || undefined
}

function normalizeSummary(user?: PixivRawUser): PixivUserSummary | null {
  const id = strictUserId(user?.id)
  const name = text(user?.name)
  if (!id || !name) return null
  const summary: PixivUserSummary = { id, name }
  const account = text(user?.account)
  if (account) summary.account = account
  const comment = text(user?.comment)
  if (comment) summary.comment = comment
  const avatar = avatarOf(user)
  if (avatar) summary.avatarUrl = avatar
  if (user?.is_followed !== undefined) summary.isFollowed = user.is_followed === true
  return summary
}

export function normalizeUserDetail(raw: PixivRawUserDetail, requestedId: string): PixivNormalizedUser {
  const id = strictUserId(raw.user?.id)
  if (!id || id !== requestedId) throw new PixivApiError('Pixiv 画师档案响应不完整', 502, 'invalid_response')
  const summary = normalizeSummary(raw.user)
  if (!summary) throw new PixivApiError('Pixiv 画师档案响应不完整', 502, 'invalid_response')
  const profile: PixivUserProfile = { ...summary }
  const detail = raw.profile && typeof raw.profile === 'object' ? raw.profile : {}
  const webpage = httpUrl(detail.webpage)
  if (webpage) profile.webpage = webpage
  const twitter = twitterUrl(detail.twitter_account, detail.twitter_url)
  if (twitter) profile.twitterUrl = twitter
  const background = httpUrl(detail.background_image_url)
  if (background) profile.backgroundUrl = background
  const totalIllusts = numericCount(detail.total_illusts)
  if (totalIllusts !== undefined) profile.totalIllusts = totalIllusts
  const totalManga = numericCount(detail.total_manga)
  if (totalManga !== undefined) profile.totalManga = totalManga
  const totalNovels = numericCount(detail.total_novels)
  if (totalNovels !== undefined) profile.totalNovels = totalNovels
  const totalFollows = numericCount(detail.total_follow_users)
  if (totalFollows !== undefined) profile.totalFollows = totalFollows
  const location = text(detail.region || detail.country_code)
  if (location) profile.location = location
  const job = text(detail.job)
  if (job) profile.job = job
  const gender = text(detail.gender)
  if (gender) profile.gender = gender
  if (raw.workspace && typeof raw.workspace === 'object' && !Array.isArray(raw.workspace)) {
    const entries = Object.entries(raw.workspace)
      .flatMap(([label, value]) => {
        const cleanLabel = text(label)
        const cleanValue = text(value)
        return cleanLabel && cleanValue ? [{ label: cleanLabel, value: cleanValue }] : []
      })
      .slice(0, 20)
    if (entries.length) profile.workspace = entries
  }
  return { profile, summary }
}

/** 搜索归一化：只取 user 部分；附带 illusts 样例一律忽略，不写作品库。 */
export function normalizeUserSearch(raw: PixivUserSearchPage): PixivUserSummary[] {
  if (!raw || !Array.isArray(raw.user_previews)) throw new PixivApiError('Pixiv 作者搜索响应不完整', 502, 'invalid_response')
  const seen = new Set<string>()
  const items: PixivUserSummary[] = []
  for (const entry of raw.user_previews as PixivRawUserPreview[]) {
    if (!entry || typeof entry !== 'object') continue
    const summary = normalizeSummary(entry.user)
    if (!summary || seen.has(summary.id)) continue
    seen.add(summary.id)
    items.push(summary)
  }
  return items
}

export function validateUserSearchPage(payload: PixivUserSearchPage): PixivUserSearchPage {
  if (!payload || !Array.isArray(payload.user_previews) || (payload.next_url != null && typeof payload.next_url !== 'string')) {
    throw new PixivApiError('Pixiv 作者搜索响应不完整', 502, 'invalid_response')
  }
  return payload
}

export function saveUserSummaries(accountId: string, summaries: PixivUserSummary[]): void {
  for (const summary of summaries) {
    if (!summary || !/^[1-9]\d*$/.test(summary.id)) continue
    const existing = getPixivApiCache<PixivUserSummary>(summaryKey(accountId, summary.id))
    const merged: PixivUserSummary = { ...summary }
    // 缺字段沿用旧缓存：头像缺失不覆盖已有值。
    if (!merged.avatarUrl && existing?.avatarUrl) merged.avatarUrl = existing.avatarUrl
    if (!merged.account && existing?.account) merged.account = existing.account
    if (!merged.comment && existing?.comment) merged.comment = existing.comment
    if (merged.isFollowed === undefined && existing?.isFollowed !== undefined) merged.isFollowed = existing.isFollowed
    setPixivApiCache(summaryKey(accountId, summary.id), merged, USER_SUMMARY_TTL_MS)
  }
}

export function getUserSummary(accountId: string, userId: string): PixivUserSummary | null {
  return getPixivApiCache<PixivUserSummary>(summaryKey(accountId, userId))
}

export function getCachedUserProfile(accountId: string, userId: string): PixivUserProfile | null {
  return getPixivApiCache<PixivUserProfile>(profileKey(accountId, userId))
}

function imageProxy(userId: string, kind: 'avatar' | 'background', rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.pximg.net') || url.port || url.username || url.password) return undefined
    const hash = createHash('sha256').update(rawUrl).digest('hex').slice(0, 16)
    const account = encodeURIComponent(getPixivRuntime().account?.id || '')
    return `/api/pixiv/users/${userId}/${kind}?v=${hash}&a=${account}`
  } catch { return undefined }
}

/** Raw remote addresses stay in account-scoped server caches; clients see only versioned proxies. */
export function publicUserSummary(summary: PixivUserSummary): PixivUserSummary {
  return { ...summary, avatarUrl: imageProxy(summary.id, 'avatar', summary.avatarUrl) }
}
export function publicUserProfile(profile: PixivUserProfile): PixivUserProfile {
  return { ...publicUserSummary(profile), ...profile, avatarUrl: imageProxy(profile.id, 'avatar', profile.avatarUrl), backgroundUrl: imageProxy(profile.id, 'background', profile.backgroundUrl) }
}

async function requestUserDetail(userId: string): Promise<PixivNormalizedUser> {
  const id = pixivUserId(userId)
  requirePixivReady()
  const uid = getPixivRuntime().account!.id
  const version = getPixivSessionVersion()
  const response = await pixivFetch<PixivRawUserDetail>(`/v2/user/detail?user_id=${id}&filter=for_ios`)
  assertPixivSession(version)
  const normalized = normalizeUserDetail(response, id)
  assertPixivSession(version)
  setPixivApiCache(profileKey(uid, id), normalized.profile, PROFILE_CACHE_MS)
  saveUserSummaries(uid, [normalized.summary])
  return normalized
}

/** 画师档案：profile 缓存 30 分钟，in-flight 按版本+账号+ID 合并。 */
export function fetchUserProfile(userId: string): Promise<PixivUserProfile> {
  const id = pixivUserId(userId)
  requirePixivReady()
  const uid = getPixivRuntime().account!.id
  const version = getPixivSessionVersion()
  const cached = getPixivApiCache<PixivUserProfile>(profileKey(uid, id))
  if (cached?.id === id && cached.name) return Promise.resolve(cached)
  const key = `${version}:${uid}:${id}`
  const existing = profiles.get(key)
  if (existing) return existing
  const task = (async () => {
    const normalized = await requestUserDetail(id)
    assertPixivSession(version)
    return normalized.profile
  })().finally(() => profiles.delete(key))
  profiles.set(key, task)
  return task
}

/** 列表项带 user 时的作品归一化入口（与 normalizePixivIllust 同源）。 */
export function normalizeUserWork(raw: PixivRawIllust, restrict?: Parameters<typeof normalizePixivIllust>[1]): PixivStoredWork {
  return normalizePixivIllust(raw, restrict)
}
