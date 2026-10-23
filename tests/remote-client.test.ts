import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * 主服务 → 计算端的真实 HTTP 往返。
 *
 * 计算端用假引擎注入，重点验证：状态检查、鉴权失败阶段、上传/轮询/底图校验、
 * 以及"没监听端口"会被标记成可回退的 connect 阶段。
 */

const { createComputeApp } = await import('../server/compute/app.js')
const { checkRemoteCompute, runRemoteMangaJob, RemoteComputeError } = await import('../server/ai/manga/remote.js')

const KEY = 'roundtrip-key'
const BASE_PNG = Buffer.from('roundtrip-png-bytes')
const root = await mkdtemp(path.join(os.tmpdir(), 'remote-client-'))

const engine = {
  modelStatus: () => ({
    ready: true,
    device: '测试设备',
    models: [{ name: 'fake', ready: true, files: [], missing: [] }],
  }),
  process: async (imagePath: string) => {
    const image = await readFile(imagePath)
    return {
      width: 64,
      height: 96,
      regions: [{
        id: 1, x: 4, y: 6, width: 20, height: 24,
        source: `原文:${image.toString('utf8')}`,
        detection: 0.88, confidence: 0.77, background: '#fafafa', textColor: '#111111',
      }],
      base: BASE_PNG,
      engine: 'fake-engine',
      timings: { detectionMs: 1, ocrMs: 2, eraseMs: 3, encodeMs: 4 },
    }
  },
}

const compute = await createComputeApp({ apiKey: KEY, workDir: path.join(root, 'work'), engine, quiet: true })
await compute.listen({ port: 0, host: '127.0.0.1' })
// 测试里把连接保活缩短，否则关闭实例后仍要等默认的 72 秒才会退出进程。
compute.server.keepAliveTimeout = 500
compute.server.headersTimeout = 1000
const port = (compute.server.address() as AddressInfo).port
const config = { baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, connectTimeoutMs: 3000, timeoutMs: 10_000 }

after(async () => {
  compute.server.closeAllConnections?.()
  await compute.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** 拿一个"确定没人监听"的本地端口，用来验证 connect 阶段失败。 */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

test('远程计算端的协议往返与错误阶段', async t => {
  await t.test('状态检查返回协议版本与设备', async () => {
    const status = await checkRemoteCompute(config)
    assert.equal(status.protocol, 1)
    assert.equal(status.ready, true)
    assert.equal(status.device, '测试设备')
  })

  await t.test('Key 错误标记为 auth 阶段（不可回退）', async () => {
    await assert.rejects(
      () => checkRemoteCompute({ ...config, apiKey: 'wrong' }),
      (error: unknown) => error instanceof RemoteComputeError && error.phase === 'auth' && error.statusCode === 401,
    )
  })

  await t.test('端口没监听标记为 connect 阶段（可回退）', async () => {
    const port = await closedPort()
    await assert.rejects(
      () => checkRemoteCompute({ ...config, baseUrl: `http://127.0.0.1:${port}` }),
      (error: unknown) => error instanceof RemoteComputeError && error.phase === 'connect' && error.retryable === true,
    )
  })

  await t.test('上传原图后取回识别结果与校验过的底图', async () => {
    const imagePath = path.join(root, 'page.png')
    await writeFile(imagePath, Buffer.from('page-image-bytes'))
    const page = await runRemoteMangaJob(config, { imagePath })
    assert.equal(page.width, 64)
    assert.equal(page.height, 96)
    assert.equal(page.regions[0]?.source, '原文:page-image-bytes')
    assert.equal(page.engine, 'fake-engine')
    assert.deepEqual(page.base, BASE_PNG)
    assert.equal(createHash('sha256').update(page.base!).digest('hex').length, 64)
  })

  await t.test('同一张图再次请求复用计算端缓存，结果一致', async () => {
    const imagePath = path.join(root, 'repeat.png')
    await writeFile(imagePath, Buffer.from('repeat-bytes'))
    const first = await runRemoteMangaJob(config, { imagePath })
    const second = await runRemoteMangaJob(config, { imagePath })
    assert.deepEqual(second.regions, first.regions)
    assert.deepEqual(second.base, first.base)
  })
})
