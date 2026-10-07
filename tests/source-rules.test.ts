import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, rename } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { sandbox, validateRules, normalizeMetadata } from '../server/source-sandbox.js'
import { collectGroups, extractGroup, groupWorkId, groupStamp, readSnapshot, isWithin, previewSource } from '../server/source-engine.js'
import { customRules, sourcePreset } from '../shared/source-presets.js'
import type { Source, ScriptInput } from '../shared/types.js'

const input: ScriptInput = { id: '12', directory: '', media: [], files: [] }
const execute = (script: string, value = input) => sandbox<any>({ type: 'extract', rules: { ...customRules(), script }, input: value })
const match = (pattern: string, names: string[], mode: 'template' | 'regex' = 'template') => sandbox<any[]>({ type: 'match', rules: { ...customRules(), metadata: [], media: { mode, pattern, caseSensitive: false } }, names })

test('规则模板、命名捕获、转义、完整匹配和数字页码', async () => {
  const names = ['12_p10.JPG', '12.png', '12_p2.jpg.exe']
  const template = await match('{id}[_p{page}].{ext}', names)
  const regex = await match('(?<id>.+?)(?:_p(?<page>\\d+))?\\.(?<ext>[A-Za-z0-9]+)', names, 'regex')
  assert.deepEqual(template, regex)
  assert.equal(template[0].captures.page, '10')
  assert.equal(template[1].captures.id, '12')
  assert.equal((await match('\\[{id}\\].jpg', ['[abc].jpg']))[0].captures.id, 'abc')
  assert.equal((await match('{id}_{artist}.png', ['12_painter.png']))[0].captures.artist, 'painter')
  assert.equal((await match('(?<id>\\d+)\\.jpg', ['prefix12.jpg'], 'regex'))[0], null)
  await assert.rejects(validateRules({ ...customRules(), media: { mode: 'template', pattern: '{id}[', caseSensitive: false } }), /括号/)
  await assert.rejects(validateRules({ ...customRules(), media: { mode: 'regex', pattern: '(?<id>[', caseSensitive: false } }))
  await assert.rejects(validateRules({ ...customRules(), media: { mode: 'template', pattern: '{page}.jpg', caseSensitive: false } }), /id/)
  await assert.rejects(validateRules({ ...customRules(), script: 'export async function extract( {' }))
})

test('沙箱：无宿主能力、输入冻结、每次运行隔离、模块不可导入', async () => {
  const result = await execute(`export async function extract(input) {
    const denied = ['process','require','fetch','XMLHttpRequest','WebSocket','setTimeout','Deno','Bun'];
    if (denied.some(key => typeof globalThis[key] !== 'undefined')) throw Error('host capability');
    if (!Object.isFrozen(input) || !Object.isFrozen(input.files)) throw Error('mutable');
    try { input.files.push({}); throw Error('mutation succeeded'); } catch (e) { if (e.message === 'mutation succeeded') throw e; }
    globalThis.shared = 123;
    return { title: await Promise.resolve(input.id) };
  }`)
  assert.equal(result.title, '12')
  assert.equal((await execute(`export async function extract() { return {title: String(globalThis.shared)} }`)).title, 'undefined')
  for (const code of [
    `import fs from 'node:fs'; export async function extract() { return {} }`,
    `export async function extract() { await import('https://example.com/x.js'); return {} }`,
    `export async function extract() { return Function('return process')() }`,
    `export async function extract(input) { input.id = 'changed'; return {} }`,
  ]) await assert.rejects(execute(code))
})

test('沙箱：循环、递归、微任务、Promise、输出和内存限制；失败后恢复', async () => {
  for (const script of [
    `export async function extract() { while(true) {} }`,
    `export async function extract() { const f = () => f(); return f() }`,
    `export async function extract() { while(true) await Promise.resolve(); }`,
    `export async function extract() { return new Promise(() => {}) }`,
    `export async function extract() { return {description: 'x'.repeat(300000)} }`,
    `export async function extract() { const x=[]; while(true) x.push(new Array(100000).fill('xxxxxxxx')); }`,
    `export async function extract() { return { get title() { while(true) {} } } }`,
  ]) {
    await assert.rejects(execute(script))
    assert.equal((await execute(`export async function extract() { return {title:'recovered'} }`)).title, 'recovered')
  }
  const start = Date.now()
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 100)
  await assert.rejects(match('(?<id>(a+)+)b', ['a'.repeat(100) + '!'], 'regex'), /超时/)
  clearTimeout(timer)
  assert.equal(heartbeat, true, 'regex must not block the server event loop')
  assert.ok(Date.now() - start < 10000)
  assert.equal((await match('{id}.txt', ['ok.txt']))[0].captures.id, 'ok')
})

test('返回字段验证与白名单', async () => {
  assert.deepEqual(normalizeMetadata({ title: ' hi ', tags: ['#tag','tag',' '], extra: 'ignored' }).tags, ['tag'])
  for (const result of [[], null, {tags:[1]}, {title:42}, {date:'bad'}, {originalUrl:'javascript:alert(1)'}, {title:'x'.repeat(2001)}]) assert.throws(() => normalizeMetadata(result))
  assert.deepEqual(await execute(`export async function extract() {return {title:'ok',secret:'not returned'}}`), {title:'ok'})
})

test('引擎：元文件快照、分组范围、匹配白名单、路径与预览', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-rules-'))
  try {
    const folder = path.join(root, 'media'), outside = path.join(root, 'outside')
    await mkdir(folder); await mkdir(outside)
    await mkdir(path.join(folder, 'a')); await mkdir(path.join(folder, 'b'))
    for (const directory of ['a','b']) {
      await writeFile(path.join(folder, directory, '12_p0.jpg'), 'image')
      await writeFile(path.join(folder, directory, '12.json'), JSON.stringify({title:directory}))
    }
    await writeFile(path.join(folder,'unmatched.secret'), 'DO NOT EXPOSE')
    await writeFile(path.join(outside,'12.json'), '{"title":"outside"}')
    const source: Source = { id:'s', name:'test', path: folder, kind:'custom', rules:customRules() }
    let collected = await collectGroups(source)
    assert.equal(collected.groups.length, 1)
    assert.equal(collected.groups[0].entries.length, 4)
    const group = collected.groups[0]
    assert.equal(groupWorkId(source, group), 's:12')
    source.rules!.script = `export async function extract(input) {
      if (input.files.length !== 2 || input.media.length !== 2) throw Error('wrong files');
      if (JSON.stringify(input).includes('DO NOT EXPOSE') || input.files.some(f => 'path' in f)) throw Error('leak');
      return { title: input.files.map(f => JSON.parse(f.text).title).join(',') };
    }`
    assert.equal((await extractGroup(source, group)).title, 'a,b')
    const stamp = groupStamp(source, group)
    source.rules!.script += '\n// changed'
    assert.notEqual(groupStamp(source, group), stamp)
    source.rules!.scope = 'directory'
    collected = await collectGroups(source)
    assert.equal(collected.groups.length, 2)
    assert.notEqual(groupWorkId(source, collected.groups[0]), groupWorkId(source, collected.groups[1]))
    source.rules!.script = 'export async function extract(input) {return JSON.parse(input.files[0].text)}'
    const preview = await previewSource(source)
    assert.equal(preview.groups[0].result?.title, 'a')
    const partial = await collectGroups(source, 1)
    assert.equal(partial.enumerated, 1); assert.equal(partial.truncated, true)
    const meta = collected.groups[0].entries.find(e => e.metadata)!
    await writeFile(meta.path, '{"title":"changed size"}')
    await assert.rejects(readSnapshot(folder, meta), /身份/)
    await assert.rejects(readSnapshot(folder, {...meta, path:path.join(outside,'12.json')}), /边界/)
    assert.equal(isWithin(folder, path.join(folder,'..','outside','12.json')), false)
    assert.equal(isWithin(folder, `${folder}-other/12.json`), false)
    await t.test('目录联接/符号链接不跟随', async st => {
      try { await symlink(outside, path.join(folder,'linked'), process.platform === 'win32' ? 'junction' : 'dir') }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { st.skip('OS disallows symlinks'); return } throw e }
      assert.equal((await collectGroups(source)).groups.length, 2)
      await assert.rejects(readSnapshot(folder, {...meta, path:path.join(folder,'linked','12.json')}), /链接|联接/)
    })
    await link(path.join(outside,'12.json'), path.join(folder,'12.json'))
    await writeFile(path.join(folder,'12.jpg'), 'image')
    collected = await collectGroups(source)
    const hardlinkGroup = collected.groups.find(g => g.directory === '')!
    await assert.rejects(extractGroup(source, hardlinkGroup), /硬链接/)
    await writeFile(path.join(folder,'bad_p99999999999999999999.jpg'), 'image')
    assert.ok((await collectGroups(source)).errors.some(e => e.includes('安全整数')))
  } finally { await rm(root, {recursive:true, force:true}) }
})

test('元文件数量、大小限制及多规则去重', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-rules-limits-'))
  try {
    const rules = customRules(); rules.metadata.push({...rules.metadata[0]})
    const source: Source = {id:'s',name:'limit',path:root,kind:'custom',rules}
    await writeFile(path.join(root,'12.jpg'),'image')
    await writeFile(path.join(root,'12.json'),'{"title":"ok"}')
    let group = (await collectGroups(source)).groups[0]
    assert.equal(group.entries.filter(e => e.metadata).length,1)
    await writeFile(path.join(root,'12.json'),' '.repeat(2*1024*1024+1))
    group = (await collectGroups(source)).groups[0]
    await assert.rejects(extractGroup(source,group), /2 MiB/)
    group.entries = [...group.entries.filter(e => !e.metadata), ...Array.from({length:65}, () => ({...group.entries.find(e => e.metadata)!,size:1}))]
    await assert.rejects(extractGroup(source,group), /64/)
    group.entries = group.entries.slice(0,7).map(e => e.metadata ? {...e,size:2*1024*1024} : e)
    await assert.rejects(extractGroup(source,group), /8 MiB/)
  } finally { await rm(root,{recursive:true,force:true}) }
})
