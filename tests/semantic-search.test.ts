import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { SemanticStore } from '../server/semantic/store.js'
import { normalizeVector, encodeVector, decodeVector, cosineSimilarity } from '../server/semantic/vectors.js'
import { LocalClipProvider, type SemanticProvider } from '../server/semantic/provider.js'
import type { StoredAsset } from '../server/database.js'

const vector = (x = 1, y = 0) => [x, y, ...Array(510).fill(0)] as number[]
const asset = (id: string, workId = 'a'): StoredAsset => ({ id, workId, path: `/${id}.png`, filename: `${id}.png`, page: 0, kind: 'image', extension: 'png', size: 10, modified: 100, display: true })
const schema = `CREATE TABLE works (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE assets (id TEXT PRIMARY KEY, work_id TEXT, data TEXT);
CREATE TABLE semantic_embeddings (asset_id TEXT, model TEXT, fingerprint TEXT, dimensions INTEGER CHECK(dimensions=512), vector BLOB CHECK(length(vector)=2048), created INTEGER, PRIMARY KEY(asset_id,model));`
function add(db: DatabaseSync, value: StoredAsset) {
  db.prepare('INSERT OR IGNORE INTO works VALUES (?, ?)').run(value.workId, '{}')
  db.prepare('INSERT OR REPLACE INTO assets VALUES (?, ?, ?)').run(value.id, value.workId, JSON.stringify(value))
}

test('vectors validate finite 512 dimensions, normalize huge values and persist Float32', () => {
  for (const bad of [[], Array(512).fill(0), [...Array(511).fill(0), NaN], [...Array(511).fill(0), Infinity], [...Array(511).fill(0), '1']]) assert.throws(() => normalizeVector(bad as number[]))
  const normalized = normalizeVector(vector(3, 4))
  assert.ok(Math.abs(normalized[0] - 0.6) < 1e-7)
  assert.equal(encodeVector(vector()).length, 2048)
  assert.ok(cosineSimilarity(normalized, decodeVector(encodeVector(vector(3, 4)))) > 0.999999)
  assert.ok(normalizeVector(vector(Number.MAX_VALUE, Number.MAX_VALUE)).every(Number.isFinite))
  assert.throws(() => decodeVector(new Uint8Array(12)))
})

test('persistent cosine rank aggregates max image, isolates models and skips stale/deleted rows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-store-'))
  const file = path.join(root, 'vectors.sqlite')
  let db = new DatabaseSync(file)
  try {
    db.exec(schema)
    let store = new SemanticStore(db)
    const a = asset('a1'), a2 = asset('a2'), b = asset('b1', 'b'), c = asset('c1', 'c')
    for (const item of [a, a2, b, c]) add(db, item)
    store.put(a, 'model-1', vector(0, 1)); store.put(a2, 'model-1', vector(1, 0))
    store.put(b, 'model-1', vector(0.5, 0.5)); store.put(c, 'model-2', vector())
    assert.equal(store.has(a, 'model-1'), true)
    db.close(); db = new DatabaseSync(file); store = new SemanticStore(db)
    const ranked = await store.rank(vector(), 'model-1')
    assert.deepEqual(ranked.map(row => [row.workId, row.assetId]), [['a', 'a2'], ['b', 'b1']])
    assert.equal(ranked[0].score, 1)
    assert.deepEqual(await store.counts('model-1'), { indexedAssets: 3, indexedWorks: 2 })
    assert.deepEqual((await store.rank(vector(), 'model-1', new Set(['b']))).map(row => row.workId), ['b'])
    assert.deepEqual(await store.rank(vector(), 'missing-model'), [])
    assert.equal((await store.rank(vector(), 'model-1', undefined, 0.9)).length, 1)
    add(db, { ...a2, modified: 101 }); assert.equal(store.has({ ...a2, modified: 101 }, 'model-1'), false)
    assert.equal((await store.rank(vector(), 'model-1'))[0].workId, 'b')
    db.prepare('DELETE FROM assets WHERE id=?').run(b.id)
    assert.deepEqual(await store.counts('model-1'), { indexedAssets: 1, indexedWorks: 1 })
    db.prepare('DELETE FROM works WHERE id=?').run(a.workId)
    assert.deepEqual(await store.rank(vector(), 'model-1'), [])
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test('ties are deterministic and corrupt cached vectors never produce fake scores', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(schema)
  try {
    const store = new SemanticStore(db)
    for (const item of [asset('z', 'b'), asset('z2', 'a'), asset('a1', 'a')]) { add(db, item); store.put(item, 'model', vector()) }
    assert.deepEqual((await store.rank(vector(), 'model')).map(row => [row.workId, row.assetId]), [['a', 'a1'], ['b', 'z']])
    db.prepare('UPDATE semantic_embeddings SET vector=? WHERE asset_id=?').run(Buffer.alloc(2048), 'a1')
    assert.equal((await store.rank(vector(), 'model'))[0].assetId, 'z2')
    store.invalidate('z2'); assert.equal((await store.rank(vector(), 'model')).length, 1)
  } finally { db.close() }
})

test('local encoder without models is explicitly unavailable and never fabricates a vector', async () => {
  const provider = new LocalClipProvider({ directory: null })
  assert.equal((await provider.status()).ready, false)
  await assert.rejects(provider.embedText('a cat'), { code: 'semantic_unavailable', statusCode: 503 })
  await assert.rejects(provider.embedImage(Buffer.from('not an image')), { code: 'semantic_unavailable' })
})

test('semantic APIs preserve lexical mode, filters, scores and error semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-api-'))
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  const { createApp } = await import('../server/app.js')
  const { db, saveSource } = await import('../server/database.js')
  const { sources } = await import('../server/config.js')
  const directory = path.join(root, 'images'); await mkdir(directory)
  const imagePath = path.join(directory, 'a.png')
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#777777' } }).png().toFile(imagePath)
  const fileStat = await stat(imagePath)
  const source = { id: 'semantic-test', name: 'Semantic', kind: 'custom' as const, path: directory }
  sources.push(source)
  const works = ['a', 'b'].map((id, i) => ({ id: `semantic-test:${id}`, sourceId: source.id, sourceName: source.name, sourceKind: source.kind, externalId: id, title: i ? 'Other' : '猫', author: '', description: '', tags: [], date: '', collected: 0, updated: 1, count: 1, kind: 'image' as const, coverId: id, originalUrl: '' }))
  const assets = works.map((work, i) => ({ ...asset(i ? 'b' : 'a', work.id), path: imagePath, size: fileStat.size, modified: fileStat.mtimeMs }))
  saveSource(source, works, assets)
  let textCalls = 0, imageCalls = 0
  const provider: SemanticProvider = { status: async () => ({ ready: true, provider: 'local', model: 'test-clip-model', dimensions: 512 }), embedText: async () => { textCalls++; return normalizeVector(vector()) }, embedImage: async () => { imageCalls++; return normalizeVector(vector()) } }
  const app = await createApp(false, provider)
  let unavailableApp: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const call = (url: string) => app.inject({ url })
    const imported = await app.inject({ method: 'PUT', url: '/api/semantic/assets/b/vector', payload: { model: 'test-clip-model', vector: vector(0.5, 0.5), size: fileStat.size, modified: fileStat.mtimeMs } })
    assert.equal(imported.statusCode, 200, imported.body)
    const indexed = await app.inject({ method: 'POST', url: '/api/semantic/assets/a/index' })
    assert.equal(indexed.statusCode, 200, indexed.body); assert.equal(imageCalls, 1)
    assert.equal((await app.inject({ method: 'POST', url: '/api/semantic/assets/a/index' })).json().reason, 'cached')
    assert.equal(imageCalls, 1)
    const lexical = await call('/api/works?q=' + encodeURIComponent('猫'))
    assert.equal(lexical.json().total, 1); assert.equal(textCalls, 0)
    const semantic = await call('/api/works?semantic=true&q=a%20cat')
    assert.equal(semantic.statusCode, 200, semantic.body)
    assert.deepEqual(semantic.json().items.map((work: { id: string }) => work.id), works.map(work => work.id))
    assert.equal(semantic.json().items[0].semanticScore, 1)
    assert.equal((await call('/api/works?semantic=true&q=cat&kind=video')).json().total, 0)
    assert.equal((await call('/api/works?semantic=true&q=cat&favorites=true')).json().total, 0)
    assert.equal((await call('/api/works?semantic=true&q=')).statusCode, 400)
    const status = (await call('/api/semantic/status')).json()
    assert.equal(status.indexedAssets, 2); assert.equal(status.indexedWorks, 2)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/semantic/assets/a/vector', payload: { model: 'test-clip-model', vector: vector(), size: 1, modified: 1 } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: '/api/semantic/search', payload: { model: 'test-clip-model', vector: Array(512).fill(0) } })).statusCode, 400)
    const ranked = await app.inject({ method: 'POST', url: '/api/semantic/search', payload: { model: 'test-clip-model', vector: vector(), page: 999, minScore: 0.9 } })
    assert.equal(ranked.json().total, 1); assert.equal(ranked.json().page, 1)
    const denied = await app.inject({ method: 'DELETE', url: '/api/semantic/assets/a/vector', headers: { origin: 'https://other.invalid' } })
    assert.equal(denied.statusCode, 403)
    unavailableApp = await createApp(false, new LocalClipProvider({ directory: null }))
    const missing = await unavailableApp.inject({ url: '/api/works?semantic=true&q=cat' })
    assert.equal(missing.statusCode, 503); assert.equal(missing.json().code, 'semantic_unavailable'); assert.equal(missing.json().items, undefined)
    const emptyProvider = { ...provider, status: async () => ({ ready: true, provider: 'local' as const, model: 'another-model', dimensions: 512 as const }) }
    const { searchSemanticWorks } = await import('../server/semantic/service.js')
    await assert.rejects(searchSemanticWorks('cat', [], emptyProvider), { code: 'semantic_index_empty' })
    await writeFile(imagePath, Buffer.from('changed'))
    assert.equal((await app.inject({ method: 'POST', url: '/api/semantic/assets/a/index' })).statusCode, 409)
    const ui = await readFile(new URL('../src/views/LibraryView.vue', import.meta.url), 'utf8')
    assert.ok(ui.includes("params.set('semantic', 'true')")); assert.ok(ui.includes('toggleSemantic')); assert.ok(ui.includes('切换关键词搜索'))
  } finally { await app.close(); await unavailableApp?.close(); db.close(); await rm(root, { recursive: true, force: true }) }
})
