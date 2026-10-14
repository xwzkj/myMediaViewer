import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorksResponse } from '../shared/types.js'
import {
  ensureLibrarySession,
  getLibrarySession,
  librarySessionOwners,
  releaseLibrarySession,
  retainLibrarySession,
  setLibraryLoader,
  syncLibrarySession,
} from '../src/library-session.js'
import { asCloudSearchEntity } from '../src/library-state.js'
import { routeCacheKey } from '../src/route-cache-key.js'

function worksResponse(ids: string[], page = 1, pages = 1): WorksResponse {
  return {
    items: ids.map(id => ({
      id, sourceId: 'source', sourceName: 'source', sourceKind: 'pixiv', externalId: id,
      title: id, author: '', description: '', tags: [], date: '', collected: 0, updated: 0,
      count: 1, kind: 'image', favorite: false, cover: '',
    })),
    total: ids.length, page, pages, elapsed: 0,
  }
}

function route(name: string, query: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return { name, query, params } as Parameters<typeof routeCacheKey>[0]
}

// pid 主契约：同 pid 同实例，不同 pid 必不同实例；entity 不进 key。
test('pid 主契约：同 pid replace 不换实例，不同 pid 必换；entity 不影响 key', () => {
  const base = { pid: 'pid-a', q: 'miku', entity: 'works' }
  assert.equal(routeCacheKey(route('cloudSearch', { ...base })), 'cloudSearch:pid-pid-a')
  assert.equal(
    routeCacheKey(route('cloudSearch', { ...base, sort: 'date_desc' })),
    'cloudSearch:pid-pid-a',
  )
  assert.equal(
    routeCacheKey(route('cloudSearch', { ...base, entity: 'users' })),
    'cloudSearch:pid-pid-a',
  )
  assert.notEqual(
    routeCacheKey(route('cloudSearch', { ...base })),
    routeCacheKey(route('cloudSearch', { ...base, pid: 'pid-b' })),
  )
  assert.equal(routeCacheKey(route('work', { pid: 'w1' })), 'work:pid-w1')
  assert.equal(routeCacheKey(route('cloudWork', { pid: 'w1' })), 'work:pid-w1')
  assert.equal(routeCacheKey(route('cloudUser', { pid: 'u1' }, { userId: '1' })), 'cloudUser:pid-u1')
})

// URL 缺 entity 永远 works；非法值回退 works。
test('entity 归一：缺失/非法一律 works，只有 users 显式通过', () => {
  assert.equal(asCloudSearchEntity(undefined), 'works')
  assert.equal(asCloudSearchEntity(''), 'works')
  assert.equal(asCloudSearchEntity('works'), 'works')
  assert.equal(asCloudSearchEntity('users'), 'users')
  assert.equal(asCloudSearchEntity('USER'), 'works')
  assert.equal(asCloudSearchEntity(null), 'works')
})

// cloud append 语义：reset 替换、翻页追加；users 不进 Work 会话。
test('会话 sync：reset 替换、append 追加；users 独立不污染 works 会话', () => {
  const key = 'test:cloud-append'
  syncLibrarySession(key, worksResponse(['a', 'b']))
  assert.deepEqual(getLibrarySession(key)?.items.map(item => item.id), ['a', 'b'])
  syncLibrarySession(key, worksResponse(['c'], 2, 2), true)
  assert.deepEqual(getLibrarySession(key)?.items.map(item => item.id), ['a', 'b', 'c'])
  syncLibrarySession(key, worksResponse(['x']))
  assert.deepEqual(getLibrarySession(key)?.items.map(item => item.id), ['x'])
  assert.equal(getLibrarySession('test:cloud-users-shadow'), undefined)
})

// 来源卸载不清 held loader：详情仍持有时 loadMore 保持可用；0 owner 才 delete。
test('持有计数：来源卸载不清 loader，详情持有仍可续页；0 owner 才删', async () => {
  const key = 'test:held-loader'
  let calls = 0
  retainLibrarySession(key)
  setLibraryLoader(key, async () => { calls += 1 })
  retainLibrarySession(key)
  // 来源卸载：只 release 一次（不清 loader）。
  releaseLibrarySession(key)
  assert.equal(librarySessionOwners(key), 1)
  await getLibrarySession(key)?.loadMore?.()
  assert.equal(calls, 1)
  releaseLibrarySession(key)
  assert.equal(librarySessionOwners(key), 0)
  assert.equal(getLibrarySession(key), undefined)
})

test('ensure 不改变持有计数；release 空 key 安全', () => {
  const key = 'test:retain-neutral'
  ensureLibrarySession(key)
  assert.equal(librarySessionOwners(key), 0)
  releaseLibrarySession(key)
  assert.equal(getLibrarySession(key), undefined)
})
