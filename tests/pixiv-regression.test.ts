import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import type { PixivRawIllust } from '../server/pixiv/types.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function illust(id: number, count = 1): PixivRawIllust {
  return { id, title: `Work ${id}`, type: 'illust', page_count: count, tags: [{ name: '原文', translated_name: '译文' }], image_urls: { large: `https://i.pximg.net/${id}_p0.jpg` }, meta_single_page: count === 1 ? { original_image_url: `https://i.pximg.net/${id}_p0.png` } : undefined }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('Pixiv 云服务回归', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-regression-'))
  process.env.MEDIA_DATA_DIR = root
  const originalFetch = globalThis.fetch
  const auth = await import('../server/pixiv/auth.js')
  const store = await import('../server/pixiv/store.js')
  const client = await import('../server/pixiv/client.js')
  const service = await import('../server/pixiv/service.js')
  const catalog = await import('../server/pixiv/catalog.js')
  const mirror = await import('../server/pixiv/mirror.js')
  const cache = await import('../server/pixiv/cache.js')
  const { db } = await import('../server/database.js')
  const { registerPixivRoutes } = await import('../server/pixiv/routes.js')
  const app = Fastify()
  let uid = '42'
  let handler: typeof fetch = async () => json({})
  let oauthHandler: typeof fetch = async () => json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, user: { id: uid, name: 'test' } })
  globalThis.fetch = ((input, init) => String(input).includes('oauth.secure.pixiv.net') ? oauthHandler(input, init) : handler(input, init)) as typeof fetch
  await registerPixivRoutes(app)
  const login = () => auth.savePixivSettings({ refreshToken: 'test-refresh', localMode: false })
  try {
    await t.test('OAuth 与 App API 使用相同签名；兼容 response 包装', async () => {
      oauthHandler = async (_input, init) => {
        const headers = new Headers(init?.headers)
        const time = headers.get('x-client-time')!
        assert.equal(headers.get('x-client-hash'), createHash('md5').update(time + '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c').digest('hex'))
        assert.equal(headers.get('app-version'), '7.13.4')
        assert.ok(init?.signal)
        assert.equal(init?.redirect, 'error')
        const form = new URLSearchParams(String(init?.body))
        assert.equal(form.get('grant_type'), 'refresh_token')
        return json({ response: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, user: { id: uid, name: 'test' } } })
      }
      assert.equal((await login()).configured, true)
    })
    await t.test('过期 OAuth 错误并发只刷新一次，失败最多重放一次', async () => {
      let refreshes = 0
      let oldRequests = 0
      oauthHandler = async () => {
        refreshes++
        await new Promise(resolve => setTimeout(resolve, 400))
        return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, user: { id: uid } })
      }
      handler = async (_input, init) => {
        if (new Headers(init?.headers).get('authorization') === 'Bearer access') { oldRequests++; return json({ error: { message: 'Error occurred at the OAuth process.' } }, 400) }
        return json({ ok: true })
      }
      await Promise.all([client.pixivFetch('/v1/one'), client.pixivFetch('/v1/two')])
      assert.equal(oldRequests, 2)
      assert.equal(refreshes, 1)
      handler = async () => json({ error: { message: 'Error occurred at the OAuth process.' } }, 400)
      await assert.rejects(client.pixivFetch('/v1/fail'), /OAuth/)
      assert.equal(refreshes, 2)
    })
    await t.test('搜索参数、跨接口游标和搜索封面缓存', async () => {
      let details = 0
      handler = async (input) => {
        const url = new URL(String(input))
        if (url.pathname.includes('/search/')) {
          assert.equal(url.searchParams.get('search_target'), 'partial_match_for_tags')
          assert.equal(url.searchParams.get('sort'), 'popular_desc')
          assert.equal(url.searchParams.get('filter'), 'for_ios')
          return json({ illusts: [illust(123)], next_url: null })
        }
        if (url.pathname.includes('/detail')) { details++; return json({ illust: illust(123) }) }
        return new Response('image-bytes', { headers: { 'Content-Type': 'image/jpeg' } })
      }
      const result = await app.inject('/api/pixiv/search?q=test')
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(result.json().items[0].id, 'pixiv:123')
      const cover = await app.inject('/api/pixiv/assets/123/0/preview')
      assert.equal(cover.statusCode, 200, cover.body)
      assert.equal(details, 0)
      const cursor = Buffer.from('https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=42&restrict=private').toString('base64url')
      assert.equal((await app.inject(`/api/pixiv/search?q=test&cursor=${cursor}`)).statusCode, 400)
      assert.equal((await app.inject('/api/pixiv/works/not-an-id')).statusCode, 400)
      assert.equal((await app.inject('/api/pixiv/assets/123/-1/preview')).statusCode, 400)
    })
    await t.test('云搜索建议透传末尾词、去重及缓存，本地模式拒绝访问', async () => {
      let calls = 0
      handler = async input => {
        calls++
        const url = new URL(String(input))
        assert.equal(url.pathname, '/v2/search/autocomplete')
        assert.equal(url.searchParams.get('word'), '初音ミ')
        return json({ tags: [{ name: '初音ミク', translated_name: '初音未来' }, { name: '初音ミク' }, { name: '' }, { name: '初音ミク100users入り' }] })
      }
      const query = '/api/pixiv/suggestions?q=' + encodeURIComponent('初音ミ')
      const response = await app.inject(query)
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(response.json().items, [{ name: '初音ミク', translatedName: '初音未来' }, { name: '初音ミク100users入り', translatedName: '' }])
      assert.deepEqual((await app.inject(query)).json(), response.json())
      assert.deepEqual((await app.inject('/api/pixiv/suggestions?q=%20')).json(), { items: [] })
      assert.equal(calls, 1)
      await auth.savePixivSettings({ localMode: true })
      assert.equal((await app.inject(query)).statusCode, 403)
      assert.equal(calls, 1, '本地模式不能读取已缓存的建议')
      await auth.savePixivSettings({ localMode: false })
      handler = async () => json({ unexpected: [] })
      assert.equal((await app.inject('/api/pixiv/suggestions?q=invalid-response')).statusCode, 502)
    })
    await t.test('清理缓存必须显式指定天数或全部', async () => {
      assert.equal((await app.inject({ method: 'POST', url: '/api/pixiv/cache/clear', payload: {} })).statusCode, 400)
      assert.equal((await app.inject({ method: 'POST', url: '/api/pixiv/cache/clear', payload: { olderThanDays: 'bad' } })).statusCode, 400)
      const all = await app.inject({ method: 'POST', url: '/api/pixiv/cache/clear', payload: { all: true } })
      assert.equal(all.statusCode, 200, all.body)
      assert.equal(typeof all.json().removed, 'number')
    })
    await t.test('多页列表缓存会补齐详情，并发请求合并且列表不会覆盖完整页面', async () => {
      store.savePixivWorkRecords(uid, [catalog.normalizePixivIllust(illust(456, 3), 'private')])
      let calls = 0
      handler = async () => {
        calls++
        return json({ illust: { ...illust(456, 3), meta_pages: [0, 1, 2].map(page => ({ image_urls: { large: `https://i.pximg.net/456_p${page}.jpg`, original: `https://i.pximg.net/456_p${page}.png` } })) } })
      }
      const [first, second] = await Promise.all([service.fetchIllustRecord('456'), service.fetchIllustRecord('456')])
      assert.equal(calls, 1)
      assert.equal(first.meta.pages.length, 3)
      assert.equal(second.meta.pages.length, 3)
      store.savePixivWorkRecords(uid, [catalog.normalizePixivIllust(illust(456, 3))])
      assert.equal(store.getPixivWorkRecord(uid, '456')?.meta.pages.length, 3)
      assert.equal((await service.fetchIllustRecord('456')).meta.pages.length, 3)
      assert.equal(calls, 1)
    })
    await t.test('四种搜索匹配规则透传，两种搜索接口分页与缓存按规则隔离', async () => {
      const targets = ['partial_match_for_tags', 'exact_match_for_tags', 'title_and_caption', 'keyword']
      let calls = 0
      handler = async input => {
        calls++
        const url = new URL(String(input))
        const target = url.searchParams.get('search_target')!
        assert.ok(targets.includes(target))
        const next = new URL(url)
        next.searchParams.set('offset', '30')
        return json({ illusts: [illust(910 + targets.indexOf(target))], next_url: url.searchParams.has('offset') ? null : next.href })
      }
      for (const sort of ['popular_preview', 'date_desc']) {
        for (const [index, target] of targets.entries()) {
          const query = new URLSearchParams({ q: '规则测试', sort, target })
          const first = await app.inject(`/api/pixiv/search?${query}`)
          assert.equal(first.statusCode, 200, first.body)
          assert.equal(first.json().items[0].pixivId, String(910 + index))
          const cursor = first.json().nextCursor
          const secondQuery = new URLSearchParams(query)
          secondQuery.set('cursor', cursor)
          const second = await app.inject(`/api/pixiv/search?${secondQuery}`)
          assert.equal(second.statusCode, 200, second.body)
          assert.equal(second.json().nextCursor, null)
          const mismatched = new URLSearchParams(secondQuery)
          mismatched.set('target', targets[(index + 1) % targets.length])
          assert.equal((await app.inject(`/api/pixiv/search?${mismatched}`)).statusCode, 400)
          assert.equal((await app.inject(`/api/pixiv/search?${query}`)).json().items[0].pixivId, String(910 + index))
        }
      }
      assert.equal(calls, 16, '不同规则分别缓存，缓存命中与错用游标不访问上游')
      assert.equal((await app.inject('/api/pixiv/search?q=test&target=invalid')).statusCode, 400)
      assert.equal(calls, 16)
    })
    await t.test('云详情的每页可读取，本地推荐接受云参照且分页和收藏状态正确', async () => {
      let detailCalls = 0
      handler = async input => {
        const url = String(input)
        if (url.includes('/illust/detail')) { detailCalls++; return json({ illust: illust(456, 3) }) }
        if (url.includes('/bookmark/detail')) return json({ bookmark_detail: { is_bookmarked: false } })
        return new Response('image-bytes', { headers: { 'Content-Type': 'image/jpeg' } })
      }
      const detail = await app.inject('/api/pixiv/works/456')
      assert.equal(detail.statusCode, 200, detail.body)
      assert.equal(detail.json().assets.length, 3)
      for (const asset of detail.json().assets) assert.equal((await app.inject(asset.url)).statusCode, 200)
      const seed = store.getPixivWorkRecord(uid, '456')!.work
      const insert = db.prepare('INSERT INTO works VALUES (?, ?, ?)')
      for (let index = 0; index < 28; index++) {
        const work = {
          ...seed, id: `local-${index}`, sourceId: 'fixture', origin: undefined, hasLocal: undefined, pixivId: undefined,
          externalId: index < 2 ? '456' : String(1000 + index),
          coverId: `cover-${index}`, originalUrl: '',
        }
        insert.run(work.id, work.sourceId, JSON.stringify(work))
      }
      db.prepare('INSERT INTO favorites VALUES (?, ?)').run('local-2', Date.now())
      try {
        const first = await app.inject('/api/works/pixiv%3A456/related?page=1')
        const second = await app.inject('/api/works/pixiv%3A456/related?page=2')
        assert.equal(first.statusCode, 200, first.body)
        assert.equal(second.statusCode, 200, second.body)
        assert.equal(first.json().total, 26)
        assert.equal(first.json().pages, 2)
        assert.equal(first.json().items.length, 24)
        assert.equal(second.json().items.length, 2)
        const items = [...first.json().items, ...second.json().items]
        assert.equal(new Set(items.map(item => item.id)).size, 26)
        assert.equal(items.some(item => item.externalId === '456'), false)
        assert.equal(items.every(item => item.hasLocal && item.origin === 'local' && item.pixivId), true)
        assert.equal(items.find(item => item.id === 'local-2').favorite, true)
        assert.equal(detailCalls, 0, '详情和本地推荐复用当前账号缓存')
        assert.equal((await app.inject('/api/works/missing/related')).json().total, 0)
        const local = await app.inject('/api/works/local-2/related')
        assert.equal(local.json().total, 27)
        assert.equal(local.json().items.some((item: { id: string }) => item.id === 'local-2'), false)
        assert.equal((await app.inject('/api/works/pixiv%3A456/related?page=3')).json().items.length, 0)
        await auth.savePixivSettings({ localMode: true })
        assert.equal((await app.inject('/api/works/pixiv%3A456/related')).statusCode, 403)
        assert.equal((await app.inject('/api/works/local-2/related')).statusCode, 200)
      } finally {
        db.prepare('DELETE FROM works WHERE source_id = ?').run('fixture')
        db.prepare('DELETE FROM favorites WHERE work_id = ?').run('local-2')
        await auth.savePixivSettings({ localMode: false })
      }
    })
    await t.test('收藏可见性切换移除旧书架；未开启标签时不误报标签失败', async () => {
      const record = catalog.normalizePixivIllust(illust(789))
      store.savePixivWorkRecords(uid, [record])
      store.updatePixivBookmark(uid, '789', 'public', true, record.work)
      store.updatePixivBookmark(uid, '789', 'private', true, record.work)
      assert.equal(store.getPixivBookmarkRecords(uid, 'public').some(item => item.work.externalId === '789'), false)
      assert.equal(store.getPixivBookmarkRestrict(uid, '789'), 'private')
      await auth.savePixivSettings({ autoBookmarkTags: false })
      handler = async (input) => String(input).includes('/illust/detail') ? json({ illust: illust(789) }) : json({})
      const result = await app.inject({ method: 'PUT', url: '/api/pixiv/works/789/bookmark', payload: { bookmarked: true } })
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(result.json().warning, undefined)
      assert.equal((await app.inject({ method: 'PUT', url: '/api/pixiv/works/789/bookmark', payload: {} })).statusCode, 400)
    })
    await t.test('网络错误不会误触发无标签收藏降级', async () => {
      await auth.savePixivSettings({ autoBookmarkTags: true })
      let writes = 0
      handler = async () => { writes++; throw new TypeError('network down') }
      const result = await app.inject({ method: 'PUT', url: '/api/pixiv/works/789/bookmark', payload: { bookmarked: true } })
      assert.equal(result.statusCode, 502, result.body)
      assert.equal(writes, 1)
    })
    await t.test('收藏参数错误最多降级一次；无标签请求及失败响应不误写镜像', async () => {
      store.savePixivWorkRecords(uid, [catalog.normalizePixivIllust(illust(790))])
      let writes = 0
      handler = async input => {
        if (String(input).includes('/illust/detail')) return json({ illust: illust(790) })
        writes++
        return json({ error: { user_message: '不正确的请求。', message: 'invalid request' } }, 400)
      }
      await auth.savePixivSettings({ autoBookmarkTags: false })
      const plain = await app.inject({ method: 'PUT', url: '/api/pixiv/works/790/bookmark', payload: { bookmarked: true } })
      assert.equal(plain.statusCode, 400)
      assert.equal(writes, 1, '没有附加标签时不重试')
      await auth.savePixivSettings({ autoBookmarkTags: true })
      const tagged = await app.inject({ method: 'PUT', url: '/api/pixiv/works/790/bookmark', payload: { bookmarked: true } })
      assert.equal(tagged.statusCode, 400)
      assert.equal(writes, 3, '带标签请求仅重试一次无标签表单')
      assert.equal(store.getPixivBookmarkRestrict(uid, '790'), null)
    })
    await t.test('限流与临时 HTML 网关故障有界重试；无效成功响应不会吞错', async () => {
      let calls = 0
      handler = async () => {
        calls++
        if (calls === 1) return json({ error: { message: 'rate limit' } }, 429)
        if (calls === 2) return new Response('<html>unavailable</html>', { status: 503 })
        return json({ ok: true })
      }
      assert.deepEqual(await client.pixivFetch('/v1/retry'), { ok: true })
      assert.equal(calls, 3)
      calls = 0
      handler = async () => { calls++; return new Response('<html>unexpected</html>') }
      await assert.rejects(client.pixivFetch('/v1/bad-response'), /JSON/)
      assert.equal(calls, 1)
    })
    await t.test('403 不刷新 token，不重复无标签收藏；401 只刷新一次', async () => {
      let refreshes = 0
      const previousOAuth = oauthHandler
      oauthHandler = async (input, init) => { refreshes++; return previousOAuth(input, init) }
      let writes = 0
      handler = async () => { writes++; return json({ error: { message: 'forbidden' } }, 403) }
      const response = await app.inject({ method: 'PUT', url: '/api/pixiv/works/789/bookmark', payload: { bookmarked: true } })
      assert.equal(response.statusCode, 403)
      assert.equal(writes, 1)
      assert.equal(refreshes, 0)
      handler = async () => json({ error: { message: 'unauthorized' } }, 401)
      await assert.rejects(client.pixivFetch('/v1/unauthorized'), /登录已失效/)
      assert.equal(refreshes, 1)
      oauthHandler = previousOAuth
    })
    await t.test('不可见作品与缺失多页返回明确错误', async () => {
      handler = async () => json({ illust: { ...illust(880), visible: false } })
      await assert.rejects(service.fetchIllustRecord('880'), /不可见/)
      handler = async () => json({ illust: illust(881, 3) })
      await assert.rejects(service.fetchIllustRecord('881'), /多页作品详情不完整/)
      assert.equal(store.getPixivWorkRecord(uid, '881'), undefined)
    })
    await t.test('收藏同步按上游顺序入库，不预取 Ugoira 元数据', async () => {
      const urls: string[] = []
      handler = async input => {
        urls.push(String(input))
        return json({ illusts: [{ ...illust(901), type: 'ugoira' }, illust(902)], next_url: null })
      }
      mirror.startPixivMirror('public')
      mirror.startPixivMirror('public')
      await waitFor(() => store.getPixivMirrorState(uid, 'public').phase === 'ready')
      assert.equal(urls.length, 1)
      assert.match(urls[0], /filter=for_ios/)
      assert.deepEqual(store.getPixivBookmarkRecords(uid, 'public').map(item => item.work.externalId), ['901', '902'])
    })
    await t.test('force 刷新已就绪镜像会重新从第一页同步', async () => {
      const urls: string[] = []
      handler = async input => {
        urls.push(String(input))
        return json({ illusts: [illust(903)], next_url: null })
      }
      mirror.startPixivMirror('public', { mode: 'full', manual: true })
      await waitFor(() => store.getPixivMirrorState(uid, 'public').phase === 'ready' && store.getPixivBookmarkRecords(uid, 'public')[0]?.work.externalId === '903')
      assert.equal(urls.length, 1)
      assert.deepEqual(store.getPixivBookmarkRecords(uid, 'public').map(item => item.work.externalId), ['903'])
    })
    await t.test('增量更新只追加新收藏，不清理旧收藏', async () => {
      const old = catalog.normalizePixivIllust(illust(905), 'public')
      store.savePixivBookmarks(uid, 'public', [{ work: old.work, sequence: Date.now() - 10_000 }], Date.now() - 10_000)
      const urls: string[] = []
      handler = async input => {
        urls.push(String(input))
        return json({ illusts: [illust(904), illust(903)], next_url: null })
      }
      mirror.startPixivMirror('public', { mode: 'incremental', manual: true })
      await waitFor(() => store.getPixivMirrorState(uid, 'public').phase === 'ready' && store.getPixivBookmarkRecords(uid, 'public').some(item => item.work.externalId === '904'))
      assert.equal(urls.length, 1)
      assert.deepEqual(store.getPixivBookmarkRecords(uid, 'public').map(item => item.work.externalId), ['904', '903', '905'])
    })
    await t.test('从持久分页恢复时保留已同步页面，完成后清理漏失收藏', async () => {
      const generation = Date.now() - 1000
      const retained = catalog.normalizePixivIllust(illust(910), 'private')
      const missing = catalog.normalizePixivIllust(illust(911), 'private')
      store.savePixivBookmarks(uid, 'private', [{ work: retained.work, sequence: generation }], generation + 1)
      store.savePixivBookmarks(uid, 'private', [{ work: missing.work, sequence: generation - 1 }], generation - 1)
      const nextUrl = 'https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=42&restrict=private&filter=for_ios&max_bookmark_id=50'
      store.savePixivMirrorState(uid, { ...store.getPixivMirrorState(uid, 'private'), started: true, phase: 'error', generation, nextUrl, pages: 1, items: 1 })
      handler = async input => { assert.equal(String(input), nextUrl); return json({ illusts: [illust(912)], next_url: null }) }
      mirror.startPixivMirror('private')
      await waitFor(() => store.getPixivMirrorState(uid, 'private').phase === 'ready')
      const ids = store.getPixivBookmarkRecords(uid, 'private').map(item => item.work.externalId)
      assert.deepEqual(ids, ['910', '912'])
    })
    await t.test('错误列表不被当成空收藏夹，也不会删除原镜像', async () => {
      store.savePixivMirrorState(uid, { ...store.getPixivMirrorState(uid, 'private'), phase: 'error', nextUrl: null })
      handler = async () => json({})
      mirror.startPixivMirror('private')
      await waitFor(() => store.getPixivMirrorState(uid, 'private').phase === 'error')
      assert.equal(store.getPixivBookmarkRecords(uid, 'private').length, 2)
    })
    await t.test('切换账号期间旧同步响应不污染或重建旧账号数据', async () => {
      let release!: () => void
      let entered = false
      handler = async () => { entered = true; await new Promise<void>(resolve => { release = resolve }); return json({ illusts: [illust(999)], next_url: null }) }
      mirror.startPixivMirror('private')
      await waitFor(() => entered)
      uid = '43'
      oauthHandler = async () => json({ access_token: 'other-access', refresh_token: 'other-refresh', expires_in: 3600, user: { id: uid } })
      await login()
      release()
      await mirror.stopPixivMirrors()
      assert.equal(store.getPixivWorkRecords('42').length, 0)
      assert.equal(store.getPixivMirrorState('42', 'private').started, false)
      assert.equal(store.getPixivWorkRecords('43').length, 0)
    })
    await t.test('退出时正在刷新的 token 不会恢复登录', async () => {
      let release!: () => void
      let entered = false
      oauthHandler = async () => { entered = true; await new Promise<void>(resolve => { release = resolve }); return json({ access_token: 'late', refresh_token: 'late', expires_in: 3600, user: { id: uid } }) }
      const pending = auth.forceRefreshPixivAccessToken()
      const rejection = assert.rejects(pending, /配置|改变|本地模式/)
      await waitFor(() => entered)
      auth.clearPixivAccount()
      release()
      await rejection
      assert.equal(auth.getPixivSettings().configured, false)
      assert.equal(JSON.parse(await readFile(path.join(root, 'pixiv.json'), 'utf8')).accessToken, '')
    })
    await t.test('媒体 HTML 错误和超限响应不入缓存且不重试', async () => {
      let calls = 0
      handler = async () => { calls++; return new Response('<html>blocked</html>', { headers: { 'Content-Type': 'text/html' } }) }
      await assert.rejects(cache.getOrCachePixivResource('html-test', 'https://i.pximg.net/test.jpg'), /不是媒体/)
      assert.equal(calls, 1)
      assert.equal(cache.findCachedPixivResource('html-test'), null)
      handler = async () => new Response('big', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '100' } })
      await assert.rejects(cache.getOrCachePixivResource('big-test', 'https://i.pximg.net/test.jpg', undefined, 2), /超过/)
      assert.equal(cache.findCachedPixivResource('big-test'), null)
    })
    await t.test('媒体并发限制覆盖整个响应流，并合并重复下载', async () => {
      const streams: ReadableStreamDefaultController<Uint8Array>[] = []
      handler = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller) } }), { headers: { 'Content-Type': 'image/jpeg' } })
      const tasks = Array.from({ length: 6 }, (_, index) => cache.getOrCachePixivResource(`stream-${index}`, 'https://i.pximg.net/test.jpg'))
      const duplicate = cache.getOrCachePixivResource('stream-0', 'https://i.pximg.net/test.jpg')
      assert.equal(duplicate, tasks[0])
      await waitFor(() => streams.length === 4)
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(streams.length, 4)
      for (const stream of streams.slice()) { stream.enqueue(new Uint8Array([1])); stream.close() }
      await waitFor(() => streams.length === 6)
      for (const stream of streams.slice(4)) { stream.enqueue(new Uint8Array([1])); stream.close() }
      await Promise.all(tasks)
      const files = await readdir(path.join(root, 'cache', 'pixiv'), { recursive: true })
      assert.equal(files.some(file => file.endsWith('.part')), false)
    })
    await t.test('本地模式仍能清理 Pixiv 缓存', async () => {
      await auth.savePixivSettings({ localMode: true })
      const response = await app.inject({ method: 'POST', url: '/api/pixiv/cache/clear', payload: { all: true } })
      assert.equal(response.statusCode, 200, response.body)
      assert.ok(response.json().removed > 0)
    })
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
