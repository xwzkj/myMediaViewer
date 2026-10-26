import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerSemanticComputeRoutes } from '../server/semantic/compute-routes.js'
import { RemoteClipProvider } from '../server/semantic/remote.js'
import type { SemanticProvider } from '../server/semantic/provider.js'
import type { LocalComputeConfig } from '../server/ai.js'
import { normalizeVector } from '../server/semantic/vectors.js'
import { COMPUTE_PROTOCOL_VERSION } from '../shared/compute.js'

const model = 'chinese-clip-vit-b16:' + 'a'.repeat(64)
const otherModel = 'chinese-clip-vit-b16:' + 'b'.repeat(64)
const vector = normalizeVector([1, ...Array(511).fill(0)])
function provider(id = model): SemanticProvider { return { status: async () => ({ ready: true, provider: 'local', dimensions: 512, model: id }), embedText: async () => vector, embedImage: async () => vector } }
const config = (baseUrl: string, fallback: 'local' | 'error' = 'error'): LocalComputeConfig => ({ mode: 'remote', baseUrl, fallback, apiKey: 'secret', connectTimeoutMs: 1000, timeoutMs: 1000, localThreads: 1 })

test('compute embedding routes respect bearer hook, model/version and input validation', async () => {
  const app = Fastify()
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
  app.addHook('onRequest', (request, reply, done) => { if (request.headers.authorization !== 'Bearer secret') reply.code(401).send({ message: 'unauthorized' }); else done() })
  app.get('/v1/status', async () => ({ protocol: COMPUTE_PROTOCOL_VERSION, ready: true }))
  registerSemanticComputeRoutes(app, provider())
  await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    assert.equal((await app.inject({ url: '/v1/semantic/status' })).statusCode, 401)
    const address = app.server.address() as { port: number }
    const remote = new RemoteClipProvider(config(`http://127.0.0.1:${address.port}/`), provider())
    const status = await remote.status(); assert.equal(status.ready, true); assert.equal(status.provider, 'remote')
    assert.deepEqual(await remote.embedText('a cat'), vector)
    assert.deepEqual(await remote.embedImage(Buffer.from('fixture image handled by injected provider')), vector)
    const mismatch = await app.inject({ method: 'POST', url: '/v1/semantic/text', headers: { authorization: 'Bearer secret', 'x-semantic-model': otherModel }, payload: { query: 'cat' } })
    assert.equal(mismatch.statusCode, 409)
    const empty = await app.inject({ method: 'POST', url: '/v1/semantic/text', headers: { authorization: 'Bearer secret', 'x-semantic-model': model }, payload: { query: '  ' } })
    assert.equal(empty.statusCode, 400)
  } finally { await app.close() }
})

test('offline fallback is explicit; authentication failures do not silently fall back', async () => {
  const app = Fastify(); app.get('/v1/status', async () => ({ protocol: COMPUTE_PROTOCOL_VERSION })); app.get('/v1/semantic/status', async (_request, reply) => reply.code(503).send({ message: 'offline' }))
  await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    const fallback = new RemoteClipProvider(config(base, 'local'), provider())
    assert.equal((await fallback.status()).provider, 'local')
    assert.deepEqual(await fallback.embedText('cat'), vector)
    const disabled = new RemoteClipProvider(config(base), provider())
    assert.equal((await disabled.status()).ready, false)
    await assert.rejects(disabled.embedText('cat'), { code: 'semantic_unavailable' })
  } finally { await app.close() }
  const unauthorized = Fastify(); unauthorized.get('/v1/status', async () => ({ protocol: COMPUTE_PROTOCOL_VERSION })); unauthorized.get('/v1/semantic/status', async (_request, reply) => reply.code(401).send({}))
  await unauthorized.listen({ host: '127.0.0.1', port: 0 })
  try {
    const remote = new RemoteClipProvider(config(`http://127.0.0.1:${(unauthorized.server.address() as { port: number }).port}`, 'local'), provider())
    assert.equal((await remote.status()).ready, false)
  } finally { await unauthorized.close() }
})

test('in-flight fallback refuses mismatched local models; remote vector dimensions are enforced', async () => {
  const app = Fastify()
  app.get('/v1/status', async () => ({ protocol: COMPUTE_PROTOCOL_VERSION }))
  app.get('/v1/semantic/status', async () => ({ ready: true, provider: 'local', dimensions: 512, model }))
  app.post('/v1/semantic/text', async (_request, reply) => reply.code(503).send({}))
  await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    const mismatch = new RemoteClipProvider(config(base, 'local'), provider(otherModel))
    await mismatch.status()
    await assert.rejects(mismatch.embedText('cat'), { code: 'semantic_fallback_unavailable' })
    const matching = new RemoteClipProvider(config(base, 'local'), provider())
    await matching.status(); assert.deepEqual(await matching.embedText('cat'), vector)
  } finally { await app.close() }
  const corrupt = Fastify()
  corrupt.get('/v1/status', async () => ({ protocol: COMPUTE_PROTOCOL_VERSION }))
  corrupt.get('/v1/semantic/status', async () => ({ ready: true, dimensions: 512, model }))
  corrupt.post('/v1/semantic/text', async () => ({ dimensions: 512, model, vector: [1, 2] }))
  await corrupt.listen({ host: '127.0.0.1', port: 0 })
  try {
    const remote = new RemoteClipProvider(config(`http://127.0.0.1:${(corrupt.server.address() as { port: number }).port}`, 'local'), provider())
    await remote.status(); await assert.rejects(remote.embedText('cat'), { code: 'semantic_invalid_vector' })
  } finally { await corrupt.close() }
})


test('base compute health failure never sends a semantic job, even if semantic endpoint is healthy', async () => {
  const app = Fastify()
  let semanticCalls = 0
  app.get('/v1/status', async (_request, reply) => reply.code(503).send({ message: 'offline' }))
  app.get('/v1/semantic/status', async () => { semanticCalls++; return { ready: true, model, dimensions: 512 } })
  app.post('/v1/semantic/text', async () => { semanticCalls++; return { model, dimensions: 512, vector: Array.from(vector) } })
  await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const address = app.server.address() as { port: number }
    const base = 'http://127.0.0.1:' + address.port
    const fallback = new RemoteClipProvider(config(base, 'local'), provider())
    assert.equal((await fallback.status()).provider, 'local')
    assert.deepEqual(await fallback.embedText('cat'), vector)
    const disabled = new RemoteClipProvider(config(base), provider())
    assert.equal((await disabled.status()).ready, false)
    await assert.rejects(disabled.embedText('cat'), { code: 'semantic_unavailable' })
    assert.equal(semanticCalls, 0)
  } finally { await app.close() }
})

test('远程 CLIP 图片超限保留 413 与具体原因，不被当成服务离线', async () => {
  const app = Fastify()
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
  app.get('/v1/status', async () => ({ protocol: COMPUTE_PROTOCOL_VERSION }))
  app.get('/v1/semantic/status', async () => ({ ready: true, provider: 'local', dimensions: 512, model }))
  app.post('/v1/semantic/image', async (_request, reply) => reply.code(413).send({
    code: 'semantic_image_too_large',
    message: '图片有 120.0 MP，超过语义索引 100 MP 上限',
  }))
  await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    const remote = new RemoteClipProvider(config(base), provider())
    await remote.status()
    await assert.rejects(remote.embedImage(Buffer.from('too-large')), {
      code: 'semantic_image_too_large',
      statusCode: 413,
      message: /120\.0 MP/,
    })
  } finally { await app.close() }
})
