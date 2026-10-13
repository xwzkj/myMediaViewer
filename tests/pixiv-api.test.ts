import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('Pixiv 设置默认不泄露 token，本地模式拒绝云接口', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-api-'))
  const data = path.join(root, 'data')
  const media = path.join(root, 'media')
  await mkdir(data, { recursive: true })
  await mkdir(media, { recursive: true })
  await writeFile(path.join(data, 'sources.json'), '[]')
  await writeFile(path.join(media, '1-2_p0.jpg'), 'x')
  process.env.MEDIA_DATA_DIR = data
  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const originalFetch = globalThis.fetch
  const app = await createApp(false)
  try {
    const settings = await app.inject('/api/pixiv/settings')
    assert.equal(settings.statusCode, 200)
    assert.equal(settings.json().configured, false)
    assert.equal('refreshToken' in settings.json(), false)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/pixiv/settings', payload: { localMode: true } })).statusCode, 200)
    assert.equal((await app.inject('/api/pixiv/search?q=test')).statusCode, 403)
    await t.test('本地来源列表和本地收藏显示当前账号的云收藏状态', async () => {
      globalThis.fetch = (async () => Response.json({ access_token: 'fixture', refresh_token: 'fixture', expires_in: 3600, user: { id: '42' } })) as typeof fetch
      const { savePixivSettings } = await import('../server/pixiv/auth.js')
      const { saveSources } = await import('../server/config.js')
      const { customRules } = await import('../shared/source-presets.js')
      const { normalizePixivIllust } = await import('../server/pixiv/catalog.js')
      const { savePixivBookmarks, removePixivBookmark } = await import('../server/pixiv/store.js')
      await savePixivSettings({ refreshToken: 'fixture', localMode: false })
      saveSources([{ id: 'local', name: '自定义 Pixiv', kind: 'custom', path: media, rules: customRules(), pixivWorks: true }])
      const cloud = normalizePixivIllust({ id: 123, type: 'illust', title: '作品', page_count: 1 })
      const local = { ...cloud.work, id: 'local:123', sourceId: 'local', sourceKind: 'custom', coverId: 'cover', originalUrl: '' }
      db.prepare('INSERT INTO works VALUES (?, ?, ?)').run(local.id, local.sourceId, JSON.stringify(local))
      db.prepare('INSERT INTO favorites VALUES (?, ?)').run(local.id, Date.now())
      savePixivBookmarks('42', 'private', [{ work: cloud.work, sequence: 1 }])
      const list = async (url = '/api/works?source=local') => (await app.inject(url)).json().items
      const state = { bookmarked: true, restrict: 'private' }
      assert.deepEqual((await list())[0].cloudBookmark, state)
      assert.deepEqual((await list('/api/works?source=local&favorites=true'))[0].cloudBookmark, state)
      assert.equal((await list())[0].hasLocal, true)
      assert.equal((await list())[0].favorite, true)
      removePixivBookmark('42', '123')
      assert.equal((await list())[0].cloudBookmark.bookmarked, false)
      savePixivBookmarks('different-account', 'public', [{ work: cloud.work, sequence: 1 }])
      assert.equal((await list())[0].cloudBookmark.bookmarked, false, '不能使用其他账号的收藏状态')
      await savePixivSettings({ localMode: true })
      assert.equal((await list())[0].cloudBookmark, undefined)
    })
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
