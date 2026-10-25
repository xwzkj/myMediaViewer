import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { customRules } from '../shared/source-presets.js'
import { normalizeSourceBackground } from '../shared/background.js'

test('background API requires bound cost confirmation and preserves source settings',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'background-api-')), media=path.join(root,'media')
  await mkdir(media); await writeFile(path.join(media,'1.jpg'),'test')
  process.env.MEDIA_DATA_DIR=path.join(root,'data')
  const {saveSources,sources}=await import('../server/config.js')
  const {saveAiSettings,getAiSettings}=await import('../server/ai.js')
  const {createApp}=await import('../server/app.js')
  const {db}=await import('../server/database.js')
  const service=await import('../server/background/service.js')
  const {scanLibrary,scanStatus}=await import('../server/scanner.js')
  saveSources([{id:'source',name:'Test',kind:'custom',path:media,rules:customRules()}])
  const app=await createApp(false)
  const save=(settings:unknown,confirmationToken?:string)=>app.inject({method:'PUT',url:'/api/sources/source/background',payload:{settings,confirmationToken}})
  try {
    assert.equal((await app.inject('/api/background/status')).json().sources[0].settings.autoTranslate,false)
    assert.equal(await service.countSourceFiles(media),1)
    const settings={...normalizeSourceBackground(undefined),ocr:true,autoTranslate:true}
    assert.equal((await save(settings)).statusCode,409)
    saveAiSettings({...getAiSettings(),apiKey:'test-key',model:'test-model'})
    const confirm=await app.inject({method:'POST',url:'/api/sources/source/background/confirm',payload:{settings}})
    assert.equal(confirm.statusCode,200,confirm.body);assert.match(confirm.json().warning,/费用/)
    assert.equal((await save({...settings,maxTranslationRequestsPerDay:999},confirm.json().token)).statusCode,409)
    assert.equal((await save(settings,confirm.json().token)).statusCode,200)
    assert.equal(sources[0]!.background!.autoTranslate,true)
    assert.equal(service.getBackgroundStatus().sources[0]!.translationConsentValid,true)
    await scanLibrary(); await service.synchronizeBackground()
    assert.equal(service.getBackgroundStatus().sources[0]!.counts.queued,1)
    assert.equal(service.backgroundQueue.usage('source').requests,0,'enabling/scanning must not itself call paid API')
    service.controlBackground('source','pause'); assert.equal(service.getBackgroundStatus().sources[0]!.state,'paused')
    service.controlBackground('source','stop');assert.equal(service.getBackgroundStatus().sources[0]!.counts.stopped,1)
    service.controlBackground('source','resume'); await service.synchronizeBackground();assert.equal(service.getBackgroundStatus().sources[0]!.counts.queued,1)
    saveAiSettings({...getAiSettings(),model:'different-model'})
    assert.equal(service.getBackgroundStatus().sources[0]!.translationConsentValid,false)
    assert.equal((await save(settings,confirm.json().token)).statusCode,409,'used token cannot authorize changed AI settings')
    const disabled={...settings,autoTranslate:false}
    assert.equal((await save(disabled)).statusCode,200);await service.synchronizeBackground()
    const renamed=await app.inject({method:'PUT',url:'/api/sources/source',payload:{name:'Renamed',path:media,rules:customRules()}})
    assert.equal(renamed.statusCode,200,renamed.body);assert.equal(renamed.json().background.ocr,true)
    while(scanStatus.running) await new Promise(resolve=>setTimeout(resolve,10))
    await service.synchronizeBackground()
    const monitored={...disabled,watch:true}
    assert.equal((await save(monitored)).statusCode,200);await service.synchronizeBackground()
    await service.checkBackgroundDirectories()
    assert.equal(service.getBackgroundStatus().sources[0]!.lastFileCount,1)
    await mkdir(path.join(media,'nested'));await writeFile(path.join(media,'nested','2.jpg'),'test')
    assert.equal(await service.countSourceFiles(media),2)
    await save(monitored);await service.synchronizeBackground();await service.checkBackgroundDirectories()
    assert.equal(service.getBackgroundStatus().sources[0]!.lastFileCount,2)
    assert.equal((db.prepare('SELECT COUNT(*) n FROM assets').get() as {n:number}).n,2)
    const abort=new AbortController();abort.abort();await assert.rejects(service.countSourceFiles(media,abort.signal))
    const invalid=await save({...disabled,maxPagesPerDay:-2});assert.equal(invalid.statusCode,400)
  } finally {
    while(scanStatus.running) await new Promise(resolve=>setTimeout(resolve,10))
    await service.synchronizeBackground();service.stopBackgroundRuntime();await app.close();db.close();await rm(root,{recursive:true,force:true})
  }
})
