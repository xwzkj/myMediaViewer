import type { Work, WorksResponse } from '../shared/types'

type SessionLoader = () => Promise<void>

export interface LibrarySession {
  key: string
  items: Work[]
  total: number
  page: number
  pages: number
  loadMore: SessionLoader | null
}

const sessions = new Map<string, LibrarySession>()
const owners = new Map<string, number>()

function createSession(key: string): LibrarySession {
  return {
    key,
    items: [],
    total: 0,
    page: 1,
    pages: 1,
    loadMore: null,
  }
}

/**
 * 会话持有计数：来源页在缓存存续期持有，详情页在存续期持有来源 list。
 * 失活不释放；真正卸载（0 owner 才删）或 push 失败时释放。被持有时不被清理。
 * loader 在来源卸载时不清空：KeepAlive 淘汰来源而详情仍持有时，held loader
 * 保持 fetch 能力，详情跨页续加载不受来源 destroyed 影响（主流程；LRU 语义
 * 不 overbuild，0 owner 才 delete）。
 */
export function retainLibrarySession(key: string): void {
  ensureLibrarySession(key)
  owners.set(key, (owners.get(key) || 0) + 1)
}

export function releaseLibrarySession(key: string): void {
  const count = (owners.get(key) || 0) - 1
  if (count <= 0) {
    owners.delete(key)
    sessions.delete(key)
    return
  }
  owners.set(key, count)
}

export function librarySessionOwners(key: string): number {
  return owners.get(key) || 0
}

export function getLibrarySession(key: string): LibrarySession | undefined {
  return sessions.get(key)
}

export function ensureLibrarySession(key: string): LibrarySession {
  let session = sessions.get(key)
  if (!session) {
    session = createSession(key)
    sessions.set(key, session)
  }
  return session
}

export function syncLibrarySession(key: string, response: WorksResponse, append = false) {
  const session = ensureLibrarySession(key)
  session.items = append ? [...session.items, ...response.items] : response.items
  session.total = response.total
  session.page = response.page
  session.pages = response.pages
}

export function setLibraryLoader(key: string, loader: SessionLoader | null) {
  const session = loader ? ensureLibrarySession(key) : sessions.get(key)
  if (session) session.loadMore = loader
}

export function adjacentWork(key: string, id: string, direction: number): Work | undefined {
  const items = getLibrarySession(key)?.items
  if (!items) return undefined
  const index = items.findIndex(work => work.id === id)
  return index < 0 ? undefined : items[index + direction]
}
