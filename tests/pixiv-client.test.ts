import test from 'node:test'
import assert from 'node:assert/strict'
import { pixivFetch, pixivForm } from '../server/pixiv/client.js'

test('Pixiv 客户端附加固定请求头并拒绝非 app-api 域名', async () => {
  const originalFetch = globalThis.fetch
  let seen: RequestInit | undefined
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen = init
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await pixivFetch<{ ok: boolean }>('/v1/test', {}, { auth: false })
    assert.equal(result.ok, true)
    const headers = new Headers(seen?.headers)
    assert.equal(headers.get('app-os'), 'ios')
    assert.equal(headers.get('app-version'), '7.13.4')
    assert.ok(headers.get('x-client-time'))
    assert.match(headers.get('x-client-hash') || '', /^[a-f0-9]{32}$/)
    await assert.rejects(() => pixivFetch('https://evil.example/v1/test', {}, { auth: false }), /不允许/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Pixiv 表单按数组字段展开', async () => {
  const originalFetch = globalThis.fetch
  let body = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body || '')
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    await pixivForm('/v2/illust/bookmark/add', { illust_id: '1', 'tags[]': ['a', 'b'] }, { auth: false })
    assert.match(body, /illust_id=1/)
    assert.match(body, /tags%5B%5D=a/)
    assert.match(body, /tags%5B%5D=b/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
