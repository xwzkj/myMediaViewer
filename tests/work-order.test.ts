import test from 'node:test'
import assert from 'node:assert/strict'
import type { Work } from '../shared/types.js'
import { compareWorksByCollected, compareWorksByDate, hasCollectedSequence, isUnavailableWork } from '../server/work-order.js'

const DAY = 86_400_000
function work(id: string, options: Partial<Work> = {}): Work {
  const updated = options.updated ?? Date.parse('2025-01-01T00:00:00.000Z')
  return {
    id, sourceId: 'local', sourceName: '本地', sourceKind: 'custom', externalId: id,
    title: id, author: '', description: '', tags: [], date: options.date ?? new Date(updated).toISOString(),
    collected: 0, updated, count: 1, kind: 'image', favorite: false, cover: '', ...options,
  }
}
function sorted(works: Work[], compare: (a: Work, b: Work) => number): string[] {
  return [...works].sort(compare).map(item => item.id)
}

test('媒体不可用的作品在日期排序下永远排在最后，可用作品相对顺序不变', () => {
  const newest = work('newest', { date: '2025-03-01T00:00:00.000Z', updated: Date.parse('2025-03-01T00:00:00.000Z') })
  const middle = work('middle', { date: '2025-02-01T00:00:00.000Z', updated: Date.parse('2025-02-01T00:00:00.000Z') })
  const oldest = work('oldest', { date: '2025-01-01T00:00:00.000Z', updated: Date.parse('2025-01-01T00:00:00.000Z') })
  // 收藏夹里已删除的作品：没有 create_date，归一化时 updated 退到 0，但即便它带着
  // 「现在」的时间戳，也必须排在可用作品之后。
  const dead = work('dead', { date: new Date(Date.now() + 60 * DAY).toISOString(), updated: Date.now(), unavailable: true })
  const input = [dead, middle, newest, oldest]

  assert.deepEqual(sorted(input, (a, b) => compareWorksByDate(a, b, 'newest')), ['newest', 'middle', 'oldest', 'dead'])
  assert.deepEqual(sorted(input, (a, b) => compareWorksByDate(a, b, 'oldest')), ['oldest', 'middle', 'newest', 'dead'])
  // 输入顺序不同也得到同一结果：排序确定，翻页不重排。
  assert.deepEqual(sorted([oldest, newest, middle, dead], (a, b) => compareWorksByDate(a, b, 'newest')), ['newest', 'middle', 'oldest', 'dead'])
  // 没有标记的作品保持原来的日期顺序（对照：可用作品之间不受新分组影响）。
  assert.deepEqual(sorted([middle, newest, oldest], (a, b) => compareWorksByDate(a, b, 'newest')), ['newest', 'middle', 'oldest'])
})

test('同一天的作品用 updated / id 兜底，顺序确定且可重复', () => {
  const date = '2025-05-05T00:00:00.000Z'
  const first = work('b', { date, updated: Date.parse(date) })
  const second = work('a', { date, updated: Date.parse(date) })
  const newer = work('c', { date, updated: Date.parse(date) + 1000 })
  assert.deepEqual(sorted([first, second, newer], (a, b) => compareWorksByDate(a, b, 'newest')), ['c', 'a', 'b'])
  assert.deepEqual(sorted([newer, second, first], (a, b) => compareWorksByDate(a, b, 'newest')), ['c', 'a', 'b'])
  assert.deepEqual(sorted([first, second, newer], (a, b) => compareWorksByDate(a, b, 'oldest')), ['a', 'b', 'c'])
})

test('解析不出收藏序号的作品不再拿 updated 冒充序号，排在有真实序号的作品之后', () => {
  const real = [
    work('seq-300', { collected: 300, updated: Date.parse('2025-01-03T00:00:00.000Z') }),
    work('seq-200', { collected: 200, updated: Date.parse('2025-01-02T00:00:00.000Z') }),
    work('seq-100', { collected: 100, updated: Date.parse('2025-01-01T00:00:00.000Z') }),
  ]
  const legacyUpdated = 1_790_000_000_000
  // 老库里的兜底值：collected 就是 updated（毫秒时间戳），远大于真实收藏序号。
  const legacy = work('legacy', { collected: legacyUpdated, updated: legacyUpdated })
  // 新扫描：解析不出序号统一写 0。
  const noSequence = work('no-seq', { collected: 0, updated: legacyUpdated - DAY })
  const input = [legacy, ...real, noSequence]

  assert.deepEqual(sorted(input, (a, b) => compareWorksByCollected(a, b, 'newest')), ['seq-300', 'seq-200', 'seq-100', 'legacy', 'no-seq'])
  assert.deepEqual(sorted(input, (a, b) => compareWorksByCollected(a, b, 'oldest')), ['seq-100', 'seq-200', 'seq-300', 'no-seq', 'legacy'])
  // 有序号的作品之间仍是纯粹的收藏顺序，方向跟随「最新 / 最早」。
  assert.deepEqual(sorted([...real], (a, b) => compareWorksByCollected(a, b, 'newest')), ['seq-300', 'seq-200', 'seq-100'])
  assert.deepEqual(sorted([...real], (a, b) => compareWorksByCollected(a, b, 'oldest')), ['seq-100', 'seq-200', 'seq-300'])
})

test('媒体不可用的作品在收藏排序下也排在最后', () => {
  const available = work('ok', { collected: 100, updated: Date.parse('2025-01-01T00:00:00.000Z') })
  const dead = work('dead', { collected: 999, updated: Date.parse('2025-06-01T00:00:00.000Z'), unavailable: true })
  assert.deepEqual(sorted([dead, available], (a, b) => compareWorksByCollected(a, b, 'newest')), ['ok', 'dead'])
  assert.deepEqual(sorted([dead, available], (a, b) => compareWorksByCollected(a, b, 'oldest')), ['ok', 'dead'])
})

test('hasCollectedSequence 只认可真实收藏序号', () => {
  assert.equal(hasCollectedSequence({ collected: 20_455_163_341, updated: Date.parse('2025-01-01T00:00:00.000Z') }), true)
  assert.equal(hasCollectedSequence({ collected: 23, updated: Date.parse('2025-01-01T00:00:00.000Z') }), true)
  assert.equal(hasCollectedSequence({ collected: 0, updated: 1_790_000_000_000 }), false, '新扫描写 0')
  assert.equal(hasCollectedSequence({ collected: 1_790_000_000_000, updated: 1_790_000_000_000 }), false, '老库的 updated 兜底值')
  assert.equal(hasCollectedSequence({ collected: -1, updated: 1 }), false)
  assert.equal(hasCollectedSequence({ collected: Number.NaN, updated: 1 }), false)
  assert.equal(isUnavailableWork({ unavailable: true }), true)
  assert.equal(isUnavailableWork({}), false)
})
