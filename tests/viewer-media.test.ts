import test from 'node:test'
import assert from 'node:assert/strict'
import {createViewerImageCache,nearbyImages,revealThumbnail,nextTranslationDisplay,translationDisplayOrder,metadataVisibility} from '../src/viewer-media.js'
import type {Asset} from '../shared/types.js'

class FakeImage {
  decoding='';src='';onload:(()=>void)|null=null;onerror:(()=>void)|null=null
  cleared=false;decoded=0
  async decode(){this.decoded++}
  removeAttribute(name:string){if(name==='src'){this.src='';this.cleared=true}}
}
test('原图和译图共用预载缓存，重复绘制不再下载，容量有界并释放未完成请求',async()=>{
  const made:FakeImage[]=[]
  const cache=createViewerImageCache(()=>{const img=new FakeImage();made.push(img);return img as unknown as HTMLImageElement},2)
  const first=cache.load('original')
  assert.equal(cache.load('original'),first)
  made[0].onload!();await first;assert.equal(made[0].decoded,1)
  const translated=cache.load('result-key:base','/base.png')
  assert.equal(made[1].src,'/base.png')
  made[1].onload!();await translated
  assert.equal(cache.load('result-key:base','/base.png'),translated)
  assert.equal(made.length,2)
  const pending=cache.load('pending');const rejected=assert.rejects(pending,/取消/)
  cache.load('result-key:base','/base.png')
  const last=cache.load('last');const canceledLast=assert.rejects(last,/取消/)
  await rejected;assert.equal(made[2].cleared,true)
  cache.clear();await canceledLast
})
test('预载失败可重试；译图版本变化重新加载',async()=>{
  const made:FakeImage[]=[]
  const cache=createViewerImageCache(()=>{const image=new FakeImage();made.push(image);return image as unknown as HTMLImageElement})
  const fail=cache.load('v1','/base');const rejected=assert.rejects(fail,/加载失败/)
  made[0].onerror!();await rejected
  const retry=cache.load('v1','/base');made[1].onload!();await retry
  const v2=cache.load('v2','/base');made[2].onload!();await v2
  assert.equal(made.length,3);cache.clear()
})
test('仅预载当前及相邻图片，不预载视频或越界',()=>{
  const assets=Array.from({length:5},(_,i)=>({id:String(i),kind:'image',extension:'jpg'} as Asset))
  assert.deepEqual(nearbyImages(assets,2).map(a=>a.id),['2','3','1'])
  assert.deepEqual(nearbyImages(assets,0).map(a=>a.id),['0','1'])
  assert.deepEqual(nearbyImages(assets,4).map(a=>a.id),['4','3'])
  assets[3].kind='video';assets[1].extension='webm'
  assert.deepEqual(nearbyImages(assets,2).map(a=>a.id),['2'])
  assert.deepEqual(nearbyImages([],0),[])
})
test('缩略图超出左右边界时只滚动缩略图条，可见时不滚动',()=>{
  const calls:unknown[]=[]
  const strip={scrollLeft:100,clientWidth:300,getBoundingClientRect:()=>({left:20,right:320}),scrollTo:(v:unknown)=>calls.push(v)} as unknown as HTMLElement
  const button=(left:number,right:number)=>({getBoundingClientRect:()=>({left,right,width:right-left})}) as HTMLElement
  revealThumbnail(strip,button(30,90));assert.equal(calls.length,0)
  revealThumbnail(strip,button(350,410));assert.deepEqual(calls.pop(),{left:310,behavior:'smooth'})
  revealThumbnail(strip,button(-100,-40),false);assert.deepEqual(calls.pop(),{left:0,behavior:'auto'})
})
test('元信息默认译文，按译文→双语→原文循环',()=>{
  assert.equal(translationDisplayOrder[0],'translated')
  assert.equal(nextTranslationDisplay('translated'),'both')
  assert.equal(nextTranslationDisplay('both'),'source')
  assert.equal(nextTranslationDisplay('source'),'translated')
})

test('未翻译或切换作品后仍显示原文，成功翻译才显示译文',()=>{
  assert.deepEqual(metadataVisibility('translated',false),{source:true,translated:false})
  assert.deepEqual(metadataVisibility('translated',true),{source:false,translated:true})
  assert.deepEqual(metadataVisibility('both',true),{source:true,translated:true})
  assert.deepEqual(metadataVisibility('source',true),{source:true,translated:false})
})
