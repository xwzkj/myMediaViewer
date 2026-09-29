import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Work, WorksResponse } from '../shared/types.js'
import { adjacentWork, getLibrarySession, setLibraryLoader, syncLibrarySession } from '../src/library-session.js'

function work(id: string): Work {
  return {
    id, sourceId: 'source', sourceName: 'source', sourceKind: 'pixiv', externalId: id,
    title: id, author: '', description: '', tags: [], date: '', collected: 0, updated: 0,
    count: 1, kind: 'image', favorite: false, cover: '',
  }
}

function response(ids: string[]): WorksResponse {
  return { items: ids.map(work), total: ids.length, page: 1, pages: 1, elapsed: 0 }
}

test('列表会话按 key 隔离，作品页翻页使用自己的来源列表', () => {
  const sourceKey = 'test:source'
  const searchKey = 'test:search'
  syncLibrarySession(sourceKey, response(['source-1', 'source-2']))
  syncLibrarySession(searchKey, response(['search-1', 'search-2']))

  assert.equal(adjacentWork(sourceKey, 'source-1', 1)?.id, 'source-2')
  assert.equal(adjacentWork(searchKey, 'source-1', 1), undefined)
  assert.equal(adjacentWork(searchKey, 'search-1', 1)?.id, 'search-2')
})

test('加载更多函数按列表会话注册', async () => {
  const key = 'test:loader'
  let called = 0
  setLibraryLoader(key, async () => { called += 1 })
  await getLibrarySession(key)?.loadMore?.()
  assert.equal(called, 1)
})

test('清除加载器不会创建空会话', () => {
  const key = 'test:empty-loader'
  setLibraryLoader(key, null)
  assert.equal(getLibrarySession(key), undefined)
})
