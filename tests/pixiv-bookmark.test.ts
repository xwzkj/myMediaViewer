import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('云收藏限制为 10 个原文优先标签，未知参数错误仍可降级收藏', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-bookmark-'))
  const data = path.join(root, 'data')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'sources.json'), '[]')
  process.env.MEDIA_DATA_DIR = data
  const originalFetch = globalThis.fetch
  let addCalls = 0
  let tagAttempts = 0
  let rejectTags = false
  const originalTags = ['R-18', 'とある科学の超電磁砲', 'とある魔術の禁書目録', '御坂美琴', '陰毛', '乳寄せ', 'ローアングル', 'とある5000users入り', 'とある10000users入り', '盛るペコ']
  const translations = ['', '某科学的超电磁炮', '魔法的禁书目录', 'mikoto misaka', '阴毛', 'boobs squeezing', '低角度', '某系列5000收藏', '', '摩尔佩克']
  let submittedTags: string[] = []
  let detailCalls = 0
  const restrictions: Array<string | null> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('oauth.secure.pixiv.net')) {
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r2', expires_in: 3600, user: { id: '42', name: 'name', account: 'acct' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/v1/illust/detail')) {
      detailCalls++
      return new Response(JSON.stringify({ illust: { id: 123, title: 'Title', caption: 'Desc', type: 'illust', page_count: 1, user: { id: 7, name: 'Author' }, tags: originalTags.map((name, i) => ({ name, translated_name: translations[i] })), image_urls: { large: 'https://i.pximg.net/a.jpg' }, meta_single_page: { original_image_url: 'https://i.pximg.net/a.jpg' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/v2/illust/bookmark/add')) {
      addCalls++
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body || '')
      restrictions.push(new URLSearchParams(body).get('restrict'))
      if (body.includes('tags%5B%5D')) {
        tagAttempts++
        submittedTags = new URLSearchParams(body).getAll('tags[]')
        if (rejectTags || submittedTags.length > 10) return new Response(JSON.stringify({ error: { message: '', user_message: '不正确的请求。' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const auth = await import('../server/pixiv/auth.js')
  const app = await createApp(false)
  try {
    await auth.savePixivSettings({ refreshToken: 'r1', autoBookmarkTags: true, defaultBookmarkRestrict: 'public' })
    const taggedResponse = await app.inject({ method: 'PUT', url: '/api/pixiv/works/123/bookmark', payload: { bookmarked: true } })
    assert.equal(taggedResponse.statusCode, 200, taggedResponse.body)
    assert.equal(taggedResponse.json().tagsApplied, true)
    assert.equal(taggedResponse.json().warning, undefined)
    assert.deepEqual(submittedTags, originalTags, '18 个原文与译文标签只提交 10 个原文，表单编码完整保留日文与空格')
    assert.equal(addCalls, 1, '合法标签首次请求成功，无需无标签降级')
    const { getPixivWorkRecord } = await import('../server/pixiv/store.js')
    const legacy = getPixivWorkRecord('42', '123')!
    assert.equal(legacy.work.tags.length, 18, '展示与检索标签不受收藏数量限制')
    delete legacy.meta.bookmarkTags
    db.prepare('UPDATE pixiv_works SET data = ? WHERE account_id = ? AND illust_id = ?').run(JSON.stringify(legacy), '42', '123')
    const legacyResponse = await app.inject({ method: 'PUT', url: '/api/pixiv/works/123/bookmark', payload: { bookmarked: true } })
    assert.equal(legacyResponse.json().tagsApplied, true)
    assert.equal(detailCalls, 2, '旧缓存补取原标签，避免直接截取交错合并的原文和译文')
    assert.deepEqual(submittedTags, originalTags)
    rejectTags = true
    addCalls = 0
    tagAttempts = 0
    restrictions.length = 0
    const response = await app.inject({ method: 'PUT', url: '/api/pixiv/works/123/bookmark', payload: { bookmarked: true } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().bookmarked, true)
    assert.equal(response.json().tagsApplied, false)
    assert.match(response.json().warning, /标签未附加/)
    assert.equal(tagAttempts, 1)
    assert.equal(addCalls, 2)
    assert.deepEqual(restrictions, ['public', 'public'])
    await auth.savePixivSettings({ defaultBookmarkRestrict: 'private', autoBookmarkTags: false })
    const privateResponse = await app.inject({ method: 'PUT', url: '/api/pixiv/works/123/bookmark', payload: { bookmarked: true, restrict: 'public' } })
    assert.equal(privateResponse.statusCode, 200, privateResponse.body)
    assert.equal(privateResponse.json().restrict, 'private')
    assert.equal(restrictions.at(-1), 'private', '收藏始终使用设置中的默认可见性')
    const settingsFile = JSON.parse(await readFile(path.join(data, 'pixiv.json'), 'utf8'))
    assert.equal(settingsFile.refreshToken, 'r2')
    assert.equal(settingsFile.accessToken, 'a')
  } finally {
    await app.close()
    db.close()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
