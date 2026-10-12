import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PixivCacheStatus } from '../../shared/types.js'
import { cacheDir } from '../config.js'
import { db } from '../database.js'
import { getPixivRuntime } from './auth.js'
import { PixivApiError } from './errors.js'
import { PIXIV_USER_AGENT } from './protocol.js'
import { pixivRequest } from './transport.js'

const resourceRoot = path.join(cacheDir, 'pixiv')
mkdirSync(resourceRoot, { recursive: true })

db.exec(`
  CREATE TABLE IF NOT EXISTS pixiv_resource_cache (
    key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    created INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    etag TEXT
  );
  CREATE INDEX IF NOT EXISTS pixiv_resource_lru ON pixiv_resource_cache(last_used);
`)

export interface CachedResource { path: string; size: number; contentType: string; modified: number }
interface ResourceRow {
  key: string; path: string; bytes: number; content_type: string; created: number; last_used: number; etag: string | null
}
const inFlight = new Map<string, Promise<CachedResource>>()
const waiters: Array<() => void> = []
let activeDownloads = 0
const MAX_CONCURRENT_DOWNLOADS = 4

async function withDownloadSlot<T>(task: () => Promise<T>): Promise<T> {
  // Hand the occupied slot directly to the next waiter; do not release it early.
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) await new Promise<void>(resolve => waiters.push(resolve))
  else activeDownloads++
  try { return await task() }
  finally {
    const next = waiters.shift()
    if (next) next()
    else activeDownloads--
  }
}

export function pixivCacheKey(kind: 'page' | 'ugoira' | 'meta', illustId: string, page = 0, variant = 'preview'): string {
  return `${getPixivRuntime().account?.id || 'anonymous'}:${kind}:${illustId}:${page}:${variant}`
}
function safePath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex')
  return path.join(resourceRoot, hash.slice(0, 2), hash)
}
function rowToResource(row: ResourceRow): CachedResource | null {
  try {
    const info = statSync(row.path)
    return info.size > 0 && info.size === row.bytes ? { path: row.path, size: info.size, contentType: row.content_type, modified: info.mtimeMs } : null
  } catch { return null }
}
export function findCachedPixivResource(key: string): CachedResource | null {
  const row = db.prepare('SELECT * FROM pixiv_resource_cache WHERE key = ?').get(key) as ResourceRow | undefined
  if (!row) return null
  const resource = rowToResource(row)
  if (!resource) { db.prepare('DELETE FROM pixiv_resource_cache WHERE key = ?').run(key); return null }
  db.prepare('UPDATE pixiv_resource_cache SET last_used = ? WHERE key = ?').run(Date.now(), key)
  return resource
}
function assertAllowedUrl(url: string): URL {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new PixivApiError('Pixiv 资源地址无效', 502, 'invalid_resource') }
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || !host.endsWith('.pximg.net') || parsed.port || parsed.username || parsed.password) throw new PixivApiError('不允许缓存该远端地址', 400, 'invalid_url')
  return parsed
}
export function registerPixivResource(key: string, filePath: string, size: number, contentType: string, etag?: string | null): CachedResource {
  const now = Date.now()
  db.prepare(`
    INSERT INTO pixiv_resource_cache(key, path, bytes, content_type, created, last_used, etag)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET path = excluded.path, bytes = excluded.bytes,
      content_type = excluded.content_type, last_used = excluded.last_used, etag = excluded.etag
  `).run(key, filePath, size, contentType, now, now, etag || null)
  const info = statSync(filePath)
  return { path: filePath, size: info.size, contentType, modified: info.mtimeMs }
}

async function download(key: string, url: URL, hint: string | undefined, maxBytes: number): Promise<CachedResource> {
  const target = safePath(key)
  await fs.mkdir(path.dirname(target), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    const temporary = `${target}.${randomUUID()}.part`
    let response: Response | undefined
    try {
      response = await pixivRequest(url, { headers: { Referer: 'https://www.pixiv.net/', 'User-Agent': PIXIV_USER_AGENT, Accept: '*/*' } }, 60_000)
      if (!response.ok) throw new PixivApiError(`Pixiv 资源下载失败（HTTP ${response.status}）`, response.status >= 500 ? 502 : response.status, [429, 500, 502, 503, 504].includes(response.status) ? 'resource_retry' : 'resource_error')
      if (!response.body) throw new PixivApiError('Pixiv 资源响应为空', 502, 'invalid_resource')
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || hint || 'application/octet-stream'
      if (/text\/|json|html/i.test(contentType)) throw new PixivApiError('Pixiv 返回的内容不是媒体文件', 502, 'invalid_resource')
      if ((Number(response.headers.get('content-length')) || 0) > maxBytes) throw new PixivApiError('Pixiv 资源超过允许的缓存大小', 413, 'resource_too_large')
      let bytes = 0
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength
        callback(bytes > maxBytes ? new PixivApiError('Pixiv 资源超过允许的缓存大小', 413, 'resource_too_large') : null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body as never), limit, createWriteStream(temporary))
      if (!bytes) throw new PixivApiError('Pixiv 资源响应为空', 502, 'invalid_resource')
      await fs.rename(temporary, target)
      return registerPixivResource(key, target, bytes, contentType, response.headers.get('etag'))
    } catch (error) {
      await response?.body?.cancel().catch(() => undefined)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      if (attempt >= 2 || (error instanceof PixivApiError && !['network_error', 'timeout', 'resource_retry'].includes(error.code || ''))) throw error
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
}
export function getOrCachePixivResource(key: string, url: string, contentTypeHint?: string, maxBytes = 256 * 1024 * 1024): Promise<CachedResource> {
  const cached = findCachedPixivResource(key)
  if (cached) return Promise.resolve(cached)
  const running = inFlight.get(key)
  if (running) return running
  const task = withDownloadSlot(() => download(key, assertAllowedUrl(url), contentTypeHint, maxBytes)).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

export function pixivCacheStatus(limitBytes: number): PixivCacheStatus {
  const rows = db.prepare('SELECT path, bytes FROM pixiv_resource_cache').all() as unknown as Array<{ path: string; bytes: number }>
  let bytes = 0
  let files = 0
  const remove = db.prepare('DELETE FROM pixiv_resource_cache WHERE path = ?')
  for (const row of rows) {
    if (!existsSync(row.path)) { remove.run(row.path); continue }
    bytes += row.bytes
    files++
  }
  return { bytes, files, limitBytes: Math.max(0, limitBytes) }
}
function removeRows(rows: ResourceRow[]): { removed: number; bytes: number } {
  let removed = 0
  let bytes = 0
  const remove = db.prepare('DELETE FROM pixiv_resource_cache WHERE key = ?')
  for (const row of rows) {
    void fs.rm(row.path, { force: true }).catch(() => undefined)
    remove.run(row.key)
    removed++
    bytes += row.bytes
  }
  return { removed, bytes }
}
export function cleanCacheLimitDays(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(3650, Math.round(n)) : null
}
export function clearPixivCache(olderThanDays: number | null = null): { removed: number; bytes: number } {
  const cutoff = olderThanDays == null ? Number.MAX_SAFE_INTEGER : Date.now() - olderThanDays * 86_400_000
  return removeRows(db.prepare('SELECT * FROM pixiv_resource_cache WHERE last_used < ?').all(cutoff) as unknown as ResourceRow[])
}
export function enforcePixivCacheLimit(limitBytes: number): { removed: number; bytes: number } {
  const rows = db.prepare('SELECT * FROM pixiv_resource_cache ORDER BY last_used ASC').all() as unknown as ResourceRow[]
  let total = rows.reduce((sum, row) => sum + row.bytes, 0)
  const remove: ResourceRow[] = []
  for (const row of rows) { if (total <= limitBytes) break; remove.push(row); total -= row.bytes }
  return removeRows(remove)
}
