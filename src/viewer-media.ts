import type { Asset } from '../shared/types'

export const translationDisplayOrder = ['translated', 'both', 'source'] as const
export function nextTranslationDisplay(value: typeof translationDisplayOrder[number]) {
  return translationDisplayOrder[(translationDisplayOrder.indexOf(value) + 1) % translationDisplayOrder.length]
}
export function metadataVisibility(mode: typeof translationDisplayOrder[number], hasTranslation: boolean) {
  return {source: !hasTranslation || mode !== 'translated', translated: hasTranslation && mode !== 'source'}
}
/** Current image first, then one forward and one backward; never warm a whole work. */
export function nearbyImages(assets: Asset[], index: number): Asset[] {
  return [index,index+1,index-1].flatMap(i => {
    const asset=assets[i]
    return asset && asset.kind !== 'video' && asset.extension !== 'webm' ? [asset] : []
  })
}
/** Scroll the strip only, not document/aside (as scrollIntoView can do). */
export function revealThumbnail(strip: HTMLElement, selected: HTMLElement, smooth = true) {
  const outer=strip.getBoundingClientRect(), inner=selected.getBoundingClientRect()
  if(inner.left >= outer.left && inner.right <= outer.right)return
  const left=strip.scrollLeft + inner.left - outer.left - (strip.clientWidth-inner.width)/2
  strip.scrollTo({left:Math.max(0,left),behavior:smooth?'smooth':'auto'})
}
/** Share pending/decoded image loads between warmup and canvas drawing; bounded per viewer. */
export function createViewerImageCache(makeImage: () => HTMLImageElement = () => new Image(), capacity = 6) {
  const entries = new Map<string, {promise:Promise<HTMLImageElement>; cancel():void}>()
  function load(key: string, url = key): Promise<HTMLImageElement> {
    const existing=entries.get(key)
    if(existing){entries.delete(key);entries.set(key,existing);return existing.promise}
    const image=makeImage();image.decoding='async'
    let cancel=()=>{}
    const promise=new Promise<HTMLImageElement>((resolve,reject)=>{
      let settled=false
      const finish=(error?:Error)=>{
        if(settled)return
        settled=true;image.onload=null;image.onerror=null
        if(error){entries.delete(key);reject(error)}else resolve(image)
      }
      image.onload=()=>{void image.decode().catch(()=>{}).then(()=>finish())}
      image.onerror=()=>finish(new Error('图片加载失败'))
      cancel=()=>{if(!settled){finish(new Error('图片预载已取消'));image.removeAttribute('src')}}
      image.src=url
    })
    entries.set(key,{promise,cancel})
    while(entries.size>capacity){const oldest=entries.keys().next().value!;const entry=entries.get(oldest)!;entries.delete(oldest);entry.cancel()}
    return promise
  }
  return {load,clear(){for(const entry of [...entries.values()])entry.cancel();entries.clear()}}
}
