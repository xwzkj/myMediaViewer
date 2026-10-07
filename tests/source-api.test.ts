import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { customRules } from '../shared/source-presets.js'

test('来源迁移、预览只读、分组缓存失效和失败降级', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-api-'))
  const data = path.join(root, 'data'), media = path.join(root, 'media')
  await mkdir(data); await mkdir(media)
  const legacy = [{ id:'legacy',name:'旧插画',path:media,kind:'pixiv' }]
  await writeFile(path.join(data,'sources.json'),JSON.stringify(legacy))
  await writeFile(path.join(media,'100-12_p0.jpg'),'image')
  await writeFile(path.join(media,'100-12-meta.txt'),'Title\n旧标题\n')
  process.env.MEDIA_DATA_DIR = data
  const { createApp } = await import('../server/app.js')
  const { scanLibrary, scanStatus } = await import('../server/scanner.js')
  const { db, setFavorite } = await import('../server/database.js')
  const { sources } = await import('../server/config.js')
  const app = await createApp(false)
  const wait = async () => {
    for(let i=0; i<1000 && scanStatus.running; i++) await new Promise(r => setTimeout(r,10))
    assert.equal(scanStatus.running,false)
  }
  try {
    assert.deepEqual(JSON.parse(await readFile(path.join(data,'sources.json.legacy.bak'),'utf8')),legacy)
    assert.equal(sources[0].rules?.preset,'pixiv')
    await scanLibrary()
    const legacyId = 'legacy:12'
    setFavorite(legacyId,true)
    const before = (await app.inject(`/api/works/${encodeURIComponent(legacyId)}`)).json()
    await scanLibrary()
    const after = (await app.inject(`/api/works/${encodeURIComponent(legacyId)}`)).json()
    assert.equal(after.favorite,true)
    assert.equal(after.assets[0].id,before.assets[0].id)
    const saved = await readFile(path.join(data,'sources.json'),'utf8')
    const migrationCheck = spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./server/config.ts')"],{cwd:process.cwd(),env:{...process.env,MEDIA_DATA_DIR:data},encoding:'utf8'})
    assert.equal(migrationCheck.status,0,migrationCheck.stderr)
    assert.equal(await readFile(path.join(data,'sources.json'),'utf8'),saved)
    const presets = await app.inject('/api/source-presets')
    assert.equal(presets.json().length,2)
    const rules = customRules()
    rules.media.pattern = '{id}_{name}.{ext}'
    rules.metadata = [{mode:'template',pattern:'{id}.json',caseSensitive:false}]
    rules.script = 'export async function extract(input) { return {title: input.files.length ? JSON.parse(input.files[0].text).title : "no meta", description: input.media.map(f => f.filename).join(",")}; }'
    const folder = path.join(root,'custom'); await mkdir(folder)
    await writeFile(path.join(folder,'a_10.jpg'),'image')
    await writeFile(path.join(folder,'a_2.jpg'),'image')
    await writeFile(path.join(folder,'a.json'),'{"title":"first"}')
    const body = {name:'自定义',path:folder,rules}
    const count = (db.prepare('SELECT count(*) AS n FROM works').get() as {n:number}).n
    const preview = await app.inject({method:'POST',url:'/api/sources/preview',payload:body})
    assert.equal(preview.statusCode,200,preview.body)
    assert.equal(preview.json().groups[0].result,undefined)
    const calculated = await app.inject({method:'POST',url:'/api/sources/preview/calculate',payload:{token:preview.json().token,index:0}})
    assert.equal(calculated.statusCode,200,calculated.body)
    assert.equal(calculated.json().result.title,'first')
    assert.equal((db.prepare('SELECT count(*) AS n FROM works').get() as {n:number}).n,count)
    assert.equal(await readFile(path.join(data,'sources.json'),'utf8'),saved)
    const legacyBefore = db.prepare('SELECT data FROM works WHERE id = ?').get(legacyId)
    await writeFile(path.join(media,'100-12-meta.txt'),'Title\n未整理的新标题\n')
    const added = await app.inject({method:'POST',url:'/api/sources',payload:body})
    assert.equal(added.statusCode,201,added.body); await wait()
    assert.deepEqual(db.prepare('SELECT data FROM works WHERE id = ?').get(legacyId),legacyBefore, '添加来源不能扫描其他来源')
    assert.equal(scanStatus.works,1)
    await writeFile(path.join(media,'100-12-meta.txt'),'Title\n旧标题\n')
    const id = added.json().id
    const get = async () => (await app.inject(`/api/works/${encodeURIComponent(`${id}:a`)}`)).json()
    assert.equal((await get()).title,'first')
    assert.deepEqual((await get()).assets.map((a:{filename:string}) => a.filename),['a_2.jpg','a_10.jpg'])
    assert.equal((await get()).count,2)
    const cacheCount = () => (db.prepare('SELECT count(*) AS n FROM group_metadata_cache').get() as {n:number}).n
    const cacheBefore = cacheCount()
    await writeFile(path.join(folder,'a.json'),'{"title":"changed"}')
    await scanLibrary(); assert.equal((await get()).title,'changed'); assert.equal(cacheCount(),cacheBefore)
    await unlink(path.join(folder,'a.json')); await scanLibrary(); assert.equal((await get()).title,'no meta')
    rules.script = 'export async function extract() { return {title:"script changed"} }'
    await writeFile(path.join(media,'100-12-meta.txt'),'Title\n不应被此次编辑读取\n')
    const update = await app.inject({method:'PUT',url:`/api/sources/${id}`,payload:body})
    assert.equal(update.statusCode,200,update.body); await wait()
    assert.equal((await get()).title,'script changed')
    assert.equal((await app.inject(`/api/works/${encodeURIComponent(legacyId)}`)).json().title,'旧标题')
    await writeFile(path.join(media,'100-12-meta.txt'),'Title\n旧标题\n')
    rules.script = 'export async function extract() { throw Error("group error") }'
    assert.equal((await app.inject({method:'PUT',url:`/api/sources/${id}`,payload:body})).statusCode,200)
    await wait(); assert.ok(scanStatus.errors.some(e=>e.includes('group error')))
    assert.equal((await get()).title,'自定义 · a'); assert.equal((await get()).count,2)
    assert.equal((await app.inject(`/api/works/${encodeURIComponent(legacyId)}`)).json().title,'旧标题')
    const moved = `${folder}-offline`; await rename(folder,moved)
    await scanLibrary(); assert.equal((await get()).count,2)
    await rename(moved,folder)
    const invalid = {...body,rules:{...rules,script:'export const wrong = 1'}}
    assert.equal((await app.inject({method:'PUT',url:`/api/sources/${id}`,payload:invalid})).statusCode,400)
    assert.equal((await app.inject({method:'PUT',url:`/api/sources/${id}`,payload:{...body,rules:{...rules,script:'import fs from "node:fs"; export function extract() {}'}}})).statusCode,400)
  } finally { await wait(); await app.close(); db.close(); await rm(root,{recursive:true,force:true}) }
})
