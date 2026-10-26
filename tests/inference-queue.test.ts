import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPriorityQueue } from '../server/ai/manga/priority.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('远程队列允许多个后台任务并行，手动任务可以越过已满名额', async () => {
  const queue = createPriorityQueue({ backgroundConcurrency: 2, manualBypass: true })
  const gates = [deferred(), deferred(), deferred(), deferred(), deferred()]
  const started: string[] = []
  const jobs = [
    queue(async () => { started.push('b1'); await gates[0]!.promise }, 'background'),
    queue(async () => { started.push('b2'); await gates[1]!.promise }, 'background'),
    queue(async () => { started.push('b3'); await gates[2]!.promise }, 'background'),
  ]
  await flush()
  assert.deepEqual(started, ['b1', 'b2'], '后台名额为 2，第三个先排队')
  const manual = queue(async () => { started.push('m'); await gates[3]!.promise }, 'manual')
  await flush()
  assert.deepEqual(started, ['b1', 'b2', 'm'], '手动任务不等待后台名额')

  gates[0]!.resolve()
  await jobs[0]
  await flush()
  assert.deepEqual(started, ['b1', 'b2', 'm', 'b3'], '空出的后台名额按顺序补位')
  gates[1]!.resolve(); gates[2]!.resolve(); gates[3]!.resolve()
  await Promise.all([jobs[1]!, jobs[2]!, manual])
})

test('本地队列保持串行，手动任务只插队不并发', async () => {
  const queue = createPriorityQueue({ manualBypass: false })
  const gates = [deferred(), deferred()]
  const started: string[] = []
  const first = queue(async () => { started.push('b'); await gates[0]!.promise }, 'background')
  const manual = queue(async () => { started.push('m'); await gates[1]!.promise }, 'manual')
  await flush()
  assert.deepEqual(started, ['b'], '本地 ONNX 会话一次只能跑一个')
  gates[0]!.resolve()
  await first
  await flush()
  assert.deepEqual(started, ['b', 'm'], '前一个完成后再跑手动任务')
  gates[1]!.resolve()
  await manual
})

test('取消排队的任务会释放名额，队列满时拒绝新任务', async () => {
  const queue = createPriorityQueue({ manualBypass: false })
  const controller = new AbortController()
  const pending = queue(() => Promise.resolve('never'), 'manual', controller.signal)
  controller.abort(new Error('取消'))
  await assert.rejects(pending, /取消/)
  assert.equal(await queue(async () => 'next'), 'next')

  const blocked = createPriorityQueue({ manualBypass: false })
  const gate = deferred()
  const running = blocked(async () => { await gate.promise }, 'background')
  const queued: Promise<unknown>[] = []
  for (let i = 0; i < 1001; i++) queued.push(blocked(async () => i, 'background').catch(error => error))
  const errors = await Promise.all(queued.slice(1000))
  assert.match(String(errors[0]), /队列已满/)
  gate.resolve()
  await running
})
