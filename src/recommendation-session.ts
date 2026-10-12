import type { PixivSearchResponse, Work, WorksResponse } from '../shared/types'
import { api } from './api'
import { getLibrarySession, setLibraryLoader, syncLibrarySession } from './library-session'
import { createSearchSessionId } from './route-cache-key'

interface RecommendationSnapshot {
  workId: string
  pixivId?: string
  source: 'local' | 'cloud'
  items: Work[]
  page: number
  pages: number
  cursor: string | null
}

// Keep the clicked list independent of the recommendations for the next work.
export function createRecommendationSession(
  snapshot: RecommendationSnapshot,
  loadPage: <T>(url: string) => Promise<T> = api,
): string {
  const key = `recommendations:${createSearchSessionId()}`
  const cloud = snapshot.source === 'cloud'
  let cursor = snapshot.cursor
  let page = snapshot.page
  let pages = cloud ? (cursor ? page + 1 : page) : snapshot.pages
  syncLibrarySession(key, { items: [...snapshot.items], total: snapshot.items.length, page, pages, elapsed: 0 })
  let pending: Promise<void> | undefined
  async function loadMore() {
    if (page >= pages) return
    let response: WorksResponse
    if (cloud) {
      const params = new URLSearchParams({ cursor: cursor! })
      const result = await loadPage<PixivSearchResponse>(`/pixiv/works/${encodeURIComponent(snapshot.pixivId!)}/related?${params}`)
      cursor = result.nextCursor
      page++
      pages = cursor ? page + 1 : page
      response = { items: result.items, total: 0, page, pages, elapsed: result.elapsed }
    } else {
      response = await loadPage<WorksResponse>(`/works/${encodeURIComponent(snapshot.workId)}/related?page=${page + 1}`)
      page = response.page
      pages = response.pages
    }
    const items = [...new Map([...getLibrarySession(key)!.items, ...response.items].map(item => [item.id, item])).values()]
    syncLibrarySession(key, { ...response, items, total: cloud ? items.length : response.total })
    if (page >= pages) setLibraryLoader(key, null)
  }
  if (page < pages) setLibraryLoader(key, () => {
    pending ??= loadMore().finally(() => { pending = undefined })
    return pending
  })
  return key
}
