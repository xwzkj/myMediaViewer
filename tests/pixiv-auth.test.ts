import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('refresh_token 交换、访问令牌缓存和鉴权请求头', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-auth-'))
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  const originalFetch = globalThis.fetch
  let tokenCalls = 0
  let appAuth = ''
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('oauth.secure.pixiv.net')) {
      tokenCalls++
      return new Response(JSON.stringify({
        access_token: 'access-1',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        user: { id: '42', name: '测试画师', account: 'painter', is_premium: false },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    appAuth = new Headers(init?.headers).get('Authorization') || ''
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const auth = await import('../server/pixiv/auth.js')
    const client = await import('../server/pixiv/client.js')
    const { db } = await import('../server/database.js')
    assert.equal(auth.getPixivSettings().localMode, true, '未登录默认启用本地模式')
    assert.equal((await auth.savePixivSettings({ localMode: false })).localMode, true, '未登录不能关闭本地模式')
    const settings = await auth.savePixivSettings({ refreshToken: 'refresh-1', localMode: true, defaultBookmarkRestrict: 'private', autoBookmarkTags: false, cacheLimitMb: 256 })
    assert.equal(settings.configured, true)
    assert.equal(settings.localMode, false, '登录后自动关闭本地模式')
    assert.equal(settings.account?.id, '42')
    assert.equal(settings.defaultBookmarkRestrict, 'private')
    assert.equal('refreshToken' in settings, false)
    assert.equal(tokenCalls, 1)
    assert.equal(await auth.getPixivAccessToken(), 'access-1')
    assert.equal(await auth.getPixivAccessToken(), 'access-1')
    assert.equal(tokenCalls, 1)
    assert.deepEqual(await client.pixivFetch('/v1/test'), { ok: true })
    assert.equal(appAuth, 'Bearer access-1')
    assert.equal((await auth.savePixivSettings({ localMode: true })).localMode, true, '登录后允许手动开启本地模式')
    assert.equal((await auth.savePixivSettings({ localMode: false })).localMode, false, '登录后允许手动关闭本地模式')
    auth.clearPixivAccount()
    assert.equal(auth.getPixivSettings().localMode, true, '退出登录后强制开启本地模式')
    assert.equal((await auth.savePixivSettings({ localMode: false })).localMode, true)
    db.close()
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
