import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {customRules,sourcePreset,isBlankSourceRules} from '../shared/source-presets.js'

test('AI 规则生成：受限目录树、复用设置、草稿配置、多轮内存上下文与输出校验', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'source-ai-test-'))
  process.env.MEDIA_DATA_DIR=path.join(root,'data')
  const folder=path.join(root,'media');await mkdir(folder)
  const {createApp}=await import('../server/app.js')
  const {db}=await import('../server/database.js')
  const {saveAiSettings}=await import('../server/ai.js')
  const {sourceTreeSample}=await import('../server/source-tree.js')
  const app=await createApp(false)
  const originalFetch=globalThis.fetch
  let calls:Array<{url:string;body:any;headers:Headers;signal:AbortSignal}>=[]
  let reply:unknown={rules:customRules(),explanation:'按 ID 分组'}
  const stub = () => {globalThis.fetch=(async(url,init)=>{
    calls.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers),signal:init!.signal as AbortSignal})
    return new Response(JSON.stringify({model:'test-response-model',choices:[{message:{content:JSON.stringify(reply)}}]}),{status:200,headers:{'content-type':'application/json'}})
  }) as typeof fetch}
  const settings=(outputMode='prompt')=>saveAiSettings({baseUrl:'https://ai.example.test/v1',apiKey:'test-private-token',model:'test-model',timeoutMs:5000,outputMode,appendPrompt:'翻译专用追加内容',params:{temperature:0.3,model:'wrong',messages:[],stream:true,response_format:{type:'bad'}}})
  try {
    await writeFile(path.join(folder,'作者_标题_123by456-p1.jpg'),'PRIVATE MEDIA CONTENT')
    await writeFile(path.join(folder,'123by456-p1.txt'),'PRIVATE METADATA CONTENT')
    await mkdir(path.join(folder,'作者目录'))
    await writeFile(path.join(folder,'作者目录','123_标题.jpg'),'x')
    const sourceConfig=await readFile(path.join(process.env.MEDIA_DATA_DIR,'sources.json'),'utf8')
    const sampleResponse=await app.inject({method:'POST',url:'/api/sources/ai/sample',payload:{path:folder}})
    assert.equal(sampleResponse.statusCode,200,sampleResponse.body)
    const sample=sampleResponse.json()
    assert.ok(sample.tree.includes('作者目录'))
    assert.ok(!sample.tree.includes(root));assert.ok(!sample.tree.includes('PRIVATE'))
    assert.ok(sample.lines<=200)
    settings();stub()
    const send=(message:string,extra:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/sources/ai/chat',payload:{sampleToken:sample.token,message,...extra}})
    const first=await send('按作品 ID 分组',{currentRules:customRules()})
    assert.equal(first.statusCode,200,first.body)
    const conversationId=first.json().conversationId
    assert.ok(conversationId);assert.equal(JSON.parse(calls[0].body.messages.at(-1).content).currentRules,undefined)
    assert.equal(calls[0].url,'https://ai.example.test/v1/chat/completions')
    assert.equal(calls[0].headers.get('Authorization'),'Bearer test-private-token')
    assert.equal(calls[0].body.model,'test-model');assert.equal(calls[0].body.stream,false)
    assert.equal(calls[0].body.temperature,0.3);assert.equal(calls[0].body.response_format,undefined)
    assert.ok(calls[0].signal instanceof AbortSignal)
    assert.ok(calls[0].body.messages[0].content.includes('非贪婪'))
    assert.ok(!calls[0].body.messages[0].content.includes('翻译专用追加内容'))
    assert.ok(!JSON.stringify(calls[0].body.messages).includes('test-private-token'))
    const draft=sourcePreset('pixiv');draft.script='export async function extract() { return {title: }; }' // User may ask AI to repair invalid drafts.
    reply={rules:sourcePreset('pixiv'),explanation:'修复脚本，并保留其他配置'}
    const second=await send('修复当前脚本',{conversationId,currentRules:draft})
    assert.equal(second.statusCode,200,second.body)
    const messages=calls.at(-1)!.body.messages
    assert.equal(messages.filter((m:any)=>m.role==='assistant').length,1)
    assert.ok(messages.some((m:any)=>m.content.includes('按作品 ID 分组')))
    assert.deepEqual(JSON.parse(messages.at(-1).content).currentRules,draft)
    const third=await send('改用文件名标题',{conversationId,currentRules:customRules()})
    assert.equal(third.statusCode,200,third.body)
    assert.equal(JSON.parse(calls.at(-1)!.body.messages.at(-1).content).currentRules,undefined)
    assert.ok(calls.at(-1)!.body.messages.some((m:any)=>m.role==='assistant' && m.content.includes('修复脚本')))
    assert.equal(await readFile(path.join(process.env.MEDIA_DATA_DIR,'sources.json'),'utf8'),sourceConfig)
    assert.equal((db.prepare('SELECT count(*) AS n FROM works').get() as {n:number}).n,0)
    assert.ok(!(await readdir(process.env.MEDIA_DATA_DIR)).some(n=>/conversation|chat|source-ai/.test(n)))
    for(const output of ['json_object','json_schema']) {
      settings(output);reply={rules:output==='json_schema'?JSON.stringify(customRules()):customRules(),explanation:'结构化结果'}
      assert.equal((await send('生成',{currentRules:customRules()})).statusCode,200)
      assert.equal(calls.at(-1)!.body.response_format.type,output)
    }
    settings()
    // Generation must not execute even the module's top-level code.
    reply={rules:{...customRules(),script:'throw Error("do not execute"); export async function extract() {return {}}'},explanation:'顶层代码'}
    assert.equal((await send('生成')).statusCode,200)
    for(const invalid of [{rules:{...customRules(),script:'export async function extract( {'}},{rules:{...customRules(),script:'import fs from "node:fs";export function extract(){}'}},{rules:{...customRules(),media:{mode:'template',pattern:'{title}',caseSensitive:false}}}]) {
      reply=invalid;const bad=await send('错误结果测试',{conversationId});assert.equal(bad.statusCode,502,bad.body)
    }
    await app.inject({method:'DELETE',url:`/api/sources/ai/chat/${conversationId}`})
    assert.equal((await send('继续',{conversationId})).statusCode,410)
    assert.equal((await app.inject({method:'POST',url:'/api/sources/ai/sample',payload:{path:'relative/path'}})).statusCode,400)
    await t.test('目录树截断与联接排除',async()=>{
      const lots=path.join(root,'many');await mkdir(lots)
      await Promise.all(Array.from({length:220},(_,i)=>writeFile(path.join(lots,`${i}.jpg`),'x')))
      const big=await sourceTreeSample(lots)
      assert.ok(big.lines<=200);assert.ok(big.truncated);assert.match(big.tree,/\.\.\./)
      assert.ok(Buffer.byteLength(big.tree)<=24*1024)
      const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'SECRET-NAME.jpg'),'x')
      await symlink(outside,path.join(folder,'linked'),process.platform==='win32'?'junction':'dir')
      const safe=await sourceTreeSample(folder);assert.ok(!safe.tree.includes('SECRET-NAME'));assert.ok(!safe.tree.includes('linked'))
    })
    assert.equal(isBlankSourceRules(customRules()),true)
    assert.equal(isBlankSourceRules({...customRules(),scope:'directory'}),false)
  }finally{globalThis.fetch=originalFetch;await app.close();db.close();await rm(root,{recursive:true,force:true})}
})

test('分组预览不运行脚本；点击时只计算选中组且不写缓存', async()=>{
  // Engine-only test can share the already initialized modules; no database calls are made.
  const root=await mkdtemp(path.join(tmpdir(),'preview-lazy-'))
  const {previewSource,calculatePreviewGroup}=await import('../server/source-engine.js')
  const {validateRules}=await import('../server/source-sandbox.js')
  try{
    await writeFile(path.join(root,'good.jpg'),'x');await writeFile(path.join(root,'bad.jpg'),'x')
    const rules={...customRules(),script:'export async function extract(input) {if(input.id === "bad") throw Error("bad group executed");return {title:input.id}}'}
    const source={id:'preview',name:'test',path:root,kind:'custom' as const,rules}
    const preview=await previewSource(source)
    assert.equal(preview.groups.length,2)
    assert.ok(preview.groups.every(g=>g.result===undefined && g.error===undefined))
    const good=preview.groups.findIndex(g=>g.id==='good'),bad=preview.groups.findIndex(g=>g.id==='bad')
    assert.equal((await calculatePreviewGroup(preview.token!,good)).title,'good')
    await assert.rejects(calculatePreviewGroup(preview.token!,bad),/bad group executed/)
    await assert.rejects(calculatePreviewGroup('missing',0),/过期/)
    await assert.rejects(calculatePreviewGroup(preview.token!,42),/不存在/)
    // Syntax-only validation must not execute top-level code either.
    await validateRules({...rules,script:'throw Error("top level");export function extract(){return {}}'},true)
    const latest={...rules,script:'export async function extract(input){return JSON.parse(input.files[0].text)}'}
    await writeFile(path.join(root,'good.json'),'{"title":"before"}')
    const snapshot=await previewSource({...source,rules:latest})
    await writeFile(path.join(root,'good.json'),'{"title":"changed after preview"}')
    await assert.rejects(calculatePreviewGroup(snapshot.token!,snapshot.groups.findIndex(g=>g.id==='good')),/变化/)
  }finally{await rm(root,{recursive:true,force:true})}
})
