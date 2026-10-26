import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

test('筛选记忆由服务端持久化：本地搜索语义开关、云搜索与推荐来源', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'media-garden-state-'))
  process.env.MEDIA_DATA_DIR = path.join(root, 'database')
  const { createApp } = await import('../server/app.js')
  const app = await createApp(false)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })

  const initial = await app.inject('/api/library-state')
  assert.equal(initial.statusCode, 200)
  assert.equal(initial.json().localSearch.semantic, false)
  assert.equal(initial.json().recommendation.source, 'local')

  const put = await app.inject({
    method: 'PUT',
    url: '/api/library-state/localSearch',
    payload: { source: '', kind: 'image', fuzzy: false, semantic: true, sort: 'relevance', order: 'published', seed: 's1' },
  })
  assert.equal(put.statusCode, 200)
  assert.equal(put.json().state.semantic, true)

  // 非法字段被归一化，而不是原样落库。
  const normalized = await app.inject({
    method: 'PUT',
    url: '/api/library-state/works',
    payload: { view: 'hacked', fuzzy: 'yes', sort: 'bogus', source: 'pixiv:private' },
  })
  assert.equal(normalized.statusCode, 200)
  assert.deepEqual(normalized.json().state, { view: 'library', source: '', kind: '', fuzzy: false, sort: 'newest', order: 'collected', seed: '' })

  const recommendation = await app.inject({ method: 'PUT', url: '/api/library-state/recommendation', payload: { source: 'cloud' } })
  assert.equal(recommendation.statusCode, 200)

  const read = await app.inject('/api/library-state')
  assert.equal(read.json().localSearch.semantic, true)
  assert.equal(read.json().recommendation.source, 'cloud')

  const unknown = await app.inject({ method: 'PUT', url: '/api/library-state/not-a-scope', payload: {} })
  assert.equal(unknown.statusCode, 400)

  // 直接检查 SQLite：记忆确实落盘，而不是只留在接口进程内存里。
  const { DatabaseSync } = await import('node:sqlite')
  const check = new DatabaseSync(path.join(root, 'database', 'library.sqlite'))
  const row = check.prepare("SELECT data FROM library_state WHERE scope = 'localSearch'").get() as { data: string } | undefined
  assert.equal(JSON.parse(row!.data).semantic, true)
  check.close()
})
