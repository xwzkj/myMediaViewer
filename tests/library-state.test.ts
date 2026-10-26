import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bootstrapLibraryState,
  defaultLibraryState,
  flushLibraryState,
  hydrateLibraryState,
  readLibraryState,
  readRecommendationSource,
  resetLibraryStateForTests,
  writeLibraryState,
  writeRecommendationSource,
  type LibraryScope,
  type LibraryStateMap,
} from '../src/library-state.js'

interface RecordedCall { url: string; method: string; body?: string }
interface MockState { calls: RecordedCall[]; get: unknown | 'fail'; putStatus: number }

const mock: MockState = { calls: [], get: {}, putStatus: 200 }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method || 'GET').toUpperCase()
  mock.calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
  if (url === '/api/library-state' && method === 'GET') {
    if (mock.get === 'fail') throw new Error('offline')
    return json(mock.get)
  }
  if (url.startsWith('/api/library-state/') && method === 'PUT') {
    return mock.putStatus >= 200 && mock.putStatus < 300 ? json({ ok: true }) : json({ message: 'failed' }, mock.putStatus)
  }
  return json({ message: 'not found' }, 404)
}) as typeof fetch

function reset(): void {
  resetLibraryStateForTests()
  mock.calls = []
  mock.get = {}
  mock.putStatus = 200
}

function puts(scope?: LibraryScope): RecordedCall[] {
  return mock.calls.filter(call => call.method === 'PUT' && (!scope || call.url.endsWith(`/${scope}`)))
}

function fullState(overrides: Partial<LibraryStateMap> = {}): LibraryStateMap {
  return { ...defaultLibraryState(), ...overrides }
}

test('媒体库、本地搜索、云搜索状态完全隔离', async () => {
  reset()
  writeLibraryState('works', { ...defaultLibraryState().works, sort: 'oldest', seed: 'w' })
  writeLibraryState('localSearch', { ...defaultLibraryState().localSearch, sort: 'relevance', semantic: true, seed: 's' })
  writeLibraryState('cloudSearch', { sort: 'date_asc', target: 'exact_match_for_tags', entity: 'works' })
  assert.equal(readLibraryState('works').sort, 'oldest')
  assert.equal(readLibraryState('localSearch').sort, 'relevance')
  assert.equal(readLibraryState('localSearch').semantic, true)
  assert.equal(readLibraryState('cloudSearch').sort, 'date_asc')
  assert.equal(readLibraryState('cloudSearch').target, 'exact_match_for_tags')
  writeLibraryState('localSearch', { ...readLibraryState('localSearch'), sort: 'title' })
  assert.equal(readLibraryState('works').sort, 'oldest', '搜索排序不能覆盖媒体库排序')
  await flushLibraryState()
  assert.ok(puts('works').length >= 1)
  assert.ok(puts('localSearch').length >= 1)
  assert.ok(puts('cloudSearch').length >= 1)
})

test('启动时从服务端读回筛选记忆', async () => {
  reset()
  mock.get = fullState({
    works: { ...defaultLibraryState().works, source: 'server-side', sort: 'oldest' },
    localSearch: { ...defaultLibraryState().localSearch, semantic: true, sort: 'relevance' },
    cloudSearch: { sort: 'date_asc', target: 'exact_match_for_tags', entity: 'users' },
    recommendation: { source: 'cloud' },
  })
  await bootstrapLibraryState()
  assert.equal(readLibraryState('works').source, 'server-side')
  assert.equal(readLibraryState('works').sort, 'oldest')
  assert.equal(readLibraryState('localSearch').semantic, true)
  assert.equal(readLibraryState('cloudSearch').entity, 'users')
  assert.equal(readRecommendationSource(), 'cloud')
  assert.equal(puts().length, 0, '读取偏好不应回写服务端')
})

test('画面语义开关只属于本地搜索记忆，并随筛选写回服务端', async () => {
  reset()
  writeLibraryState('localSearch', { ...defaultLibraryState().localSearch, semantic: true })
  assert.equal(readLibraryState('localSearch').semantic, true)
  assert.equal('semantic' in readLibraryState('works'), false)
  await flushLibraryState()
  const saved = puts('localSearch')
  assert.equal(saved.length, 1)
  assert.equal(JSON.parse(saved[0]!.body!).semantic, true)
  assert.equal(puts('works').length, 0, '只改本地搜索开关不应写媒体库 scope')
})

test('云搜索旧状态补默认规则、entity 缺省回退 works', () => {
  reset()
  hydrateLibraryState({ cloudSearch: { sort: 'date_desc' } })
  assert.deepEqual(readLibraryState('cloudSearch'), { sort: 'date_desc', target: 'partial_match_for_tags', entity: 'works' })
  hydrateLibraryState({ cloudSearch: { sort: 'date_asc', target: 'invalid' } })
  assert.deepEqual(readLibraryState('cloudSearch'), { sort: 'date_asc', target: 'partial_match_for_tags', entity: 'works' })
  for (const target of ['partial_match_for_tags', 'exact_match_for_tags', 'title_and_caption', 'keyword'] as const) {
    writeLibraryState('cloudSearch', { sort: 'popular_preview', target, entity: 'works' })
    assert.equal(readLibraryState('cloudSearch').target, target)
  }
  hydrateLibraryState({ cloudSearch: { sort: 'popular_preview', target: 'partial_match_for_tags', entity: 'users' } })
  assert.equal(readLibraryState('cloudSearch').entity, 'users')
  hydrateLibraryState({ cloudSearch: { sort: 'popular_preview', target: 'partial_match_for_tags', entity: 'invalid' } })
  assert.equal(readLibraryState('cloudSearch').entity, 'works')
})

test('非法筛选值与损坏数据安全降级，绝不编造语义开关', () => {
  reset()
  hydrateLibraryState({
    works: { kind: 'video', fuzzy: 'yes', sort: 'bogus', order: 'bogus', source: 'pixiv:private' },
    localSearch: { semantic: 'true', sort: 'bogus' },
    cloudFavorites: { restrict: 'secret' },
    recommendation: { source: 'other' },
  })
  assert.deepEqual(readLibraryState('works'), { view: 'library', source: '', kind: 'video', fuzzy: false, sort: 'newest', order: 'collected', seed: '' })
  assert.equal(readLibraryState('localSearch').semantic, false)
  assert.equal(readLibraryState('cloudFavorites').restrict, 'public')
  assert.equal(readLibraryState('recommendation').source, 'local')
  hydrateLibraryState('broken')
  assert.deepEqual(readLibraryState('recommendation'), { source: 'local' })
})

test('服务端不可用时启动继续使用默认值，不抛出', async () => {
  reset()
  mock.get = 'fail'
  await bootstrapLibraryState()
  assert.equal(readLibraryState('localSearch').semantic, false)
  assert.equal(readLibraryState('works').sort, 'newest')
})

test('推荐来源按服务端记忆', async () => {
  reset()
  assert.equal(readRecommendationSource(), 'local')
  writeRecommendationSource('cloud')
  assert.equal(readRecommendationSource(), 'cloud')
  await flushLibraryState()
  assert.equal(JSON.parse(puts('recommendation')[0]!.body!).source, 'cloud')
})

test('旧云端收藏来源不再混入媒体库与本地搜索记忆', () => {
  reset()
  hydrateLibraryState({ works: { source: 'pixiv:private' }, localSearch: { source: 'pixiv:public' } })
  assert.equal(readLibraryState('works').source, '')
  assert.equal(readLibraryState('localSearch').source, '')
  writeLibraryState('cloudFavorites', { restrict: 'private' })
  assert.equal(readLibraryState('cloudFavorites').restrict, 'private')
})

test('值没变时不重复写服务端（键顺序不同也算相同）', async () => {
  reset()
  hydrateLibraryState(fullState())
  // 故意打乱字面量键顺序：比较应按字段而不是 JSON 字符串。
  writeLibraryState('works', { seed: '', source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', view: 'library' })
  writeLibraryState('localSearch', { semantic: false, seed: '', source: '', kind: '', fuzzy: false, sort: 'relevance', order: 'published' })
  await flushLibraryState()
  assert.equal(puts().length, 0)
})
