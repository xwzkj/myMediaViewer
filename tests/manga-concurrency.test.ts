import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTranslationLimiter } from '../server/ai/manga/concurrency.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('识别结果立即开始翻译，满额后排队，空位按顺序补上', async () => {
  const limit = createTranslationLimiter(2)
  const gates = Array.from({ length: 4 }, deferred)
  const started: number[] = []
  let active = 0
  let peak = 0
  const pending: Promise<number>[] = []
  // 模拟识别逐张产出：无需等待前一页翻译即可提交下一页。
  for (let page = 0; page < gates.length; page++) {
    pending.push(limit(async () => {
      started.push(page)
      peak = Math.max(peak, ++active)
      await gates[page]!.promise
      active--
      return page
    }))
    if (page === 0) assert.deepEqual(started, [0], '首张识别完成后应立即请求翻译')
  }
  assert.deepEqual(started, [0, 1])
  gates[1]!.resolve()
  await pending[1]
  assert.deepEqual(started, [0, 1, 2], '任一请求完成就应释放名额')
  gates[2]!.resolve()
  await pending[2]
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[0]!.resolve()
  gates[3]!.resolve()
  assert.deepEqual(await Promise.all(pending), [0, 1, 2, 3])
  assert.equal(peak, 2)
  assert.equal(active, 0)
})

test('并发为 1 时串行翻译，失败释放名额且不影响后续页', async () => {
  const limit = createTranslationLimiter(1)
  const gate = deferred()
  const started: number[] = []
  const failed = limit(async () => {
    started.push(1)
    await gate.promise
    throw new Error('模型请求失败')
  })
  const failure = assert.rejects(failed, /模型请求失败/)
  const next = limit(async () => { started.push(2); return '译文' })
  assert.deepEqual(started, [1])
  gate.resolve()
  await failure
  assert.equal(await next, '译文')
  assert.deepEqual(started, [1, 2])
  assert.equal(await limit(async () => '后续页'), '后续页')
})

test('同步抛错也释放并发名额', async () => {
  const limit = createTranslationLimiter(1)
  await assert.rejects(limit(() => { throw new Error('请求构造失败') }), /请求构造失败/)
  assert.equal(await limit(async () => '成功'), '成功')
})
