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

// ---------------------------------------------------------------------------
// 分辨率解析（Bug 1）：主舞台与放大浮层共用同一套 URL 规则，避免“主舞台已升级
// 原图、浮层还在用小预览图”。
// ---------------------------------------------------------------------------

/** 主舞台/浮层共用的 Pixiv 原图地址。 */
export function originalAssetUrl(asset: Asset): string {
  return `/api/pixiv/assets/${asset.illustId}/${asset.page}/original`
}

function buildAssetUrl(asset: Asset, original: boolean, compatible: boolean): string {
  if (compatible && asset.origin !== 'pixiv') return `/api/assets/${asset.id}/compatible`
  if (asset.origin === 'pixiv' && original) return originalAssetUrl(asset)
  return asset.url
}

/** 与主舞台 mediaUrl 相同的解析：compatible 优先，其次“已请求过原图”，最后回落到 asset.url（Pixiv 即小预览图）。 */
export function resolveAssetUrl(asset: Asset | undefined, originals: ReadonlySet<string> = new Set(), compatible = false): string | undefined {
  if (!asset) return undefined
  return buildAssetUrl(asset, asset.origin === 'pixiv' && originals.has(asset.id), compatible)
}

export type PreviewImageSource = { src: string; fallback?: string }

/**
 * 放大浮层用的图片地址。forceOriginal 让“正在放大的这一页”按需取原图，
 * 其余页沿用 mediaUrl 的解析结果；原图拿不到（403/404）时调用方回退到 fallback。
 */
export function resolvePreviewSource(asset: Asset | undefined, originals: ReadonlySet<string> = new Set(), options: { compatible?: boolean; forceOriginal?: boolean } = {}): PreviewImageSource | null {
  if (!asset || asset.kind !== 'image') return null
  const original = originals.has(asset.id) || (Boolean(options.forceOriginal) && asset.origin === 'pixiv')
  const src = buildAssetUrl(asset, original, Boolean(options.compatible))
  return src === asset.url ? { src } : { src, fallback: asset.url }
}

// ---------------------------------------------------------------------------
// 跟手翻页的数学（Bug 2）：位移/速度判定、橡皮筋、落定动画时长、缩放。
// ---------------------------------------------------------------------------

/** 越界拖动的阻尼系数：列表首尾再往外的位移按这个比例衰减。 */
export const rubberBandFactor = 0.35
/** 触发翻页的位移比例（占一屏宽度）。 */
export const swipeDistanceRatio = 0.25
/** 触发翻页的速度阈值（px/ms），快速轻扫即使位移短也要翻。 */
export const swipeVelocityThreshold = 0.45

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value
}

/**
 * 首尾之外的拖动不再 1:1 跟手：按 rubberBandFactor 衰减并夹在一屏宽度内，
 * 松手后由调用方动画回 0（橡皮筋回弹）。
 */
export function rubberBandOffset(dx: number, width: number, canPrev: boolean, canNext: boolean): number {
  const allowed = dx < 0 ? canNext : canPrev
  if (allowed) return dx
  return clamp(dx * rubberBandFactor, -Math.max(0, width), Math.max(0, width))
}

/** 最近 window 毫秒内的平均速度（px/ms），负值表示手指向左（下一张）。 */
export function swipeVelocity(samples: readonly { x: number; t: number }[], window = 100): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  let first = last
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > window) break
    first = samples[i]
  }
  const elapsed = last.t - first.t
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0
}

export type SwipeRelease =
  | { action: 'stay' }
  | { action: 'page'; index: number; direction: 1 | -1 }
  | { action: 'work'; direction: 1 | -1 }

/** 位移优先、速度兜底的松手判定；页面在首尾之外时接力切换作品。 */
export function resolveSwipeRelease(input: {
  offset: number
  velocity?: number
  width: number
  index: number
  count: number
  mode: 'page' | 'work'
  distanceRatio?: number
  velocityThreshold?: number
}): SwipeRelease {
  const width = Math.max(1, input.width)
  const velocity = input.velocity || 0
  const far = Math.abs(input.offset) > width * (input.distanceRatio ?? swipeDistanceRatio)
  const fast = Math.abs(velocity) > (input.velocityThreshold ?? swipeVelocityThreshold)
  if (!far && !fast) return { action: 'stay' }
  const direction: 1 | -1 = (far ? input.offset : velocity) < 0 ? 1 : -1
  if (input.mode === 'work') return { action: 'work', direction }
  const target = input.index + direction
  if (target < 0 || target >= input.count) return { action: 'work', direction }
  return { action: 'page', index: target, direction }
}

/** 落定动画时长：位移越大、速度越快越短，并夹在 min/max 之间。 */
export function swipeSettleDuration(distance: number, velocity = 0, options: { min?: number; max?: number; minSpeed?: number } = {}): number {
  const min = options.min ?? 140
  const max = options.max ?? 320
  const speed = Math.max(Math.abs(velocity), options.minSpeed ?? 0.9)
  return clamp(Math.abs(distance) / speed, min, max)
}

// ---------------------------------------------------------------------------
// 桌面端缩放（Vant ImagePreview 只处理触摸）：滚轮缩放与拖拽平移的纯状态机。
// ---------------------------------------------------------------------------

export type ZoomState = { scale: number; x: number; y: number }
export type ZoomSize = { width: number; height: number }

export function clampZoom(scale: number, min = 1, max = 4): number {
  return clamp(scale, min, max)
}

/** 缩放后把平移量夹回图片范围内，避免把图拖出可视区。 */
export function constrainZoom(state: ZoomState, size: ZoomSize, min = 1, max = 4): ZoomState {
  const scale = clampZoom(state.scale, min, max)
  const maxX = Math.max(0, (scale - 1) * size.width / 2)
  const maxY = Math.max(0, (scale - 1) * size.height / 2)
  return { scale, x: clamp(state.x, -maxX, maxX), y: clamp(state.y, -maxY, maxY) }
}

/** 以光标为锚点缩放：光标下的像素保持不动。cursor 相对于图片未变换时的中心。 */
export function zoomAt(state: ZoomState, cursor: { x: number; y: number }, factor: number, size: ZoomSize, min = 1, max = 4): ZoomState {
  const scale = clampZoom(state.scale * factor, min, max)
  const ratio = state.scale > 0 ? scale / state.scale : 1
  return constrainZoom({
    scale,
    x: cursor.x - (cursor.x - state.x) * ratio,
    y: cursor.y - (cursor.y - state.y) * ratio,
  }, size, min, max)
}
