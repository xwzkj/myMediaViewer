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

export const librarySession: {
  items: Work[]
  total: number
  page: number
  pages: number
  activeWorkId: string
  context: LibraryContext
  loadMore: SessionLoader | null
} = {
  items: [],
  total: 0,
  page: 1,
  pages: 1,
  activeWorkId: '',
  context: { source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', seed: '' },
  loadMore: null,
}

export function syncLibrarySession(response: WorksResponse, append = false) {
  librarySession.items = append ? [...librarySession.items, ...response.items] : response.items
  librarySession.total = response.total
  librarySession.page = response.page
  librarySession.pages = response.pages
}

export function setLibraryLoader(loader: SessionLoader | null) {
  librarySession.loadMore = loader
}

export function adjacentWork(id: string, direction: number): Work | undefined {
  const index = librarySession.items.findIndex(work => work.id === id)
  return index < 0 ? undefined : librarySession.items[index + direction]
}
