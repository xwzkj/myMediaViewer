import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { customRules, sourcePreset } from '../shared/source-presets.js'
import { ruleIssues, scriptIssues, issueLocation } from '../shared/source-diagnostics.js'
import { ruleSubject } from '../shared/file-rules.js'
import { collectGroups, extractGroup, previewSource } from '../server/source-engine.js'
import { sandbox, normalizeMetadata } from '../server/source-sandbox.js'
import { parseMetadata, parseJsonMetadata } from '../server/parsers.js'
import type { Source, FileRule } from '../shared/types.js'

test('规则和 JS 的诊断含错误位置；不执行用户内容', () => {
  const rule: FileRule = {mode:'template',pattern:'{id}[_p{page}',caseSensitive:false}
  const problems = ruleIssues(rule)
  assert.equal(problems[0].from,4)
  assert.match(issueLocation(rule.pattern,problems[0]), /第 1 行，第 5 列/)
  assert.match(ruleIssues({...rule,pattern:'{id}_{id}'})[0].message,/重复/)
  assert.match(ruleIssues({...rule,pattern:'{title}'})[0].message,/id/)
  assert.equal(ruleIssues({...rule,mode:'regex',pattern:'(?<id>(a+)+)b'}).length,0)
  assert.ok(ruleIssues({...rule,mode:'regex',pattern:'(?<id>['}).length)
  const code = 'export async function extract(input) {\n  return {title: };\n}'
  assert.match(issueLocation(code,scriptIssues(code)[0]),/第 2 行/)
  assert.equal(scriptIssues('export async function extract() { while(true){} }').length,0)
  assert.match(scriptIssues('export const wrong = 1')[0].message,/extract/)
  assert.match(scriptIssues('export async function extract() { await import("fs") }')[0].message,/禁止/)
})

test('路径匹配对象明确、旧规则默认文件名', () => {
  const rule: FileRule = {mode:'template',pattern:'{id}',caseSensitive:false}
  const relative = '画师A/123_夏日/0.jpg'
  assert.equal(ruleSubject(rule,relative),'0.jpg')
  assert.equal(ruleSubject({...rule,target:'relativePath'},relative),relative)
  assert.equal(ruleSubject({...rule,target:'directory'},relative),'画师A/123_夏日')
  assert.equal(ruleSubject({...rule,target:'directoryName'},relative),'123_夏日')
  assert.equal(ruleSubject({...rule,target:'directoryName'},'0.jpg'),'')
})

test('无需元文件：既可从相对路径捕获，也可在脚本中直接解析路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'media-path-rules-'))
  try {
    const folder = path.join(root,'画师A','123_夏日')
    await mkdir(folder,{recursive:true})
    await writeFile(path.join(folder,'0.jpg'),'image')
    const rules = customRules()
    rules.media = {mode:'template',target:'relativePath',pattern:'{author}/{id}_{title}/{page}.{ext}',caseSensitive:false}
    rules.metadata = []
    const source: Source = {id:'path',name:'test',path:root,kind:'custom',rules}
    let group = (await collectGroups(source)).groups[0]
    assert.equal(group.id,'123')
    assert.equal((await extractGroup(source,group)).title,'夏日')
    assert.equal((await extractGroup(source,group)).author,'画师A')
    assert.equal((await previewSource(source)).groups[0].captures?.[0].captures.title,'夏日')
    // No new rule syntax needed when only metadata, not grouping, comes from a directory.
    rules.media = {mode:'template',pattern:'{id}.{ext}',caseSensitive:false}
    rules.script = `export async function extract(input) {
      const file = input.media[0];
      const parts = file.relativePath.split('/');
      if (file.directory !== '画师A/123_夏日' || file.directoryName !== '123_夏日') throw Error('missing directory');
      return {author:parts[0],title:parts[1].split('_')[1]};
    }`
    group = (await collectGroups(source)).groups[0]
    assert.equal((await extractGroup(source,group)).title,'夏日')
    // Metadata matching independently uses the same source-relative path.
    await writeFile(path.join(folder,'info.json'),'{"title":"元文件标题"}')
    rules.media = {mode:'template',target:'directoryName',pattern:'{id}_{title}',caseSensitive:false}
    rules.metadata = [{mode:'template',target:'relativePath',pattern:'{author}/{id}_{title}/info.json',caseSensitive:false}]
    rules.script = customRules().script
    group = (await collectGroups(source)).groups[0]
    assert.equal(group.id,'123'); assert.equal(group.entries.length,2)
    assert.equal((await extractGroup(source,group)).title,'元文件标题')
    rules.script = 'export async function extract() {\n  throw Error("定位测试");\n}'
    await assert.rejects(extractGroup(source,group), /第 2 行.*定位测试/)
  } finally {await rm(root,{recursive:true,force:true})}
})

test('简化预设保留 JSON/TXT 合并、实体、翻译标签和日期回退', async () => {
  for (const kind of ['pixiv','telegram'] as const) {
    const json = JSON.stringify({idNum:12,title:'JSON 标题',user:'画师',description:'',tags:['#原标签'],tagsWithTransl:['翻译标签'],date:'2024-06-02',original:'https://example.com/image.zip'})
    const text = kind === 'pixiv' ? 'Title\nTXT 标题\n\nDescription\n第一段&#44;\n\n第二段\n\nTags\n#原标签\n#TXT标签\n' : 'TXT 标题\n\n第二段 #原标签 #TXT标签'
    const a = parseJsonMetadata(json,kind), b = parseMetadata(text,kind)
    const expected = {...a,tags:[...new Set([...a.tags,...b.tags])]}
    for (const key of ['title','author','description','date','originalUrl'] as const) expected[key] ||= b[key]
    const makeFile = (extension:string,text:string,modified=2) => ({filename:'meta.'+extension,relativePath:'meta.'+extension,extension,text,modified,size:text.length,captures:{}})
    const result = normalizeMetadata(await sandbox({type:'extract',rules:sourcePreset(kind),input:{id:kind==='pixiv'?'12':'12_202406',directory:'',media:[],files:[makeFile('txt',text),makeFile('json','{"title":"旧导出"}',1),makeFile('json',json)]}}))
    assert.deepEqual(result,expected)
    assert.ok(sourcePreset(kind).script.startsWith('//'))
    assert.ok(!sourcePreset(kind).script.includes("kind ==="),'preset must not contain the other source parser')
    assert.deepEqual(scriptIssues(sourcePreset(kind).script),[])
  }
})
