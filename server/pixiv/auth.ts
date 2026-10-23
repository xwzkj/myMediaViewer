import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PixivAccount, PixivBookmarkRestrict, PixivSettings } from '../../shared/types.js'
import { dataDir } from '../config.js'
import { markLibraryChanged } from '../library-revision.js'
import { pixivHeaders } from './protocol.js'
import { pixivJson, pixivRequest } from './transport.js'
import { PixivApiError, pixivErrorMessage } from './errors.js'
export { PixivApiError } from './errors.js'

const settingsPath = path.join(dataDir, 'pixiv.json')
const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token'
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT'
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj'
const TOKEN_REFRESH_AHEAD_MS = 5 * 60_000

interface StoredPixivConfig {
  localMode: boolean
  account: PixivAccount | null
  refreshToken: string
  accessToken: string
  accessTokenExpiresAt: number
  defaultBookmarkRestrict: PixivBookmarkRestrict
  autoBookmarkTags: boolean
  cacheLimitMb: number
  accountId: string
}

export interface PixivRuntimeConfig extends StoredPixivConfig {
  configured: boolean
}

const defaults: StoredPixivConfig = {
  localMode: true,
  account: null,
  refreshToken: '',
  accessToken: '',
  accessTokenExpiresAt: 0,
  defaultBookmarkRestrict: 'public',
  autoBookmarkTags: true,
  cacheLimitMb: 15_360,
  accountId: '',
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function asAccount(value: unknown): PixivAccount | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = String(raw.id ?? '').replace(/\D/g, '')
  if (!id) return null
  return {
    id,
    name: asText(raw.name),
    account: asText(raw.account),
    premium: raw.premium === true,
    avatarUrl: asText(raw.avatarUrl) || undefined,
  }
}

function clampCacheLimit(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return defaults.cacheLimitMb
  return Math.min(1024 * 1024, Math.max(128, Math.round(n)))
}

function normalize(input: unknown): StoredPixivConfig {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const account = asAccount(raw.account)
  const refreshToken = typeof raw.refreshToken === 'string' ? raw.refreshToken.trim() : ''
  return {
    localMode: !account || !refreshToken || raw.localMode === true,
    account,
    refreshToken,
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken.trim() : '',
    accessTokenExpiresAt: Number.isFinite(Number(raw.accessTokenExpiresAt)) ? Number(raw.accessTokenExpiresAt) : 0,
    defaultBookmarkRestrict: raw.defaultBookmarkRestrict === 'private' ? 'private' : 'public',
    autoBookmarkTags: raw.autoBookmarkTags !== false,
    cacheLimitMb: clampCacheLimit(raw.cacheLimitMb),
    accountId: account?.id || asText(raw.accountId),
  }
}

function readConfig(): StoredPixivConfig {
  if (!existsSync(settingsPath)) return { ...defaults }
  try { return normalize(JSON.parse(readFileSync(settingsPath, 'utf8'))) }
  catch { return { ...defaults } }
}

let current = readConfig()
let refreshInFlight: Promise<void> | null = null
let sessionVersion = 0
let settingsQueue: Promise<unknown> = Promise.resolve()

export function getPixivSessionVersion(): number { return sessionVersion }

export function assertPixivSession(version: number): void {
  requirePixivReady()
  if (version !== sessionVersion) throw new PixivApiError('Pixiv 账号或模式已改变，请重试', 409, 'session_changed')
}

function persist(): void {
  writeFileSync(`${settingsPath}.tmp`, JSON.stringify(current, null, 2), 'utf8')
  renameSync(`${settingsPath}.tmp`, settingsPath)
}

export function getPixivRuntime(): PixivRuntimeConfig {
  return { ...current, configured: Boolean(current.refreshToken && current.account?.id), account: current.account ? { ...current.account } : null }
}

export function getPixivSettings(): PixivSettings {
  const runtime = getPixivRuntime()
  return {
    localMode: runtime.localMode,
    configured: runtime.configured,
    account: runtime.account ? { ...runtime.account } : null,
    defaultBookmarkRestrict: runtime.defaultBookmarkRestrict,
    autoBookmarkTags: runtime.autoBookmarkTags,
    cacheLimitMb: runtime.cacheLimitMb,
  }
}

function tokenError(status: number, payload: unknown): PixivApiError {
  const message = pixivErrorMessage(payload) || `HTTP ${status}`
  if ((status === 400 || status === 401) && /invalid.*refresh|invalid_grant/i.test(message)) {
    return new PixivApiError('Pixiv refresh_token 无效或已失效，请重新填写', 401, 'invalid_refresh_token')
  }
  return new PixivApiError(status === 429 ? 'Pixiv 请求过于频繁，请稍后再试' : `Pixiv 认证失败：${message}`, status >= 500 ? 502 : status, 'token_error')
}

function accountFromToken(raw: Record<string, unknown>): PixivAccount {
  const user = raw.user && typeof raw.user === 'object' ? raw.user as Record<string, unknown> : {}
  const id = String(user.id ?? '').replace(/\D/g, '')
  const profile = user.profile_image_urls && typeof user.profile_image_urls === 'object'
    ? user.profile_image_urls as Record<string, unknown> : {}
  return {
    id,
    name: asText(user.name),
    account: asText(user.account),
    premium: user.is_premium === true,
    avatarUrl: asText(profile.px_170x170 || profile.px_50x50) || undefined,
  }
}

async function requestTokens(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; account: PixivAccount }> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    include_policy: 'true',
    get_secure_url: 'true',
  })
  const response = await pixivRequest(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...pixivHeaders(),
    },
    body,
  })
  const payload = await pixivJson(response)
  if (!response.ok) throw tokenError(response.status, payload)
  const raw = payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : payload
  const accessToken = asText(raw.access_token)
  const nextRefreshToken = asText(raw.refresh_token)
  const account = accountFromToken(raw)
  const expiresIn = Number(raw.expires_in ?? 3600)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new PixivApiError('Pixiv 返回的凭证有效期无效', 502, 'invalid_token_response')
  if (!accessToken || !nextRefreshToken || !account.id) throw new PixivApiError('Pixiv 返回的账号凭证不完整', 502, 'invalid_token_response')
  return { accessToken, refreshToken: nextRefreshToken, expiresIn, account }
}

function applyTokens(tokens: { accessToken: string; refreshToken: string; expiresIn: number; account: PixivAccount }): void {
  current = {
    ...current,
    account: tokens.account,
    accountId: tokens.account.id,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
  }
  persist()
}

async function refreshAccessToken(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    if (!current.refreshToken) throw new PixivApiError('请先配置 Pixiv refresh_token', 409, 'not_configured')
    const version = sessionVersion
    const tokens = await requestTokens(current.refreshToken)
    assertPixivSession(version)
    if (tokens.account.id !== current.account?.id) throw new PixivApiError('Pixiv 刷新返回了不同账号', 409, 'session_changed')
    applyTokens(tokens)
  })().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

export async function forceRefreshPixivAccessToken(rejectedToken?: string): Promise<string> {
  requirePixivReady()
  if (rejectedToken && current.accessToken && rejectedToken !== current.accessToken) return current.accessToken
  await refreshAccessToken()
  return current.accessToken
}

export async function getPixivAccessToken(): Promise<string> {
  requirePixivReady()
  if (!current.accessToken || current.accessTokenExpiresAt - Date.now() <= TOKEN_REFRESH_AHEAD_MS) await refreshAccessToken()
  return current.accessToken
}

async function saveSettings(input: unknown): Promise<PixivSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PixivApiError('设置格式不正确', 400)
  const raw = input as Record<string, unknown>
  const version = sessionVersion
  const tokens = typeof raw.refreshToken === 'string' && raw.refreshToken.trim() ? await requestTokens(raw.refreshToken.trim()) : undefined
  if (version !== sessionVersion) throw new PixivApiError('Pixiv 账号已改变，请重试', 409, 'session_changed')
  const next = { ...current }
  const previousAccountId = current.accountId
  if ('localMode' in raw) next.localMode = raw.localMode === true
  if ('defaultBookmarkRestrict' in raw) next.defaultBookmarkRestrict = raw.defaultBookmarkRestrict === 'private' ? 'private' : 'public'
  if ('autoBookmarkTags' in raw) next.autoBookmarkTags = raw.autoBookmarkTags !== false
  if ('cacheLimitMb' in raw) next.cacheLimitMb = clampCacheLimit(raw.cacheLimitMb)
  if (tokens) {
    next.localMode = false
    next.account = tokens.account
    next.accountId = tokens.account.id
    next.refreshToken = tokens.refreshToken
    next.accessToken = tokens.accessToken
    next.accessTokenExpiresAt = Date.now() + tokens.expiresIn * 1000
  }
  if (!next.account?.id || !next.refreshToken) next.localMode = true
  // 本地模式和账号决定云端作品是否出现在目录里；默认收藏夹、缓存上限等设置不影响作品数据，
  // 不必让搜索索引失效。
  const visibleChanged = next.localMode !== current.localMode || next.accountId !== current.accountId
  if (tokens || next.localMode !== current.localMode) sessionVersion++
  current = next
  persist()
  if (next.account && next.accountId && next.accountId !== previousAccountId) {
    const { deletePixivDataForOtherAccounts, clearPixivApiCache } = await import('./store.js')
    deletePixivDataForOtherAccounts(next.accountId)
    clearPixivApiCache()
  }
  if (visibleChanged) markLibraryChanged()
  return getPixivSettings()
}

export function savePixivSettings(input: unknown): Promise<PixivSettings> {
  const task = settingsQueue.then(() => saveSettings(input))
  settingsQueue = task.catch(() => undefined)
  return task
}

export function clearPixivAccount(): void {
  // 本来就没有账号时，登出不改变目录内容。
  const hadAccount = Boolean(current.account?.id || current.refreshToken)
  sessionVersion++
  current = { ...current, localMode: true, account: null, accountId: '', refreshToken: '', accessToken: '', accessTokenExpiresAt: 0 }
  persist()
  if (hadAccount) markLibraryChanged()
}

export function requirePixivReady(): void {
  if (current.localMode) throw new PixivApiError('已开启本地模式，Pixiv 云功能不可用', 403, 'local_mode')
  if (!current.refreshToken || !current.account?.id) throw new PixivApiError('请先配置 Pixiv 账号', 409, 'not_configured')
}

export async function refreshPixivTokenForTest(refreshToken: string) {
  const value = await requestTokens(refreshToken.trim())
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresIn: value.expiresIn, account: value.account }
}
