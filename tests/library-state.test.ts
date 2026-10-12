import test from 'node:test'
import assert from 'node:assert/strict'
import { readLibraryState, writeLibraryState, migrateLegacyLibraryState, readRecommendationSource, writeRecommendationSource } from '../src/library-state.js'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
  clear() { this.data.clear() }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  get length() { return this.data.size }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

test('媒体库、本地搜索、云搜索状态完全隔离', () => {
  storage.clear()
  writeLibraryState('works', { view: 'library', source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', seed: 'w' })
  writeLibraryState('localSearch', { source: '', kind: '', fuzzy: false, sort: 'relevance', order: 'published', seed: 's' })
  writeLibraryState('cloudSearch', { sort: 'date_asc', target: 'exact_match_for_tags' })
  assert.equal(readLibraryState('works').sort, 'newest')
  assert.equal(readLibraryState('localSearch').sort, 'relevance')
  assert.equal(readLibraryState('cloudSearch').sort, 'date_asc')
  assert.equal(readLibraryState('cloudSearch').target, 'exact_match_for_tags')
  writeLibraryState('localSearch', { ...readLibraryState('localSearch'), sort: 'oldest' })
  assert.equal(readLibraryState('works').sort, 'newest', '搜索排序不能覆盖媒体库排序')
})

test('云搜索旧状态补默认规则，无效规则安全回退', () => {
  storage.clear()
  storage.setItem('library.cloudSearch.v2', JSON.stringify({ sort: 'date_desc' }))
  assert.deepEqual(readLibraryState('cloudSearch'), { sort: 'date_desc', target: 'partial_match_for_tags' })
  storage.setItem('library.cloudSearch.v2', JSON.stringify({ sort: 'date_asc', target: 'invalid' }))
  assert.deepEqual(readLibraryState('cloudSearch'), { sort: 'date_asc', target: 'partial_match_for_tags' })
  for (const target of ['partial_match_for_tags', 'exact_match_for_tags', 'title_and_caption', 'keyword'] as const) {
    writeLibraryState('cloudSearch', { sort: 'popular_preview', target })
    assert.equal(readLibraryState('cloudSearch').target, target)
  }
})

test('损坏 JSON 与旧状态迁移安全降级', () => {
  storage.clear()
  storage.setItem('library.works.v2', '{broken')
  assert.deepEqual(readLibraryState('works'), { view: 'library', source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', seed: '' })
  storage.setItem('libraryState', JSON.stringify({ source: 'source-a', sort: 'oldest', order: 'published' }))
  migrateLegacyLibraryState()
  assert.equal(readLibraryState('works').sort, 'oldest')
  assert.equal(readLibraryState('works').order, 'published')
  assert.equal(readLibraryState('localSearch').sort, 'relevance')
})

test('推荐来源按浏览器记忆', () => {
  storage.clear()
  assert.equal(readRecommendationSource(), 'local')
  writeRecommendationSource('cloud')
  assert.equal(readRecommendationSource(), 'cloud')
})

test('旧云端收藏来源不再混入媒体库与本地搜索记忆', () => {
  storage.clear()
  storage.setItem('library.works.v2', JSON.stringify({ source: 'pixiv:private' }))
  storage.setItem('library.localSearch.v2', JSON.stringify({ source: 'pixiv:public' }))
  assert.equal(readLibraryState('works').source, '')
  assert.equal(readLibraryState('localSearch').source, '')
  writeLibraryState('cloudFavorites', { restrict: 'private' })
  assert.equal(readLibraryState('cloudFavorites').restrict, 'private')
})
