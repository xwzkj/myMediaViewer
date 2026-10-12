import test from 'node:test'
import assert from 'node:assert/strict'
import { pixivFetch, pixivForm } from '../server/pixiv/client.js'
import { pixivJson, pixivRequest } from '../server/pixiv/transport.js'
import { setLoggingEnabled } from '../server/log.js'

test('Pixiv 失败日志包含请求参数、状态与上游原文，隐藏凭证并保留网络原因', async t => {
  const originalFetch = globalThis.fetch
  let output = ''
  setLoggingEnabled(true)
  const capture = t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => { output += String(chunk); return true })
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { user_message: '不正确的请求。', message: 'too many tags', details: { limit: 10 }, access_token: 'response-secret' } }), { status: 400 })
    await assert.rejects(pixivForm('/v2/illust/bookmark/add', { illust_id: '123', restrict: 'private', 'tags[]': ['原文', '译文'], refresh_token: 'request-secret' }, { auth: false }), /不正确的请求/)
    assert.match(output, /POST.*400/)
    assert.match(output, /illust_id.*123/)
    assert.match(output, /private/)
    assert.match(output, /原文.*译文/)
    assert.match(output, /too many tags/)
    assert.match(output, /limit.*10/)
    assert.doesNotMatch(output, /request-secret|response-secret/)
    assert.match(output, /REDACTED/)

    output = ''
    globalThis.fetch = async () => new Response('{"error_description":"invalid refresh token","refresh_token":"oauth-response-secret"}', { status: 400 })
    const response = await pixivRequest('https://oauth.secure.pixiv.net/auth/token?client_secret=query-secret', { method: 'POST', body: new URLSearchParams({ refresh_token: 'oauth-request-secret', client_secret: 'body-secret' }) })
    await pixivJson(response)
    assert.match(output, /auth\/token/)
    assert.match(output, /invalid refresh token/)
    assert.doesNotMatch(output, /oauth-request-secret|oauth-response-secret|query-secret|body-secret/)

    output = ''
    globalThis.fetch = async () => new Response('{"error":{"message":"logical failure"}}')
    await assert.rejects(pixivFetch('/v1/test', {}, { auth: false }), /logical failure/)
    assert.match(output, /logical failure/)

    output = ''
    globalThis.fetch = async () => new Response('<html>gateway diagnostic</html>')
    await assert.rejects(pixivFetch('/v1/test', {}, { auth: false }), /JSON/)
    assert.match(output, /gateway diagnostic/)

    output = ''
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) }) }
    await assert.rejects(pixivForm('/v2/illust/bookmark/add', { illust_id: '123' }, { auth: false }), /无法连接/)
    assert.match(output, /ECONNREFUSED/)
    assert.match(output, /connection refused/)
  } finally {
    globalThis.fetch = originalFetch
    capture.mock.restore()
  }
})
