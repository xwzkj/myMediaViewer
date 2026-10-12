import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePixivIllust, localRelatedWorks, pixivBookmarkTags } from '../server/pixiv/catalog.js'
import type { Work } from '../shared/types.js'

function local(id: string, title: string, tags: string[], author = ''): Work {
  return {
    id, sourceId: 'local', sourceName: '本地', sourceKind: 'custom', externalId: id,
    title, author, description: title, tags, date: '2025-01-01T00:00:00.000Z', collected: 0,
    updated: Date.parse('2025-01-01T00:00:00.000Z'), count: 1, kind: 'image', favorite: false, cover: '',
  }
}

test('Pixiv 响应归一化保留多页、标签和 Ugoira 元数据', () => {
  const record = normalizePixivIllust({
    id: 123,
    title: '作品',
    caption: '简介',
    create_date: '2025-02-03T04:05:06+09:00',
    page_count: 2,
    type: 'illust',
    user: { id: 9, name: '画师' },
    tags: [{ name: '原标签' }, { translated_name: '译标签' }],
    image_urls: { large: 'https://i.pximg.net/large.jpg' },
    meta_pages: [
      { image_urls: { large: 'https://i.pximg.net/p0_large.jpg', original: 'https://i.pximg.net/p0.jpg' } },
      { image_urls: { large: 'https://i.pximg.net/p1_large.jpg', original: 'https://i.pximg.net/p1.png' } },
    ],
  }, 'private')
  assert.equal(record.work.id, 'pixiv:123')
  assert.equal(record.work.sourceId, 'pixiv:private')
  assert.deepEqual(record.work.tags, ['原标签', '译标签'])
  assert.deepEqual(record.meta.bookmarkTags, ['原标签', '译标签'])
  assert.equal(record.meta.pages.length, 2)
  assert.equal(record.work.cloudBookmark?.restrict, 'private')
})

test('收藏标签原文优先，译文补足名额，清理空白与重复但不拆分含空格的标签', () => {
  const record = normalizePixivIllust({ id: 123, tags: [
    { name: ' 原文 ', translated_name: 'translated tag' },
    { name: '原文', translated_name: '  ' },
    { name: '第二个', translated_name: '原文' },
    { translated_name: '只有译文' },
  ] })
  assert.deepEqual(record.meta.bookmarkTags, ['原文', '第二个', 'translated tag', '只有译文'])
  assert.deepEqual(pixivBookmarkTags(Array.from({ length: 18 }, (_, i) => String(i))), Array.from({ length: 10 }, (_, i) => String(i)))
})

test('本地推荐泛化到标签与文本，同作者不是唯一条件', () => {
  const seed = local('seed', '夏日山林', ['自然', '风景'])
  const similar = local('similar', '夏日森林风景', ['自然', '风景'])
  const authorOnly = local('author-only', '无关标题', [], '作者甲')
  const authored = local('authored', '夏日山林', ['自然', '风景'], '作者甲')
  const result = localRelatedWorks('seed', 10, 0, [seed, similar, authorOnly, authored])
  assert.equal(result[0].id, 'authored')
  assert.ok(result.findIndex(work => work.id === 'similar') < result.findIndex(work => work.id === 'author-only'))
})

test('云作品可作为本地推荐参照，排除同作品的所有本地副本并保留收藏状态', () => {
  const cloud = { ...local('pixiv:123', '夏日山林', ['自然', '风景']), sourceKind: 'pixiv' as const, externalId: '123', pixivId: '123', origin: 'pixiv' as const }
  const copy = { ...local('local-copy', '夏日山林', cloud.tags), sourceKind: 'pixiv' as const, externalId: '123' }
  const anotherCopy = { ...copy, id: 'another-copy' }
  const similar = { ...local('similar', '夏日森林风景', cloud.tags), favorite: true }
  const unrelated = local('unrelated', '城市夜景', ['城市'])
  const source = [copy, anotherCopy, unrelated, similar]
  assert.deepEqual(localRelatedWorks(cloud, 10, 0, source).map(work => work.id), ['similar', 'unrelated'])
  assert.equal(localRelatedWorks(cloud, 1, 0, source)[0].favorite, true)
  assert.deepEqual(localRelatedWorks(cloud, 1, 1, source).map(work => work.id), ['unrelated'])
  assert.deepEqual(localRelatedWorks('pixiv:123', 10, 0, source).map(work => work.id), ['similar', 'unrelated'])
  assert.deepEqual(localRelatedWorks('missing', 10, 0, source), [])
})
