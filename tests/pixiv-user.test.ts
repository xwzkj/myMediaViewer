import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import type { PixivRawIllust } from '../server/pixiv/types.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function illust(id: number, userId = 7, count = 1): PixivRawIllust {
  return {
    id, title: `Work ${id}`, type: 'illust', page_count: count,
    user: { id: userId, name: `画师${userId}`, account: `artist${userId}` },
    tags: [{ name: '原文', translated_name: '译文' }],
    image_urls: { large: `https://i.pximg.net/${id}_p0.jpg` },
    meta_single_page: count === 1 ? { original_image_url: `https://i.pximg.net/${id}_p0.png` } : undefined,
  }
}
function userDetail(userId: number) {
  return {
    user: { id: userId, name: `画师${userId}`, account: `artist${userId}`, comment: '简介', is_followed: true, profile_image_urls: { medium: `https://s.pximg.net/avatar_${userId}.png` } },
    profile: { webpage: 'https://example.com/', twitter_account: 'artist7', total_illusts: 12, total_manga: 3, total_follow_users: 99, background_image_url: `https://s.pximg.net/bg_${userId}.png`, region: '日本', job: '插画师', gender: 'male' },
    workspace: { pc: 'Windows', tool: 'CLIP' },
  }
}

test('Pixiv 创作者主页与作者搜索', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-user-'))
  process.env.MEDIA_DATA_DIR = root
  const originalFetch = globalThis.fetch
  const auth = await import('../server/pixiv/auth.js')
  const store = await import('../server/pixiv/store.js')
  const client = await import('../server/pixiv/client.js')
  const catalog = await import('../server/pixiv/catalog.js')
  const service = await import('../server/pixiv/service.js')
  const user = await import('../server/pixiv/user.js')
  const { db } = await import('../server/database.js')
  void client
  void catalog
  const { registerPixivRoutes } = await import('../server/pixiv/routes.js')
  const app = Fastify()
  const uid = '42'
  let upstream = 0
  let details = 0
  let handler: typeof fetch = async () => json({})
  let loginUid = uid
  const oauthHandler: typeof fetch = async () => json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, user: { id: loginUid, name: 'test' } })
  globalThis.fetch = ((input, init) => String(input).includes('oauth.secure.pixiv.net') ? oauthHandler(input, init) : (upstream++, handler(input, init))) as typeof fetch
  await registerPixivRoutes(app)
  await auth.savePixivSettings({ refreshToken: 'test-refresh', localMode: false })
  try {
    await t.test('作者搜索归一化、去重、空查询与分页游标', async () => {
      handler = async input => {
        const url = new URL(String(input))
        assert.equal(url.pathname, '/v1/search/user')
        assert.equal(url.searchParams.get('filter'), 'for_ios')
        assert.equal(url.searchParams.get('word'), '画师')
        if (url.searchParams.has('offset')) return json({ user_previews: [{ user: { id: 9, name: '画师9' } }], next_url: null })
        const next = new URL(url)
        next.searchParams.set('offset', '30')
        return json({
          user_previews: [
            { user: { id: 7, name: '画师7', account: 'artist7', profile_image_urls: { medium: 'https://s.pximg.net/a7.png' }, is_followed: false } },
            { user: { id: 7, name: '画师7重复' } },
            { user: { id: 'bad', name: '非法' } },
            { user: { id: 8 } },
            { broken: true },
          ],
          next_url: next.href,
        })
      }
      const before = upstream
      const first = await app.inject('/api/pixiv/users/search?q=%E7%94%BB%E5%B8%88')
      assert.equal(first.statusCode, 200, first.body)
      assert.deepEqual(first.json().items.map((item: { id: string }) => item.id), ['7'])
      assert.equal(first.json().items[0].account, 'artist7')
      assert.ok(first.json().nextCursor)
      assert.equal(upstream, before + 1)
      // 缓存命中不再访问上游，且 summary 已落盘。
      const cached = (await app.inject('/api/pixiv/users/search?q=%E7%94%BB%E5%B8%88')).json()
      assert.deepEqual(cached.items, first.json().items)
      assert.equal(cached.nextCursor, first.json().nextCursor)
      assert.match(cached.items[0].avatarUrl, /^\/api\/pixiv\/users\/7\/avatar\?v=/)
      assert.equal(upstream, before + 1)
      assert.equal(store.getPixivApiCache(`user-summary:${uid}:7`)?.avatarUrl, 'https://s.pximg.net/a7.png')
      const second = await app.inject(`/api/pixiv/users/search?q=%E7%94%BB%E5%B8%88&cursor=${first.json().nextCursor}`)
      assert.equal(second.statusCode, 200, second.body)
      assert.deepEqual(second.json().items.map((item: { id: string }) => item.id), ['9'])
      assert.equal(second.json().nextCursor, null)
      // 跨查询游标拒绝。
      assert.equal((await app.inject(`/api/pixiv/users/search?q=%E5%85%B6%E4%BB%96&cursor=${first.json().nextCursor}`)).statusCode, 400)
      // 跨接口游标拒绝（作品搜索的 illust 路径）。
      const bad = Buffer.from('https://app-api.pixiv.net/v1/search/illust?word=x&filter=for_ios').toString('base64url')
      assert.equal((await app.inject(`/api/pixiv/users/search?q=%E7%94%BB%E5%B8%88&cursor=${bad}`)).statusCode, 400)
      // 空查询不上游。
      const emptyBefore = upstream
      assert.deepEqual((await app.inject('/api/pixiv/users/search?q=%20')).json(), { items: [], nextCursor: null, elapsed: 0 })
      assert.equal(upstream, emptyBefore)
      // 非法响应 502。
      handler = async () => json({ user_previews: 'bad' })
      assert.equal((await app.inject('/api/pixiv/users/search?q=invalid-response')).statusCode, 502)
    })

    await t.test('画师档案字段、ID 校验与 in-flight 合并', async () => {
      let calls = 0
      handler = async input => {
        calls++
        const url = new URL(String(input))
        assert.equal(url.pathname, '/v2/user/detail')
        assert.equal(url.searchParams.get('user_id'), '7')
        assert.equal(url.searchParams.get('filter'), 'for_ios')
        await new Promise(resolve => setTimeout(resolve, 50))
        return json(userDetail(7))
      }
      const [first, second] = await Promise.all([app.inject('/api/pixiv/users/7'), app.inject('/api/pixiv/users/7')])
      assert.equal(first.statusCode, 200, first.body)
      assert.equal(calls, 1)
      const profile = first.json()
      assert.equal(profile.id, '7')
      assert.equal(profile.name, '画师7')
      assert.equal(profile.account, 'artist7')
      assert.equal(profile.comment, '简介')
      assert.equal(profile.twitterUrl, 'https://twitter.com/artist7')
      assert.equal(profile.totalIllusts, 12)
      assert.equal(profile.location, '日本')
      assert.deepEqual(profile.workspace, [{ label: 'pc', value: 'Windows' }, { label: 'tool', value: 'CLIP' }])
      assert.deepEqual(second.json(), profile)
      // 档案缓存命中不再访问上游。
      assert.equal((await app.inject('/api/pixiv/users/7')).statusCode, 200)
      assert.equal(calls, 1)
      // 非法 ID 与返回错 ID。
      assert.equal((await app.inject('/api/pixiv/users/abc')).statusCode, 400)
      handler = async () => json(userDetail(8))
      assert.equal((await app.inject('/api/pixiv/users/99')).statusCode, 502)
    })

    await t.test('画师作品列表类型枚举、游标类型隔离与作品归一化', async () => {
      handler = async input => {
        const url = new URL(String(input))
        assert.equal(url.pathname, '/v1/user/illusts')
        assert.equal(url.searchParams.get('user_id'), '7')
        assert.equal(url.searchParams.get('filter'), 'for_ios')
        const type = url.searchParams.get('type')
        assert.ok(type === 'illust' || type === 'manga')
        if (url.searchParams.has('offset')) return json({ illusts: [], next_url: null })
        const next = new URL(url)
        next.searchParams.set('offset', '30')
        return json({ illusts: [illust(101, 7), illust(102, 7)], next_url: next.href })
      }
      const first = await app.inject('/api/pixiv/users/7/works')
      assert.equal(first.statusCode, 200, first.body)
      assert.equal(first.json().items[0].pixivUserId, '7')
      assert.equal(first.json().items[0].sourceId, 'pixiv:user:7')
      assert.ok(first.json().nextCursor)
      const manga = await app.inject('/api/pixiv/users/7/works?type=manga')
      assert.equal(manga.statusCode, 200, manga.body)
      assert.equal(manga.json().items[0].sourceName, 'Pixiv 画师 7 的漫画')
      assert.equal((await app.inject('/api/pixiv/users/7/works?type=all')).statusCode, 400)
      assert.equal((await app.inject('/api/pixiv/users/abc/works')).statusCode, 400)
      // manga 页游标拿到 illust 接口上用会被拒绝。
      assert.equal((await app.inject(`/api/pixiv/users/7/works?cursor=${manga.json().nextCursor}`)).statusCode, 400)
      assert.equal((await app.inject(`/api/pixiv/users/7/works?cursor=${first.json().nextCursor}`)).statusCode, 200)
      // illust 游标不能用于其他画师。
      assert.equal((await app.inject(`/api/pixiv/users/8/works?cursor=${first.json().nextCursor}`)).statusCode, 400)
      // 旧书签回写不丢画师 ID。
      store.savePixivBookmarks(uid, 'public', [{ work: first.json().items[0], sequence: 1 }])
      store.savePixivWorkRecords(uid, [{ work: { ...first.json().items[0], pixivUserId: undefined }, meta: { pages: [], kind: 'image' as const } }])
      assert.equal(store.getPixivWorkRecord(uid, '101')?.work.pixivUserId, '7')
    })

    await t.test('旧记录缺画师 ID 惰性回填一次，上游确实缺 user 不重复', async () => {
      store.savePixivWorkRecords(uid, [{ work: { ...catalog.normalizePixivIllust(illust(201, 7)).work, pixivUserId: undefined }, meta: { pages: [], kind: 'image' as const } }])
      handler = async input => {
        const url = new URL(String(input))
        if (url.pathname === '/v1/illust/detail') {
          details++
          return json({ illust: { ...illust(201, 7), meta_pages: [] } })
        }
        return json({ illusts: [], next_url: null })
      }
      assert.equal((await service.fetchIllustRecord('201')).work.pixivUserId, '7')
      assert.equal(details, 1)
      assert.equal((await service.fetchIllustRecord('201')).work.pixivUserId, '7')
      assert.equal(details, 1, '回填后命中缓存不再刷新')
      // 上游确实缺 user：标记后不再重复 detail。
      store.savePixivWorkRecords(uid, [{ work: { ...catalog.normalizePixivIllust(illust(202, 7)).work, pixivUserId: undefined }, meta: { pages: [], kind: 'image' as const } }])
      const noUser = illust(202, 7) as unknown as Record<string, unknown>
      delete (noUser as { user?: unknown }).user
      handler = async () => { details++; return json({ illust: { ...noUser, meta_pages: [] } }) }
      const before = details
      await service.fetchIllustRecord('202')
      await service.fetchIllustRecord('202')
      assert.equal(details, before + 1)
      assert.ok(store.getPixivWorkRecord(uid, '202')?.meta.userCheckedAt)
    })

    await t.test('头像路由只读服务端已知地址，缺失占位不调 detail', async () => {
      handler = async input => {
        const url = new URL(String(input))
        if (url.pathname === '/v2/user/detail') {
          details++
          return json(userDetail(11))
        }
        return new Response('avatar-bytes', { headers: { 'Content-Type': 'image/png' } })
      }
      // summary 有头像：直接代理，不调 detail。
      const before = details
      const direct = await app.inject('/api/pixiv/users/7/avatar')
      assert.equal(direct.statusCode, 200, direct.body)
      assert.equal(details, before)
      // 未知 summary/profile 直接 404，搜索头像绝不 N+1 请求档案。
      assert.equal((await app.inject('/api/pixiv/users/11/avatar')).statusCode, 404)
      assert.equal(details, before)
      // 用户主动打开档案后可回填头像，代理随后命中已知地址。
      assert.equal((await app.inject('/api/pixiv/users/11')).statusCode, 200)
      assert.equal(details, before + 1)
      const profiled = await app.inject('/api/pixiv/users/11/avatar')
      assert.equal(profiled.statusCode, 200, profiled.body)
      assert.equal(details, before + 1)
      const missing = await app.inject('/api/pixiv/users/12/avatar')
      assert.equal(missing.statusCode, 404)
      assert.equal(details, before + 1)
      // 背景缺失同样 404。
      assert.equal((await app.inject('/api/pixiv/users/12/background')).statusCode, 404)
      assert.equal((await app.inject('/api/pixiv/users/abc/avatar')).statusCode, 400)
    })

    await t.test('账号隔离与本地模式', async () => {
      handler = async () => json({ user_previews: [{ user: { id: 7, name: '画师7' } }], next_url: null })
      const first = await app.inject('/api/pixiv/users/search?q=%E7%94%BB%E5%B8%88')
      assert.equal(first.statusCode, 200)
      assert.equal(store.getPixivApiCache(`user-summary:${uid}:7`)?.name, '画师7')
      await auth.savePixivSettings({ localMode: true })
      for (const url of ['/api/pixiv/users/search?q=x', '/api/pixiv/users/7', '/api/pixiv/users/7/works', '/api/pixiv/users/7/avatar']) {
        assert.equal((await app.inject(url)).statusCode, 403, url)
      }
      await auth.savePixivSettings({ localMode: false })
    })

    await t.test('头像允许域名、MIME 和缺失数值安全降级', async () => {
      store.setPixivApiCache(`user-summary:${uid}:60`, { id: '60', name: 'unsafe', avatarUrl: 'https://evil.example/avatar.png' }, 60_000)
      assert.equal((await app.inject('/api/pixiv/users/60/avatar')).statusCode, 400)
      store.setPixivApiCache(`user-summary:${uid}:61`, { id: '61', name: 'non-image', avatarUrl: 'https://s.pximg.net/not-an-image' }, 60_000)
      handler = async () => new Response('not an image', { headers: { 'Content-Type': 'video/webm' } })
      assert.equal((await app.inject('/api/pixiv/users/61/avatar')).statusCode, 502)
      const profile = user.normalizeUserDetail({ user: { id: 62, name: 'optional' }, profile: { total_illusts: null, total_manga: '', total_follow_users: false, total_novels: 0 } } as never, '62').profile
      assert.equal(profile.totalIllusts, undefined)
      assert.equal(profile.totalManga, undefined)
      assert.equal(profile.totalFollows, undefined)
      assert.equal(profile.totalNovels, 0)
      assert.equal(catalog.normalizePixivIllust({ ...illust(999, 7), user: { id: 'bad7bad', name: 'bad' } }).work.pixivUserId, undefined)
    })

    await t.test('切换账号不复用上个账号的搜索和头像缓存', async () => {
      loginUid = '43'
      await auth.savePixivSettings({ refreshToken: 'second-account', localMode: false })
      assert.equal(auth.getPixivRuntime().account?.id, '43')
      const before = upstream
      assert.equal((await app.inject('/api/pixiv/users/7/avatar')).statusCode, 404)
      assert.equal(upstream, before, '未知新账号头像不请求上游详情')
      handler = async () => json({ user_previews: [{ user: { id: 7, name: '第二账号画师' } }], next_url: null })
      const response = await app.inject('/api/pixiv/users/search?q=%E7%94%BB%E5%B8%88')
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().items[0].name, '第二账号画师')
      assert.equal(upstream, before + 1)
      assert.equal(store.getPixivApiCache(`user-summary:43:7`)?.avatarUrl, undefined)
      loginUid = uid
      await auth.savePixivSettings({ refreshToken: 'first-account', localMode: false })
    })

    await t.test('用户归一化单元：非法丢弃、XSS 安全字段', async () => {
      assert.equal(user.normalizeUserSearch({ user_previews: [{ user: { id: 1, name: 'a' } }] })[0].id, '1')
      assert.throws(() => user.normalizeUserSearch({ user_previews: 'bad' } as never), /不完整/)
      assert.throws(() => user.normalizeUserDetail({ user: { id: 8, name: '错' } }, '7'), /不完整/)
      const evil = user.normalizeUserDetail({ user: { id: 7, name: '画师' }, profile: { webpage: 'javascript:alert(1)', twitter_url: 'not a url', background_image_url: 'ftp://x/y.png' } }, '7')
      assert.equal(evil.profile.webpage, undefined)
      assert.equal(evil.profile.backgroundUrl, undefined)
      // twitter_account 回退拼出合法 https。
      const fallback = user.normalizeUserDetail({ user: { id: 7, name: '画师' }, profile: { twitter_account: '@artist7' } }, '7')
      assert.equal(fallback.profile.twitterUrl, 'https://twitter.com/artist7')
    })
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
