import { setTimeout as delay } from 'node:timers/promises'
import type { PixivBookmarkRestrict } from '../../shared/types.js'
import { assertPixivSession, getPixivRuntime, getPixivSessionVersion, requirePixivReady } from './auth.js'
import { pixivFetch } from './client.js'
import { clearUnifiedCatalogCache, normalizePixivIllust } from './catalog.js'
import { pixivIllustPage } from './service.js'
import type { PixivIllustPage } from './service.js'
import { PixivApiError } from './errors.js'
import { pixivPageUrl } from './protocol.js'
import { countPixivBookmarks, getPixivBookmarkRecords, getPixivMirrorState, removeMissingPixivBookmarks, savePixivBookmarks, savePixivMirrorState, savePixivWorkRecords } from './store.js'

const PAGE_INTERVAL_MS = 5_000
export type PixivMirrorMode = 'incremental' | 'full'
export interface PixivMirrorOptions { mode?: PixivMirrorMode; manual?: boolean }
interface MirrorJob { version: number; controller: AbortController; promise: Promise<void> }
const jobs = new Map<string, MirrorJob>()
const lastStartAt = new Map<string, number>()

function firstBookmarkPage(uid: string, restrict: PixivBookmarkRestrict): string {
  return `/v1/user/bookmarks/illust?user_id=${uid}&restrict=${restrict}&filter=for_ios`
}

async function loopFull(uid: string, restrict: PixivBookmarkRestrict, job: MirrorJob): Promise<void> {
  const firstPage = firstBookmarkPage(uid, restrict)
  const visited = new Set<string>()
  try {
    for (;;) {
      assertPixivSession(job.version)
      job.controller.signal.throwIfAborted()
      const state = getPixivMirrorState(uid, restrict)
      if (!state.started) return
      const url = state.nextUrl ? pixivPageUrl(state.nextUrl, firstPage) : firstPage
      if (visited.has(url)) throw new PixivApiError('Pixiv 返回了重复的收藏分页，请重试', 502, 'invalid_response')
      visited.add(url)
      const response = pixivIllustPage(await pixivFetch<PixivIllustPage>(url, { signal: job.controller.signal }))
      assertPixivSession(job.version)
      job.controller.signal.throwIfAborted()
      const nextUrl = response.next_url ? pixivPageUrl(response.next_url, firstPage) : null
      if (nextUrl && (visited.has(nextUrl) || nextUrl === new URL(url, 'https://app-api.pixiv.net').toString())) throw new PixivApiError('Pixiv 返回了重复的收藏分页，请重试', 502, 'invalid_response')
      // Animation ZIP metadata is fetched when opened, never once per bookmarked work.
      const records = response.illusts.map(raw => normalizePixivIllust(raw, restrict))
      const now = Date.now()
      savePixivWorkRecords(uid, records, now)
      savePixivBookmarks(uid, restrict, records.map((record, index) => ({
        work: record.work,
        sequence: state.generation - state.items - index,
        meta: record.meta,
      })), now)
      // Persisted last_seen makes full-sweep pruning safe across restarts and failures.
      if (!nextUrl) removeMissingPixivBookmarks(uid, restrict, new Set(), state.generation)
      savePixivMirrorState(uid, {
        ...state,
        phase: nextUrl ? 'backfilling' : 'ready',
        nextUrl,
        pages: state.pages + 1,
        items: state.items + records.length,
        lastSynced: now,
        lastFullSweep: nextUrl ? state.lastFullSweep : now,
        error: '',
      })
      clearUnifiedCatalogCache()
      if (!nextUrl) return
      await delay(PAGE_INTERVAL_MS, undefined, { signal: job.controller.signal })
    }
  } catch (error) {
    // A retired account/session must never write state back after it was removed.
    if (job.controller.signal.aborted || job.version !== getPixivSessionVersion()) return
    const state = getPixivMirrorState(uid, restrict)
    savePixivMirrorState(uid, { ...state, phase: 'error', error: error instanceof Error ? error.message : 'Pixiv 收藏同步失败' })
  }
}

async function loopIncremental(uid: string, restrict: PixivBookmarkRestrict, job: MirrorJob): Promise<void> {
  const firstPage = firstBookmarkPage(uid, restrict)
  const existing = new Map(getPixivBookmarkRecords(uid, restrict).map(record => [
    record.work.pixivId || record.work.externalId,
    record.sequence,
  ]))
  const visited = new Set<string>()
  try {
    let url: string | null = firstPage
    for (;;) {
      if (!url) return
      assertPixivSession(job.version)
      job.controller.signal.throwIfAborted()
      if (visited.has(url)) throw new PixivApiError('Pixiv 返回了重复的收藏分页，请重试', 502, 'invalid_response')
      visited.add(url)
      const response = pixivIllustPage(await pixivFetch<PixivIllustPage>(url, { signal: job.controller.signal }))
      assertPixivSession(job.version)
      job.controller.signal.throwIfAborted()
      const nextUrl = response.next_url ? pixivPageUrl(response.next_url, firstPage) : null
      if (nextUrl && (visited.has(nextUrl) || nextUrl === new URL(url, 'https://app-api.pixiv.net').toString())) throw new PixivApiError('Pixiv 返回了重复的收藏分页，请重试', 502, 'invalid_response')

      const records = response.illusts.map(raw => normalizePixivIllust(raw, restrict))
      const now = Date.now()
      let added = 0
      const updates = records.map((record, index) => {
        const id = record.work.pixivId || record.work.externalId
        const current = existing.get(id)
        const isNew = current === undefined
        const sequence = current ?? now - added - index
        if (isNew) {
          added++
          existing.set(id, sequence)
        }
        return { work: record.work, sequence, meta: record.meta, isNew }
      })
      const hasNew = updates.some(item => item.isNew)
      savePixivWorkRecords(uid, records, now)
      savePixivBookmarks(uid, restrict, updates.map(({ isNew: _isNew, ...item }) => item), now)
      const state = getPixivMirrorState(uid, restrict)
      savePixivMirrorState(uid, {
        ...state,
        started: true,
        phase: hasNew && nextUrl ? 'maintaining' : 'ready',
        nextUrl: null,
        items: countPixivBookmarks(uid, restrict),
        lastSynced: now,
        error: '',
      })
      clearUnifiedCatalogCache()
      if (!hasNew || !nextUrl) return
      url = nextUrl
      await delay(PAGE_INTERVAL_MS, undefined, { signal: job.controller.signal })
    }
  } catch (error) {
    if (job.controller.signal.aborted || job.version !== getPixivSessionVersion()) return
    const state = getPixivMirrorState(uid, restrict)
    savePixivMirrorState(uid, { ...state, phase: 'error', error: error instanceof Error ? error.message : 'Pixiv 收藏增量更新失败' })
  }
}

export function startPixivMirror(restrict: PixivBookmarkRestrict, options: PixivMirrorOptions = {}): void {
  requirePixivReady()
  const mode = options.mode ?? 'full'
  const manual = options.manual === true
  const uid = getPixivRuntime().account!.id
  const version = getPixivSessionVersion()
  const key = `${uid}:${restrict}`
  const running = jobs.get(key)
  if (running?.version === version) return
  running?.controller.abort()
  const current = getPixivMirrorState(uid, restrict)
  const now = Date.now()
  if (!manual && current.phase === 'ready' && (lastStartAt.get(key) || 0) > now - 30_000) return
  lastStartAt.set(key, now)

  if (mode === 'incremental') {
    savePixivMirrorState(uid, { ...current, started: true, phase: 'maintaining', nextUrl: null, error: '' })
  } else {
    const resume = !manual && current.started && Boolean(current.nextUrl)
    if (!resume) {
      savePixivMirrorState(uid, { ...current, started: true, phase: 'backfilling', nextUrl: null, pages: 0, items: 0, error: '', generation: now })
    }
  }

  const job: MirrorJob = { version, controller: new AbortController(), promise: Promise.resolve() }
  jobs.set(key, job)
  job.promise = (mode === 'incremental' ? loopIncremental : loopFull)(uid, restrict, job).finally(() => { if (jobs.get(key) === job) jobs.delete(key) })
}

export async function stopPixivMirrors(): Promise<void> {
  const active = [...jobs.values()]
  for (const job of active) job.controller.abort()
  await Promise.all(active.map(job => job.promise))
}

export function resumePixivMirrors(): void {
  const runtime = getPixivRuntime()
  if (runtime.localMode || !runtime.configured || !runtime.account) return
  for (const restrict of ['public', 'private'] as const) {
    const state = getPixivMirrorState(runtime.account.id, restrict)
    if (state.started && state.nextUrl) startPixivMirror(restrict)
  }
}
