import test from 'node:test'
import assert from 'node:assert/strict'
import type { Work, WorksResponse } from '../shared/types.js'
import { createRecommendationSession } from '../src/recommendation-session.js'
import { adjacentWork, getLibrarySession, syncLibrarySession } from '../src/library-session.js'

const work = (id: string) => ({ id } as Work)
const response = (ids: string[], page = 1, pages = 1): WorksResponse => ({ items: ids.map(work), total: 4, page, pages, elapsed: 0 })

test('推荐会话独立于来源列表和新作品的推荐，前后切换保持点击时的顺序', () => {
  syncLibrarySession('library', response(['library-a', 'library-b']))
  const items = ['a', 'b', 'c'].map(work)
  const key = createRecommendationSession({ workId: 'seed', source: 'local', items, page: 1, pages: 1, cursor: null })
  items.splice(0, items.length, work('new-recommendation'))
  const nextKey = createRecommendationSession({ workId: 'b', source: 'local', items, page: 1, pages: 1, cursor: null })
  assert.notEqual(key, nextKey)
  assert.equal(adjacentWork(key, 'b', -1)?.id, 'a')
  assert.equal(adjacentWork(key, 'b', 1)?.id, 'c')
  assert.equal(adjacentWork('library', 'b', 1), undefined)
})

test('本地推荐到末尾时继续加载原作品的下一页，并合并重复项', async () => {
  let requests = 0
  const key = createRecommendationSession({ workId: 'seed:local', source: 'local', items: ['a', 'b'].map(work), page: 1, pages: 2, cursor: null }, async <T>(url: string) => {
    assert.equal(url, '/works/seed%3Alocal/related?page=2')
    requests++
    return response(['b', 'c', 'd'], 2, 2) as T
  })
  await Promise.all([getLibrarySession(key)!.loadMore!(), getLibrarySession(key)!.loadMore!()])
  assert.equal(requests, 1)
  assert.equal(adjacentWork(key, 'b', 1)?.id, 'c')
  assert.equal(adjacentWork(key, 'c', -1)?.id, 'b')
  assert.equal(getLibrarySession(key)?.loadMore, null)
})

test('云端推荐分页保留原作品与游标，失败后仍可重试', async () => {
  let requests = 0
  const key = createRecommendationSession({ workId: 'pixiv:123', pixivId: '123', source: 'cloud', items: ['pixiv:a', 'pixiv:b'].map(work), page: 2, pages: 2, cursor: 'original cursor' }, async <T>(url: string) => {
    assert.equal(url, '/pixiv/works/123/related?cursor=original+cursor')
    if (++requests === 1) throw new Error('network failure')
    return { items: [work('pixiv:c')], nextCursor: null, elapsed: 0 } as T
  })
  await assert.rejects(getLibrarySession(key)!.loadMore!(), /network failure/)
  assert.equal(getLibrarySession(key)?.page, 2)
  await getLibrarySession(key)!.loadMore!()
  assert.equal(adjacentWork(key, 'pixiv:b', 1)?.id, 'pixiv:c')
  assert.equal(getLibrarySession(key)?.page, 3)
  assert.equal(getLibrarySession(key)?.loadMore, null)
})
