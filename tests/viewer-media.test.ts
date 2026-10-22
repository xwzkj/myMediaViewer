import test from 'node:test'
import assert from 'node:assert/strict'
import {createViewerImageCache,nearbyImages,revealThumbnail,nextTranslationDisplay,translationDisplayOrder,metadataVisibility,resolveAssetUrl,resolvePreviewSource,rubberBandOffset,swipeVelocity,resolveSwipeRelease,swipeSettleDuration,zoomAt,constrainZoom,clampZoom} from '../src/viewer-media.js'
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
// ---------------------------------------------------------------------------
// Bug 1：放大浮层与主舞台必须用同一套分辨率解析
// ---------------------------------------------------------------------------
const pixivImage = { id: 'p1', workId: 'w', filename: 'a.jpg', page: 3, kind: 'image', extension: 'jpg', size: 10, modified: 0, url: '/api/pixiv/assets/999/3/preview', thumbnail: '/t.jpg', origin: 'pixiv', illustId: '999' } as Asset
const localVideo = { id: 'l1', workId: 'w', filename: 'a.mp4', page: 0, kind: 'video', extension: 'mp4', size: 10, modified: 0, url: '/api/assets/l1/file', thumbnail: '/t.jpg', origin: 'local' } as Asset

test('主舞台 URL：compatible 优先，已请求过原图才升级，否则回落 asset.url', () => {
  assert.equal(resolveAssetUrl(undefined), undefined)
  assert.equal(resolveAssetUrl(pixivImage), '/api/pixiv/assets/999/3/preview')
  assert.equal(resolveAssetUrl(pixivImage, new Set(['p1'])), '/api/pixiv/assets/999/3/original')
  assert.equal(resolveAssetUrl(localVideo, new Set(), true), '/api/assets/l1/compatible')
  assert.equal(resolveAssetUrl(localVideo), '/api/assets/l1/file')
  // compatible 只对本地资源生效，Pixiv 永远走原图/预览。
  assert.equal(resolveAssetUrl(pixivImage, new Set(['p1']), true), '/api/pixiv/assets/999/3/original')
})

test('放大浮层：已知原图用原图，正在放大的这一页按需取原图并保留预览图兜底', () => {
  assert.deepEqual(resolvePreviewSource(pixivImage), { src: '/api/pixiv/assets/999/3/preview' })
  assert.deepEqual(resolvePreviewSource(pixivImage, new Set(['p1'])), { src: '/api/pixiv/assets/999/3/original', fallback: '/api/pixiv/assets/999/3/preview' })
  assert.deepEqual(resolvePreviewSource(pixivImage, new Set(), { forceOriginal: true }), { src: '/api/pixiv/assets/999/3/original', fallback: '/api/pixiv/assets/999/3/preview' })
  // 非图片（视频）不参与放大浮层。
  assert.equal(resolvePreviewSource(localVideo), null)
  assert.equal(resolvePreviewSource(undefined), null)
  // 浮层与主舞台对同一 asset 必须解析出同一个地址。
  assert.equal(resolvePreviewSource(pixivImage, new Set(['p1']))!.src, resolveAssetUrl(pixivImage, new Set(['p1'])))
})

// ---------------------------------------------------------------------------
// Bug 2：跟手翻页的位移/速度/橡皮筋数学
// ---------------------------------------------------------------------------
test('橡皮筋：可翻页方向 1:1 跟手，首尾之外按阻尼衰减且不超出一屏', () => {
  assert.equal(rubberBandOffset(-140, 400, true, true), -140)
  assert.equal(rubberBandOffset(140, 400, true, true), 140)
  assert.equal(rubberBandOffset(-140, 400, true, false), -49)
  assert.equal(rubberBandOffset(140, 400, false, true), 49)
  assert.equal(rubberBandOffset(-2000, 400, true, false), -400)
})

test('速度取样：只统计最近窗口，样本不足或时间未推进时为 0', () => {
  assert.equal(swipeVelocity([]), 0)
  assert.equal(swipeVelocity([{ x: 10, t: 100 }]), 0)
  assert.equal(swipeVelocity([{ x: 0, t: 5 }, { x: 9, t: 5 }]), 0)
  assert.equal(swipeVelocity([{ x: 0, t: 0 }, { x: -30, t: 100 }]), -0.3)
  // 0ms 的过期样本被丢弃：只剩 300→400ms 这一段。
  assert.equal(swipeVelocity([{ x: 0, t: 0 }, { x: 100, t: 300 }, { x: 60, t: 400 }]), -0.4)
})

test('松手判定：位移够远翻页，位移短但速度快也翻页，都不够则回弹', () => {
  const base = { width: 400, index: 1, count: 5, mode: 'page' as const }
  assert.deepEqual(resolveSwipeRelease({ ...base, offset: 120 }), { action: 'page', index: 0, direction: -1 })
  assert.deepEqual(resolveSwipeRelease({ ...base, offset: -120 }), { action: 'page', index: 2, direction: 1 })
  assert.deepEqual(resolveSwipeRelease({ ...base, offset: -20, velocity: -0.8 }), { action: 'page', index: 2, direction: 1 })
  assert.deepEqual(resolveSwipeRelease({ ...base, offset: 20, velocity: 0.8 }), { action: 'page', index: 0, direction: -1 })
  assert.deepEqual(resolveSwipeRelease({ ...base, offset: 30, velocity: 0.1 }), { action: 'stay' })
  assert.deepEqual(resolveSwipeRelease({ ...base, offset: -30, velocity: -0.1 }), { action: 'stay' })
})

test('松手判定：页面首尾之外与信息区拖动都接力切换作品', () => {
  assert.deepEqual(resolveSwipeRelease({ offset: 200, width: 400, index: 0, count: 5, mode: 'page' }), { action: 'work', direction: -1 })
  assert.deepEqual(resolveSwipeRelease({ offset: -200, width: 400, index: 4, count: 5, mode: 'page' }), { action: 'work', direction: 1 })
  assert.deepEqual(resolveSwipeRelease({ offset: -200, width: 400, index: 2, count: 5, mode: 'work' }), { action: 'work', direction: 1 })
  assert.deepEqual(resolveSwipeRelease({ offset: 200, width: 400, index: 2, count: 5, mode: 'work' }), { action: 'work', direction: -1 })
  // 只有一张图时任何一次成功滑动都交给作品切换。
  assert.deepEqual(resolveSwipeRelease({ offset: -300, width: 400, index: 0, count: 1, mode: 'page' }), { action: 'work', direction: 1 })
  // 信息区拖动同样受速度兜底，且不会因为越界而被阻尼吃掉。
  assert.deepEqual(resolveSwipeRelease({ offset: -20, velocity: -0.9, width: 400, index: 0, count: 1, mode: 'work' }), { action: 'work', direction: 1 })
})

test('落定时长随位移/速度变化并夹在上下限之间', () => {
  assert.equal(swipeSettleDuration(400), 320)
  assert.equal(swipeSettleDuration(50, 0), 140)
  assert.equal(swipeSettleDuration(200, 2), 140)
  assert.equal(swipeSettleDuration(200, 1), 200)
})

// ---------------------------------------------------------------------------
// Bug 3：桌面端滚轮缩放的纯状态机
// ---------------------------------------------------------------------------
test('缩放：以光标为锚点，平移量夹在图片范围内，缩回 1 倍时归零', () => {
  const size = { width: 400, height: 400 }
  assert.deepEqual(zoomAt({ scale: 1, x: 0, y: 0 }, { x: 100, y: 0 }, 2, size), { scale: 2, x: -100, y: 0 })
  assert.deepEqual(zoomAt({ scale: 2, x: 0, y: 0 }, { x: 0, y: 0 }, 0.5, size), { scale: 1, x: 0, y: 0 })
  assert.deepEqual(constrainZoom({ scale: 1, x: 50, y: 50 }, size), { scale: 1, x: 0, y: 0 })
  assert.deepEqual(constrainZoom({ scale: 4, x: 1000, y: -1000 }, size), { scale: 4, x: 600, y: -600 })
  assert.equal(clampZoom(10), 4)
  assert.equal(clampZoom(0.4), 1)
  // 放大到上限后继续滚轮不会越界。
  assert.deepEqual(zoomAt({ scale: 4, x: 0, y: 0 }, { x: 0, y: 0 }, 2, size), { scale: 4, x: 0, y: 0 })
})
