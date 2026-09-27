import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const root = await mkdtemp(path.join(os.tmpdir(), 'media-garden-bench-'))
process.env.MEDIA_DATA_DIR = root
const { db, saveSource } = await import('../server/database.js')
const { refreshSearch, searchWorks } = await import('../server/search.js')
const source = { id: 'benchmark', name: '性能样例', path: root, kind: 'pixiv' as const }
try {
  saveSource(source, Array.from({ length: 2500 }, (_, i) => ({
    id: `benchmark:${i}`, externalId: String(i), sourceId: source.id, sourceName: source.name, sourceKind: source.kind,
    title: `${['山间旅行', '夏日海边', 'Landscape', '花园来信', '林间散步'][i % 5]} ${i}`,
    author: `画家 ${i % 50}`, description: `第 ${i} 组作品。春天的山林，安静的湖水和自然风景。`.repeat(15),
    tags: ['自然', '插画', '旅行'], date: '2026-09-27', updated: 0, count: 1, kind: 'image' as const, coverId: '', originalUrl: '',
  })), [])
  const start = performance.now()
  refreshSearch()
  console.log(`2500 组模拟作品索引建立：${Math.round(performance.now() - start)} ms`)
  for (const [query, fuzzy] of [['山间 自然', false], ['shanji', false], ['landscpe', true]] as const) {
    const durations: number[] = []
    let count = 0
    for (let run = 0; run < 5; run++) {
      const started = performance.now()
      count = searchWorks(query, fuzzy).length
      durations.push(performance.now() - started)
    }
    durations.sort((a, b) => a - b)
    console.log(`${query}：${count} 条，5 次中位耗时 ${durations[2].toFixed(1)} ms`)
  }
} finally {
  db.close()
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('media-garden-bench-'))
  await rm(root, { recursive: true, force: true })
}
