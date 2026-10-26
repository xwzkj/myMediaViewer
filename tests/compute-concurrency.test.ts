import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 计算端的排队策略：后台流水线允许多个任务同时在算，手动任务插到队列最前。
 * 用可控的假引擎，避免依赖真实 ONNX 模型。
 */

const { createComputeApp } = await import('../server/compute/app.js')
const {
  COMPUTE_HEADER_PRIORITY, COMPUTE_HEADER_PROTOCOL, COMPUTE_HEADER_REQUEST_ID, COMPUTE_HEADER_SHA256,
  COMPUTE_PROTOCOL_VERSION,
} = await import('../shared/compute.js')

const KEY = 'concurrency-key'
const root = await mkdtemp(path.join(os.tmpdir(), 'compute-concurrency-'))
const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>()
for (const label of ['bg1', 'bg2', 'bg3', 'manual']) {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  gates.set(label, { promise, resolve })
}
const started: string[] = []
let active = 0, peak = 0

const engine = {
  modelStatus: () => ({ ready: true, device: '测试设备', models: [{ name: 'fake', ready: true, files: [], missing: [] }] }),
  process: async (imagePath: string) => {
    const label = (await readFile(imagePath)).toString('utf8')
    started.push(label)
    peak = Math.max(peak, ++active)
    await gates.get(label)!.promise
    active--
    return {
      width: 20, height: 30, regions: [], engine: 'fake',
      timings: { detectionMs: 0, ocrMs: 0, eraseMs: 0, encodeMs: 0 },
    }
  },
}

const app = await createComputeApp({
  apiKey: KEY, workDir: path.join(root, 'work'), engine, quiet: true, concurrency: 2,
})
after(async () => {
  await app.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const auth = { authorization: `Bearer ${KEY}` }
function headers(label: string, priority: 'manual' | 'background') {
  return {
    ...auth,
    'content-type': 'application/octet-stream',
    [COMPUTE_HEADER_REQUEST_ID]: `request-${label}`,
    [COMPUTE_HEADER_SHA256]: createHash('sha256').update(label).digest('hex'),
    [COMPUTE_HEADER_PROTOCOL]: String(COMPUTE_PROTOCOL_VERSION),
    [COMPUTE_HEADER_PRIORITY]: priority,
  }
}
async function upload(label: string, priority: 'manual' | 'background') {
  const response = await app.inject({ method: 'POST', url: '/v1/jobs', payload: Buffer.from(label), headers: headers(label, priority) })
  assert.equal(response.statusCode, 202)
}
async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`等待超时：${label}`)
}

test('计算端按并发数补位，手动任务先于排队中的后台任务', async () => {
  await upload('bg1', 'background')
  await upload('bg2', 'background')
  await waitFor(() => started.length === 2, '两个后台任务同时开始')
  assert.deepEqual(started, ['bg1', 'bg2'])
  assert.equal(peak, 2)

  await upload('bg3', 'background')
  await upload('manual', 'manual')
  await new Promise(resolve => setTimeout(resolve, 50))
  const status = await app.inject({ url: '/v1/status', headers: auth })
  assert.equal((status.json() as { running: number; queued: number }).running, 2)
  assert.equal((status.json() as { running: number; queued: number }).queued, 2)

  gates.get('bg1')!.resolve()
  await waitFor(() => started.includes('manual'), '有空位后先跑手动任务')
  assert.equal(started[2], 'manual', '手动任务不能排在第三个后台任务之后')
  assert.ok(!started.includes('bg3'))

  gates.get('bg2')!.resolve()
  gates.get('manual')!.resolve()
  await waitFor(() => started.includes('bg3'), '后台任务最后补位')
  gates.get('bg3')!.resolve()
  await waitFor(() => active === 0 && started.length === 4, '全部任务收尾')
  assert.equal(peak, 2, '并发数不能被请求头突破')
})
