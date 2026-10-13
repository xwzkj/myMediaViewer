import { db } from '../database.js'
import type { PixivBookmarkRestrict, PixivMirrorStatus, Work } from '../../shared/types.js'
import type { PixivStoredWork, PixivWorkMeta } from './types.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS pixiv_works (
    account_id TEXT NOT NULL,
    illust_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (account_id, illust_id)
  );
  CREATE INDEX IF NOT EXISTS pixiv_works_account ON pixiv_works(account_id, updated DESC);

  CREATE TABLE IF NOT EXISTS pixiv_bookmarks (
    account_id TEXT NOT NULL,
    illust_id TEXT NOT NULL,
    restrict TEXT NOT NULL,
    bookmark_seq INTEGER NOT NULL,
    data TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (account_id, illust_id, restrict)
  );
  CREATE INDEX IF NOT EXISTS pixiv_bookmarks_shelf
    ON pixiv_bookmarks(account_id, restrict, bookmark_seq DESC);

  CREATE TABLE IF NOT EXISTS pixiv_mirror_state (
    account_id TEXT NOT NULL,
    restrict TEXT NOT NULL,
    started INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'idle',
    next_url TEXT,
    pages INTEGER NOT NULL DEFAULT 0,
    items INTEGER NOT NULL DEFAULT 0,
    last_synced INTEGER,
    last_full_sweep INTEGER,
    error TEXT NOT NULL DEFAULT '',
    generation INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, restrict)
  );

  CREATE TABLE IF NOT EXISTS pixiv_api_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires INTEGER NOT NULL,
    last_used INTEGER NOT NULL
  );
`)

interface PixivMirrorRow {
  restrict: string
  started: number
  phase: string
  next_url: string | null
  pages: number
  items: number
  last_synced: number | null
  last_full_sweep: number | null
  error: string
  generation: number
}

export interface PixivMirrorState {
  restrict: PixivBookmarkRestrict
  started: boolean
  phase: PixivMirrorStatus['phase']
  nextUrl: string | null
  pages: number
  items: number
  lastSynced: number | null
  lastFullSweep: number | null
  error: string
  generation: number
}

function asRestrict(value: string): PixivBookmarkRestrict {
  return value === 'private' ? 'private' : 'public'
}

function asPhase(value: string): PixivMirrorStatus['phase'] {
  return value === 'backfilling' || value === 'maintaining' || value === 'ready' || value === 'error'
    ? value
    : 'idle'
}

export function getPixivMirrorState(accountId: string, restrict: PixivBookmarkRestrict): PixivMirrorState {
  const row = db.prepare('SELECT * FROM pixiv_mirror_state WHERE account_id = ? AND restrict = ?')
    .get(accountId, restrict) as PixivMirrorRow | undefined
  return {
    restrict,
    started: row?.started === 1,
    phase: asPhase(row?.phase || 'idle'),
    nextUrl: row?.next_url ?? null,
    pages: row?.pages ?? 0,
    items: row?.items ?? 0,
    lastSynced: row?.last_synced ?? null,
    lastFullSweep: row?.last_full_sweep ?? null,
    error: row?.error || '',
    generation: row?.generation ?? 0,
  }
}

export function allPixivMirrorStates(accountId: string): Record<PixivBookmarkRestrict, PixivMirrorStatus> {
  return {
    public: toPublicStatus(getPixivMirrorState(accountId, 'public')),
    private: toPublicStatus(getPixivMirrorState(accountId, 'private')),
  }
}

function toPublicStatus(state: PixivMirrorState): PixivMirrorStatus {
  return {
    restrict: state.restrict,
    started: state.started,
    phase: state.phase,
    pages: state.pages,
    items: state.items,
    lastSynced: state.lastSynced,
    lastFullSweep: state.lastFullSweep,
    error: state.error,
  }
}

export function savePixivMirrorState(accountId: string, state: PixivMirrorState): void {
  db.prepare(`
    INSERT INTO pixiv_mirror_state
      (account_id, restrict, started, phase, next_url, pages, items, last_synced, last_full_sweep, error, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, restrict) DO UPDATE SET
      started = excluded.started,
      phase = excluded.phase,
      next_url = excluded.next_url,
      pages = excluded.pages,
      items = excluded.items,
      last_synced = excluded.last_synced,
      last_full_sweep = excluded.last_full_sweep,
      error = excluded.error,
      generation = excluded.generation
  `).run(
    accountId,
    state.restrict,
    state.started ? 1 : 0,
    state.phase,
    state.nextUrl,
    state.pages,
    state.items,
    state.lastSynced,
    state.lastFullSweep,
    state.error,
    state.generation,
  )
}

export function savePixivWorkRecords(accountId: string, records: PixivStoredWork[], lastSeen = Date.now()): void {
  if (!records.length) return
  const statement = db.prepare(`
    INSERT INTO pixiv_works(account_id, illust_id, data, updated, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, illust_id) DO UPDATE SET
      data = excluded.data,
      updated = excluded.updated,
      last_seen = excluded.last_seen
  `)
  db.exec('BEGIN')
  try {
    for (const record of records) {
      const work = record.work
      const illustId = work.pixivId || work.externalId
      if (!/^\d+$/.test(illustId)) continue
      const existing = getPixivWorkRecord(accountId, illustId)
      // List responses must not discard full-detail pages or lazily fetched animation metadata.
      const meta = { ...record.meta }
      if (existing) {
        if (!meta.bookmarkTags) meta.bookmarkTags = existing.meta.bookmarkTags
        if (!meta.ugoira && work.kind === 'animation') meta.ugoira = existing.meta.ugoira
        if (!meta.detailFetchedAt && existing.meta.detailFetchedAt) {
          meta.pages = existing.meta.pages
          meta.detailFetchedAt = existing.meta.detailFetchedAt
        }
      }
      statement.run(accountId, illustId, JSON.stringify({ work, meta }), work.updated || Date.now(), lastSeen)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function savePixivWorks(accountId: string, works: Work[], lastSeen = Date.now()): void {
  savePixivWorkRecords(accountId, works.map(work => ({
    work,
    meta: { pages: [], kind: work.kind },
  })), lastSeen)
}

export function getPixivWorkRecords(accountId: string): PixivStoredWork[] {
  return (db.prepare('SELECT data FROM pixiv_works WHERE account_id = ?').all(accountId) as { data: string }[])
    .map(row => JSON.parse(row.data) as PixivStoredWork)
}

export function getPixivWorks(accountId: string): Work[] {
  return getPixivWorkRecords(accountId).map(record => record.work)
}

export function getPixivWorkRecord(accountId: string, illustId: string): PixivStoredWork | undefined {
  const row = db.prepare('SELECT data FROM pixiv_works WHERE account_id = ? AND illust_id = ?')
    .get(accountId, illustId) as { data: string } | undefined
  return row ? JSON.parse(row.data) as PixivStoredWork : undefined
}

export function getPixivWork(accountId: string, illustId: string): Work | undefined {
  return getPixivWorkRecord(accountId, illustId)?.work
}

export function savePixivBookmarks(
  accountId: string,
  restrict: PixivBookmarkRestrict,
  works: Array<{ work: Work; sequence: number; meta?: PixivWorkMeta }>,
  lastSeen = Date.now(),
): void {
  if (!works.length) return
  const statement = db.prepare(`
    INSERT INTO pixiv_bookmarks(account_id, illust_id, restrict, bookmark_seq, data, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, illust_id, restrict) DO UPDATE SET
      bookmark_seq = excluded.bookmark_seq,
      data = excluded.data,
      last_seen = excluded.last_seen
  `)
  db.exec('BEGIN')
  try {
    for (const { work, sequence, meta } of works) {
      const illustId = work.pixivId || work.externalId
      if (!/^\d+$/.test(illustId)) continue
      statement.run(accountId, illustId, restrict, sequence, JSON.stringify({ work, sequence, meta }), lastSeen)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getPixivBookmarkRecords(accountId: string, restrict: PixivBookmarkRestrict): Array<{ work: Work; sequence: number; meta?: PixivWorkMeta }> {
  return (db.prepare('SELECT data FROM pixiv_bookmarks WHERE account_id = ? AND restrict = ? ORDER BY bookmark_seq DESC')
    .all(accountId, restrict) as { data: string }[]).map(row => {
      const parsed = JSON.parse(row.data) as { work?: Work; sequence?: number; meta?: PixivWorkMeta }
      return parsed.work ? { work: parsed.work, sequence: parsed.sequence ?? 0, meta: parsed.meta } : { work: parsed as unknown as Work, sequence: 0 }
    })
}

export function getPixivBookmarks(accountId: string, restrict: PixivBookmarkRestrict): Work[] {
  return getPixivBookmarkRecords(accountId, restrict).map(record => record.work)
}

export function countPixivBookmarks(accountId: string, restrict: PixivBookmarkRestrict): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM pixiv_bookmarks WHERE account_id = ? AND restrict = ?').get(accountId, restrict) as { count: number }
  return row?.count || 0
}

export function getPixivBookmarkRestrict(accountId: string, illustId: string): PixivBookmarkRestrict | null {
  const row = db.prepare('SELECT restrict FROM pixiv_bookmarks WHERE account_id = ? AND illust_id = ? LIMIT 1')
    .get(accountId, illustId) as { restrict: string } | undefined
  return row ? asRestrict(row.restrict) : null
}

export function removePixivBookmark(accountId: string, illustId: string): void {
  db.prepare('DELETE FROM pixiv_bookmarks WHERE account_id = ? AND illust_id = ?').run(accountId, illustId)
}

export function updatePixivBookmark(
  accountId: string,
  illustId: string,
  restrict: PixivBookmarkRestrict,
  bookmarked: boolean,
  work?: Work,
): void {
  if (!bookmarked) {
    removePixivBookmark(accountId, illustId)
    const record = getPixivWorkRecord(accountId, illustId)
    if (record) savePixivWorkRecords(accountId, [{ ...record, work: { ...record.work, cloudBookmark: { bookmarked: false, restrict } } }])
    return
  }
  const current = work || getPixivWork(accountId, illustId)
  if (!current) return
  removePixivBookmark(accountId, illustId)
  const meta = getPixivWorkRecord(accountId, illustId)?.meta
  const updated = { ...current, cloudBookmark: { bookmarked: true, restrict } }
  savePixivBookmarks(accountId, restrict, [{ work: updated, sequence: Date.now(), meta }])
  if (meta) savePixivWorkRecords(accountId, [{ work: updated, meta }])
}

export function removeMissingPixivBookmarks(
  accountId: string,
  restrict: PixivBookmarkRestrict,
  keepIds: Set<string>,
  sweepStartedAt: number,
): number {
  const rows = db.prepare('SELECT illust_id FROM pixiv_bookmarks WHERE account_id = ? AND restrict = ? AND last_seen < ?')
    .all(accountId, restrict, sweepStartedAt) as { illust_id: string }[]
  const remove = db.prepare('DELETE FROM pixiv_bookmarks WHERE account_id = ? AND illust_id = ? AND restrict = ?')
  let removed = 0
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      if (keepIds.has(row.illust_id)) continue
      remove.run(accountId, row.illust_id, restrict)
      removed++
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return removed
}

export function deletePixivDataForOtherAccounts(accountId: string): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM pixiv_works WHERE account_id <> ?').run(accountId)
    db.prepare('DELETE FROM pixiv_bookmarks WHERE account_id <> ?').run(accountId)
    db.prepare('DELETE FROM pixiv_mirror_state WHERE account_id <> ?').run(accountId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getPixivApiCache<T>(cacheKey: string): T | null {
  const now = Date.now()
  const row = db.prepare('SELECT data, expires FROM pixiv_api_cache WHERE cache_key = ?')
    .get(cacheKey) as { data: string; expires: number } | undefined
  if (!row) return null
  if (row.expires <= now) {
    db.prepare('DELETE FROM pixiv_api_cache WHERE cache_key = ?').run(cacheKey)
    return null
  }
  db.prepare('UPDATE pixiv_api_cache SET last_used = ? WHERE cache_key = ?').run(now, cacheKey)
  return JSON.parse(row.data) as T
}

export function setPixivApiCache(cacheKey: string, value: unknown, ttlMs: number): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO pixiv_api_cache(cache_key, data, expires, last_used) VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET data = excluded.data, expires = excluded.expires, last_used = excluded.last_used
  `).run(cacheKey, JSON.stringify(value), now + Math.max(0, ttlMs), now)
}

export function clearPixivApiCache(): void {
  db.prepare('DELETE FROM pixiv_api_cache').run()
}
