import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 远程计算端的协议与鉴权。
 *
 * 用假引擎注入，避免测试依赖真实 ONNX 模型；重点验证：所有接口都要 Key、
 * 上传校验、任务幂等、结果与底图下载、以及删除后不可再查。
 */

const { createComputeApp } = await import('../server/compute/app.js')
const {
  COMPUTE_HEADER_PROTOCOL, COMPUTE_HEADER_REQUEST_ID, COMPUTE_HEADER_SHA256, COMPUTE_PROTOCOL_VERSION,
} = await import('../shared/compute.js')

const KEY = 'test-compute-key'
const root = await mkdtemp(path.join(os.tmpdir(), 'compute-app-'))
const workDir = path.join(root, 'work')
const OVERLAY_PNG = Buffer.from('fake-png-payload')

function fakeEngine() {
  return {
    modelStatus: () => ({
      ready: true,
      device: '测试设备',
      models: [{ name: 'fake', ready: true, files: [], missing: [] }],
    }),
    process: async (imagePath: string, setStage?: (stage: string) => void) => {
      // 引擎必须真的收到落盘的原图；上传内容损坏时这里会直接失败。
      const image = await readFile(imagePath)
      setStage?.('假引擎识别')
      return {
        width: 120,
        height: 160,
        regions: [{
          id: 1, x: 10, y: 12, width: 30, height: 40,
          source: `识别:${image.toString('utf8')}`,
          detection: 0.9, confidence: 0.8, background: '#ffffff', textColor: '#111111',
        }],
        overlay: OVERLAY_PNG,
        engine: 'fake-engine',
        timings: { detectionMs: 1, ocrMs: 2, eraseMs: 3, encodeMs: 4 },
      }
    },
  }
}

const app = await createComputeApp({ apiKey: KEY, workDir, engine: fakeEngine(), quiet: true })
after(async () => {
  await app.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const auth = { authorization: `Bearer ${KEY}` }

function uploadHeaders(image: Buffer, requestId = createHash('sha256').update(image).digest('hex')) {
  return {
    ...auth,
    'content-type': 'application/octet-stream',
    [COMPUTE_HEADER_REQUEST_ID]: requestId,
    [COMPUTE_HEADER_SHA256]: createHash('sha256').update(image).digest('hex'),
    [COMPUTE_HEADER_PROTOCOL]: String(COMPUTE_PROTOCOL_VERSION),
  }
}

async function waitForJob(id: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await app.inject({ url: `/v1/jobs/${id}`, headers: auth })
    assert.equal(response.statusCode, 200)
    const status = response.json() as { state: string }
    if (status.state === 'ready' || status.state === 'failed') return status as never
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('计算任务未在时限内完成')
}

test('远程计算端要求鉴权，并完成一次完整的上传/结果/底图流程', async t => {
  const image = Buffer.from('sample-image')

  await t.test('缺少或错误的 Key 一律 401', async () => {
    const missing = await app.inject({ url: '/v1/status' })
    assert.equal(missing.statusCode, 401)
    assert.equal((missing.json() as { code: string }).code, 'compute_unauthorized')
    const wrong = await app.inject({ url: '/v1/status', headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.statusCode, 401)
  })

  await t.test('状态接口如实返回协议版本与设备', async () => {
    const response = await app.inject({ url: '/v1/status', headers: auth })
    assert.equal(response.statusCode, 200)
    const status = response.json() as { protocol: number; device: string; ready: boolean }
    assert.equal(status.protocol, COMPUTE_PROTOCOL_VERSION)
    assert.equal(status.device, '测试设备')
    assert.equal(status.ready, true)
  })

  await t.test('上传→轮询→结果→覆盖层，内容与校验一致', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/jobs', payload: image, headers: uploadHeaders(image) })
    assert.equal(created.statusCode, 202)
    const id = (created.json() as { id: string }).id
    assert.ok(id)

    const status = await waitForJob(id) as unknown as {
      state: string
      result: { width: number; height: number; regions: Array<{ source: string }>; overlayBytes: number; overlaySha256: string }
    }
    assert.equal(status.state, 'ready')
    assert.equal(status.result.width, 120)
    assert.equal(status.result.regions[0]!.source, '识别:sample-image')
    assert.equal(status.result.overlayBytes, OVERLAY_PNG.length)

    const result = await app.inject({ url: `/v1/jobs/${id}/result`, headers: auth })
    assert.equal(result.statusCode, 200)

    const base = await app.inject({ url: `/v1/jobs/${id}/overlay`, headers: auth })
    assert.equal(base.statusCode, 200)
    assert.equal(base.headers['content-type'], 'image/png')
    assert.deepEqual(base.rawPayload, OVERLAY_PNG)
    assert.equal(createHash('sha256').update(base.rawPayload).digest('hex'), status.result.overlaySha256)
  })

  await t.test('同一请求 ID 重传复用已有任务，不重复计算', async () => {
    const first = await app.inject({ method: 'POST', url: '/v1/jobs', payload: image, headers: uploadHeaders(image) })
    assert.equal(first.statusCode, 202)
    const id = (first.json() as { id: string }).id
    await waitForJob(id)
    const again = await app.inject({ method: 'POST', url: '/v1/jobs', payload: image, headers: uploadHeaders(image) })
    assert.equal((again.json() as { id: string }).id, id)
  })

  await t.test('删除后任务不可再查询', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/jobs', payload: Buffer.from('deletable'), headers: uploadHeaders(Buffer.from('deletable')) })
    const id = (created.json() as { id: string }).id
    await waitForJob(id)
    const removed = await app.inject({ method: 'DELETE', url: `/v1/jobs/${id}`, headers: auth })
    assert.equal(removed.statusCode, 200)
    const after = await app.inject({ url: `/v1/jobs/${id}`, headers: auth })
    assert.equal(after.statusCode, 404)
  })

  await t.test('协议版本或内容摘要不符时拒绝上传', async () => {
    const badProtocol = await app.inject({
      method: 'POST', url: '/v1/jobs', payload: image,
      headers: { ...uploadHeaders(image), [COMPUTE_HEADER_PROTOCOL]: '999' },
    })
    assert.equal(badProtocol.statusCode, 409)
    assert.equal((badProtocol.json() as { code: string }).code, 'compute_protocol_mismatch')

    const badChecksum = await app.inject({
      method: 'POST', url: '/v1/jobs', payload: image,
      headers: { ...uploadHeaders(image), [COMPUTE_HEADER_SHA256]: 'f'.repeat(64) },
    })
    assert.equal(badChecksum.statusCode, 400)
    assert.equal((badChecksum.json() as { code: string }).code, 'checksum_mismatch')
  })
})

test('语义模型未就绪时返回 503 与可重试错误码，而不是笼统的 500', async () => {
  const pending = await createComputeApp({
    apiKey: KEY,
    workDir: path.join(root, 'semantic-work'),
    engine: fakeEngine(),
    quiet: true,
    // 首次使用会先自动下载模型；这段时间的语义请求必须可重试，而不是被判为内部错误。
    semanticProvider: {
      status: async () => ({ ready: false, provider: 'local', model: '', dimensions: 512, downloading: true, message: '正在下载 CLIP 模型 12%' }),
      embedText: async () => { throw new Error('不应被调用') },
      embedImage: async () => { throw new Error('不应被调用') },
    },
  })
  try {
    const response = await pending.inject({
      method: 'POST', url: '/v1/semantic/text',
      headers: { ...auth, 'content-type': 'application/json', 'x-semantic-model': 'chinese-clip-vit-b16:abc' },
      payload: { query: 'a cat' },
    })
    assert.equal(response.statusCode, 503)
    const body = response.json() as { code: string; retryable: boolean }
    assert.equal(body.code, 'semantic_downloading')
    assert.equal(body.retryable, true)

    const status = await pending.inject({ url: '/v1/semantic/status', headers: auth })
    assert.equal(status.statusCode, 200)
    assert.equal((status.json() as { downloading: boolean }).downloading, true)
  } finally {
    await pending.close()
  }
})
