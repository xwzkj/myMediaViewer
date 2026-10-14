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
  // visited：会话内已见 id，服务端游标回吐重复时保证不重复追加。
  const visited = new Set(snapshot.items.map(item => item.id))
  syncLibrarySession(key, { items: [...snapshot.items], total: snapshot.items.length, page, pages, elapsed: 0 })
  let pending: Promise<void> | undefined
  async function loadMore() {
    if (page >= pages) return
    let response: WorksResponse
    if (cloud) {
      const params = new URLSearchParams({ cursor: cursor! })
      const result = await loadPage<PixivSearchResponse>(`/pixiv/works/${encodeURIComponent(snapshot.pixivId!)}/related?${params}`)
      cursor = result.nextCursor
      // page+1 语义：每次成功翻页恰好 +1，不跳页；pages 跟随“还有下一页”。
      page = page + 1
      pages = cursor ? page + 1 : page
      const fresh = result.items.filter(item => !visited.has(item.id))
      for (const item of fresh) visited.add(item.id)
      response = { items: fresh, total: 0, page, pages, elapsed: result.elapsed }
    } else {
      response = await loadPage<WorksResponse>(`/works/${encodeURIComponent(snapshot.workId)}/related?page=${page + 1}`)
      page = response.page
      pages = response.pages
    }
    const items = [...new Map([...getLibrarySession(key)!.items, ...response.items].map(item => [item.id, item])).values()]
    for (const item of items) visited.add(item.id)
    syncLibrarySession(key, { ...response, items, total: cloud ? items.length : response.total })
    if (page >= pages) setLibraryLoader(key, null)
  }
  if (page < pages) setLibraryLoader(key, () => {
    pending ??= loadMore().finally(() => { pending = undefined })
    return pending
  })
  return key
}
