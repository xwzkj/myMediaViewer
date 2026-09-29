import type { Work, WorksResponse } from '../shared/types'

type SessionLoader = () => Promise<void>

export interface LibraryContext {
  source: string
  kind: string
  fuzzy: boolean
  sort: string
  order: 'collected' | 'published'
  seed: string
}

export interface LibrarySession {
  key: string
  items: Work[]
  total: number
  page: number
  pages: number
  context: LibraryContext
  loadMore: SessionLoader | null
}

const sessions = new Map<string, LibrarySession>()

function createSession(key: string): LibrarySession {
  return {
    key,
    items: [],
    total: 0,
    page: 1,
    pages: 1,
    context: { source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', seed: '' },
    loadMore: null,
  }
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

export function setLibraryContext(key: string, context: LibraryContext) {
  ensureLibrarySession(key).context = context
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
