// Synthetic benchmark; never touches the user's library. Usage: pnpm exec tsx tests/scan-benchmark.ts
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = await mkdtemp(path.join(tmpdir(),'media-scan-bench-'))
process.env.MEDIA_DATA_DIR = path.join(root,'data')
const { saveSources } = await import('../server/config.js')
const { sourcePreset } = await import('../shared/source-presets.js')
const { scanLibrary, scanStatus } = await import('../server/scanner.js')
const { db } = await import('../server/database.js')
const count = Number(process.env.BENCH_GROUPS || 500)
const media = path.join(root,'media'); await mkdir(media)
try {
  for(let start=0;start<count;start+=32) await Promise.all(Array.from({length:Math.min(32,count-start)},async(_,i)=>{
    const id = start+i+1
    await Promise.all([
      ...Array.from({length:7},(_,p)=>writeFile(path.join(media,`${id}-${id}_p${p}.jpg`),'image')),
      writeFile(path.join(media,`${id}-${id}-meta.json`),JSON.stringify({title:`作品${id}`,user:'作者',tags:['test']}))
    ])
  }))
  saveSources([{id:'bench',name:'benchmark',kind:'pixiv',path:media,rules:sourcePreset('pixiv')}])
  const times:number[]=[]
  for(const label of ['cold','warm','warm']) {
    const start=performance.now(); await scanLibrary(); const ms=Math.round(performance.now()-start);times.push(ms)
    console.log(JSON.stringify({label,ms,groups:scanStatus.works,files:scanStatus.files,errors:scanStatus.errors}))
  }
  console.log('BENCHMARK',JSON.stringify({groups:count,times}))
} finally {db.close();await rm(root,{recursive:true,force:true})}
