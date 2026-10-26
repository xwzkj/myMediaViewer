import {
  defaultLibraryState,
  libraryScopes,
  normalizeLibraryState,
  type CloudFavoritesState,
  type CloudSearchState,
  type LibraryScope,
  type LibraryStateMap,
  type LibraryWorksState,
  type LocalSearchState,
  type RecommendationState,
  type SearchSource,
} from '../shared/library-state'

export * from '../shared/library-state'

/**
 * 浏览偏好的前端缓存。
 *
 * 唯一持久化位置是服务端 `/api/library-state`：启动时读回，之后所有修改按 scope
 * 去抖写回。
 */

const state = defaultLibraryState()
const pending = new Map<LibraryScope, LibraryStateMap[LibraryScope]>()
// PUT 串行链：同一 scope 的两次修改不会因为网络回包顺序而互相覆盖。
let writeChain: Promise<void> = Promise.resolve()
let flushTimer: ReturnType<typeof setTimeout> | undefined

function assignScope<S extends LibraryScope>(map: LibraryStateMap, scope: S, value: LibraryStateMap[S]): void {
  map[scope] = value
}

function sameState(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  // 值都是布尔/字符串；按字段比较，不依赖对象字面量的键顺序。
  return keys.every(key => left[key] === right[key])
}

export function readLibraryState(scope: 'works'): LibraryWorksState
export function readLibraryState(scope: 'localSearch'): LocalSearchState
export function readLibraryState(scope: 'cloudSearch'): CloudSearchState
export function readLibraryState(scope: 'cloudFavorites'): CloudFavoritesState
export function readLibraryState(scope: 'recommendation'): RecommendationState
export function readLibraryState(scope: LibraryScope): LibraryStateMap[LibraryScope]
export function readLibraryState(scope: LibraryScope): LibraryStateMap[LibraryScope] {
  return state[scope]
}

export function writeLibraryState(scope: 'works', value: LibraryWorksState): void
export function writeLibraryState(scope: 'localSearch', value: LocalSearchState): void
export function writeLibraryState(scope: 'cloudSearch', value: CloudSearchState): void
export function writeLibraryState(scope: 'cloudFavorites', value: CloudFavoritesState): void
export function writeLibraryState(scope: 'recommendation', value: RecommendationState): void
export function writeLibraryState(scope: LibraryScope, value: LibraryStateMap[LibraryScope]): void {
  const normalized = normalizeLibraryState(scope, value)
  if (sameState(state[scope], normalized)) return
  assignScope(state, scope, normalized)
  pending.set(scope, normalized)
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = undefined; void flushLibraryState() }, 120)
}

/** 用服务端返回（或测试注入）的完整/部分状态覆盖内存；缺失 scope 回退默认值。 */
export function hydrateLibraryState(value: unknown): void {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  for (const scope of libraryScopes) assignScope(state, scope, normalizeLibraryState(scope, raw[scope]))
}

async function putScope(scope: LibraryScope, value: LibraryStateMap[LibraryScope]): Promise<boolean> {
  try {
    const response = await fetch(`/api/library-state/${scope}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      keepalive: true,
    })
    return response.ok
  } catch { return false }
}

/**
 * 启动时从服务端读回筛选记忆。失败时保留默认值并继续启动，不能因为偏好接口
 * 暂时不可用就让整个媒体库打不开。
 */
export async function bootstrapLibraryState(): Promise<void> {
  try {
    const response = await fetch('/api/library-state', { headers: { Accept: 'application/json' } })
    if (!response.ok) return
    hydrateLibraryState(await response.json())
  } catch { /* 默认值可用；写入时仍会尝试连接服务端。 */ }
}

/** 立即写出排队中的修改；测试、页面隐藏前都可显式调用。 */
export function flushLibraryState(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined }
  if (!pending.size) return writeChain
  const batch = [...pending]
  pending.clear()
  writeChain = writeChain.then(async () => {
    for (const [scope, value] of batch) await putScope(scope, value)
  })
  return writeChain
}

if (typeof window !== 'undefined') {
  // 去抖窗口内关闭页面时尽量把最后一次修改送出去。
  window.addEventListener('pagehide', () => { void flushLibraryState() })
}

/** 仅测试使用：清空内存与排队写入，避免用例之间串状态。 */
export function resetLibraryStateForTests(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined }
  pending.clear()
  writeChain = Promise.resolve()
  const defaults = defaultLibraryState()
  for (const scope of libraryScopes) assignScope(state, scope, defaults[scope])
}

/** 兼容旧引用：推荐来源也走同一套服务端记忆。 */
export function readRecommendationSource(): SearchSource {
  return readLibraryState('recommendation').source
}

export function writeRecommendationSource(source: SearchSource): void {
  writeLibraryState('recommendation', { source })
}
