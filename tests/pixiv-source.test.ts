import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PixivRawIllust } from '../server/pixiv/types.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const DAY = 86_400_000
function illust(id: number, options: Partial<PixivRawIllust> = {}): PixivRawIllust {
  return {
    id, title: `Work ${id}`, type: 'illust', page_count: 1, create_date: '2025-02-03T04:05:06+09:00',
    image_urls: { large: `https://i.pximg.net/${id}_p0.jpg` },
    meta_single_page: { original_image_url: `https://i.pximg.net/${id}_p0.png` },
    ...options,
  }
}

test('云作品来源标注与列表排序（接口层）', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-source-'))
  const data = path.join(root, 'data')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'sources.json'), '[]')
  process.env.MEDIA_DATA_DIR = data
  const originalFetch = globalThis.fetch
  let bookmarked = false
  let bookmarkRestrict = 'public'
  let detailId = '103'
  let handler: typeof fetch = async () => json({})
  globalThis.fetch = ((input, init) => String(input).includes('oauth.secure.pixiv.net')
    ? Promise.resolve(json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: '42', name: 'tester' } }))
    : handler(input, init)) as typeof fetch
  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const auth = await import('../server/pixiv/auth.js')
  const store = await import('../server/pixiv/store.js')
  const { normalizePixivIllust } = await import('../server/pixiv/catalog.js')
  const app = await createApp(false)
  try {
    await auth.savePixivSettings({ refreshToken: 'test-refresh', localMode: false })
    handler = async input => {
      const url = new URL(String(input))
      if (url.pathname.includes('/bookmark/detail')) return json({ bookmark_detail: { is_bookmarked: bookmarked, restrict: bookmarkRestrict } })
      if (url.pathname.includes('/illust/detail')) return json({ illust: illust(Number(detailId), { is_bookmarked: bookmarked }) })
      if (url.pathname.includes('/illust/related')) return json({ illusts: [illust(102)], next_url: null })
      if (url.pathname.includes('/search/')) return json({ illusts: [illust(101)], next_url: null })
      return json({})
    }

    await t.test('搜索、推荐、详情各自标注来源；收藏夹作品保留收藏夹来源名', async () => {
      const search = await app.inject('/api/pixiv/search?q=source-label')
      assert.equal(search.statusCode, 200, search.body)
      assert.equal(search.json().items[0].sourceName, 'Pixiv 云搜索')
      assert.equal(search.json().items[0].sourceId, 'pixiv:search')

      const related = await app.inject('/api/pixiv/works/102/related')
      assert.equal(related.statusCode, 200, related.body)
      assert.equal(related.json().items[0].sourceName, 'Pixiv 云推荐', '推荐不是搜索')
      assert.equal(related.json().items[0].sourceId, 'pixiv:related')

      // 不在收藏夹里的作品：详情用中性的云来源，绝不能自称「公开收藏」。
      const detail = await app.inject('/api/pixiv/works/103')
      assert.equal(detail.statusCode, 200, detail.body)
      assert.equal(detail.json().sourceName, 'Pixiv 云作品')
      assert.equal(detail.json().sourceId, 'pixiv:cloud')
      // 知道入口的调用方可以显式指定，服务端默认仍是中性来源。
      const hinted = await app.inject('/api/pixiv/works/103?from=search')
      assert.equal(hinted.json().sourceName, 'Pixiv 云搜索')
      assert.equal((await app.inject('/api/pixiv/works/103?from=bogus')).json().sourceName, 'Pixiv 云作品')

      // 真正在收藏夹里的作品：无论入口提示是什么都保留收藏夹来源名。
      bookmarked = true
      bookmarkRestrict = 'private'
      const record = normalizePixivIllust(illust(103, { is_bookmarked: true }), 'private')
      store.savePixivBookmarks('42', 'private', [{ work: record.work, sequence: 1, meta: record.meta }])
      const favorite = await app.inject('/api/pixiv/works/103?from=search')
      assert.equal(favorite.statusCode, 200, favorite.body)
      assert.equal(favorite.json().sourceName, 'Pixiv 私密收藏')
      assert.equal(favorite.json().sourceId, 'pixiv:private')
    })

    await t.test('不可用作品与没有收藏序号的作品都不会领跑', async () => {
      // 收藏夹：两个可用作品 + 一个已删除作品（伪造成「比谁都新」的日期，序号也最大）。
      const liveA = normalizePixivIllust(illust(302, { create_date: '2025-03-01T00:00:00+09:00' }), 'public')
      const liveB = normalizePixivIllust(illust(301, { create_date: '2025-01-01T00:00:00+09:00' }), 'public')
      const dead = normalizePixivIllust({ id: 303, type: 'illust', page_count: 1, image_urls: { large: 'https://i.pximg.net/common/images/limit_illust/303.jpg' } }, 'public')
      assert.equal(dead.work.unavailable, true)
      const deadWork = { ...dead.work, date: new Date(Date.now() + DAY).toISOString() }
      store.savePixivBookmarks('42', 'public', [
        { work: liveA.work, sequence: 100, meta: liveA.meta },
        { work: liveB.work, sequence: 200, meta: liveB.meta },
        { work: deadWork, sequence: 999, meta: dead.meta },
      ])
      const ids = (response: { items: Array<{ externalId: string }> }) => response.items.map(item => item.externalId)
      const published = await app.inject('/api/works?source=pixiv:public&sort=newest&by=published')
      assert.equal(published.statusCode, 200, published.body)
      assert.deepEqual(ids(published.json()), ['302', '301', '303'], '可用作品的发布日期顺序不变，死作品排最后')
      assert.deepEqual(ids((await app.inject('/api/works?source=pixiv:public&sort=oldest&by=published')).json()), ['301', '302', '303'])
      // 收藏时间排序同理：死作品序号最大也不能领跑。
      assert.deepEqual(ids((await app.inject('/api/works?source=pixiv:public&sort=newest&by=collected')).json()), ['301', '302', '303'])
      // 收藏夹来源名不受影响。
      assert.equal(published.json().items[0].sourceName, 'Pixiv 公开收藏')

      // 本地来源：真实收藏序号（亿级）与老库里 collected === updated 的兜底值混在一起。
      // 兜底值的 updated 特意取较早的 mtime：本地可用作品的发布日期顺序不应被这次修复改变。
      const insert = db.prepare('INSERT INTO works VALUES (?, ?, ?)')
      const legacyUpdated = Date.parse('2020-06-01T00:00:00.000Z')
      const localWork = (id: string, collected: number, updated: number) => ({
        id, sourceId: 'fixture', sourceName: '本地', sourceKind: 'custom', externalId: id,
        title: id, author: '', description: '', tags: [], date: new Date(updated).toISOString(),
        collected, updated, count: 1, kind: 'image', favorite: false, cover: '',
        coverId: `cover-${id}`, originalUrl: '',
      })
      insert.run('seq-300', 'fixture', JSON.stringify(localWork('seq-300', 30_000_000_000, Date.parse('2025-01-03T00:00:00.000Z'))))
      insert.run('seq-200', 'fixture', JSON.stringify(localWork('seq-200', 20_000_000_000, Date.parse('2025-01-02T00:00:00.000Z'))))
      insert.run('seq-100', 'fixture', JSON.stringify(localWork('seq-100', 10_000_000_000, Date.parse('2025-01-01T00:00:00.000Z'))))
      insert.run('no-seq', 'fixture', JSON.stringify(localWork('no-seq', legacyUpdated, legacyUpdated)))
      assert.deepEqual(ids((await app.inject('/api/works?source=fixture&sort=newest&by=collected')).json()), ['seq-300', 'seq-200', 'seq-100', 'no-seq'])
      assert.deepEqual(ids((await app.inject('/api/works?source=fixture&sort=oldest&by=collected')).json()), ['seq-100', 'seq-200', 'seq-300', 'no-seq'])
      // 可用作品的发布日期顺序完全不变（老库兜底值不影响发布时间排序）。
      assert.deepEqual(ids((await app.inject('/api/works?source=fixture&sort=newest&by=published')).json()), ['seq-300', 'seq-200', 'seq-100', 'no-seq'])
      db.prepare('DELETE FROM works WHERE source_id = ?').run('fixture')
    })
  } finally {
    await app.close()
    db.close()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
