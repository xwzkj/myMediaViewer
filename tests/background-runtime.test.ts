import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {customRules} from '../shared/source-presets.js'
import {normalizeSourceBackground} from '../shared/background.js'

async function waitFor(check:()=>boolean,label:string,timeout=3000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline) {
    if(check()) return
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.fail(`等待超时：${label}`)
}

test('background scheduler yields to manual jobs and charges every attempted request',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'background-runtime-')), media=path.join(root,'media')
  await mkdir(media); await writeFile(path.join(media,'1.jpg'),'test')
  process.env.MEDIA_DATA_DIR=path.join(root,'data')
  const {saveSources}=await import('../server/config.js')
  const {saveAiSettings,getAiSettings}=await import('../server/ai.js')
  const {db}=await import('../server/database.js')
  const {scanLibrary}=await import('../server/scanner.js')
  const service=await import('../server/background/service.js')
  saveSources([{id:'s',name:'Test',kind:'custom',path:media,rules:customRules()}])
  saveAiSettings({...getAiSettings(),apiKey:'test',model:'test'})
  try {
    await scanLibrary()
    const settings={...normalizeSourceBackground(undefined),autoTranslate:true,localDutyPercent:100,maxTranslationRequestsPerDay:1}
    const token=service.createTranslationConfirmation('s',settings).token
    service.saveBackgroundSettings('s',settings,token);await service.synchronizeBackground()
    let manual=true,calls=0
    const runtime={manga:{hasManualMangaWork:()=>manual,runBackgroundMangaAsset:async (_asset:unknown,options:{beforeTranslate?:()=>void})=>{
      calls++; options.beforeTranslate?.(); options.beforeTranslate?.(); return undefined
    }}}
    await service.runBackgroundTick(runtime)
    await new Promise(resolve=>setTimeout(resolve,30))
    assert.equal(calls,0); assert.equal(service.backgroundQueue.usage('s').pages,0)
    manual=false
    await service.runBackgroundTick(runtime)
    await waitFor(()=>calls===1,'后台任务开始')
    await waitFor(()=>service.backgroundQueue.usage('s').requests===1,'翻译请求预留一次')
    await waitFor(()=>service.backgroundQueue.counts('s').failed===1,'可能计费的中断任务不再自动重试')
    service.controlBackground('s','retry');await service.synchronizeBackground()
    saveAiSettings({...getAiSettings(),model:'changed'})
    await service.synchronizeBackground()
    await service.runBackgroundTick(runtime)
    await waitFor(()=>service.backgroundQueue.counts('s').queued===1,'配置变化后任务回到队列')
    assert.equal(calls,1,'configuration changed after enqueue must prevent a paid request')
    const ocr={...settings,autoTranslate:false,ocr:true}
    service.saveBackgroundSettings('s',ocr);await service.synchronizeBackground()
    let enter!:()=>void,release!:()=>void
    const entered=new Promise<void>(r=>enter=r),blocked=new Promise<void>(r=>release=r)
    await service.runBackgroundTick({manga:{hasManualMangaWork:()=>false,runBackgroundMangaAsset:async (_asset,options)=>{enter();await blocked; options.signal?.throwIfAborted();return undefined}}})
    await entered
    service.controlBackground('s','pause');release()
    await waitFor(()=>service.backgroundQueue.control('s').state==='paused' && service.backgroundQueue.counts('s').queued===1,'暂停后任务让出')
    assert.equal(service.backgroundQueue.control('s').state,'paused')
    assert.equal(service.backgroundQueue.counts('s').queued,1)
    service.controlBackground('s','stop');assert.equal(service.backgroundQueue.counts('s').stopped,1)
  } finally { await service.synchronizeBackground();service.stopBackgroundRuntime();db.close();await rm(root,{recursive:true,force:true}) }
})
