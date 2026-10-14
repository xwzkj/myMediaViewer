import type { RouteLocationNormalizedLoaded } from 'vue-router'

type CacheRoute = Pick<RouteLocationNormalizedLoaded, 'name' | 'params' | 'query'>

function queryKey(route: CacheRoute): string {
  const parts: string[] = []
  for (const key of Object.keys(route.query).sort()) {
    if (key === 'from') continue
    const value = route.query[key]
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item ?? '')}`)
  }
  return parts.join('&')
}

function cloudEntity(route: CacheRoute): string {
  return route.query.entity === 'users' ? 'users' : 'works'
}

export function createSearchSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// key 以 pid 为主契约：凡含有效 pid 的页面一律 key = family:pid，
// 同 pid 内筛选/排序/query 变化不换实例（同页 replace 更新），不同 pid 必不同实例。
// 无 pid 的 legacy 直达/旧链接才回退旧策略；cloudSearch entity 不影响同 pid，
// 实体切换一律 push 新 pid，所以无需把 entity 写进 key。
export function routeCacheKey(route: CacheRoute): string {
  const name = String(route.name || '')
  const pid = typeof route.query.pid === 'string' ? route.query.pid : ''
  if (pid) {
    if (name === 'search' || name === 'cloudSearch') return `${name}:pid-${pid}`
    if (name === 'work' || name === 'cloudWork') return `work:pid-${pid}`
    if (name === 'cloudUser') return `cloudUser:pid-${pid}`
    if (name === 'library' || name === 'favorites' || name === 'source' || name === 'cloudFavorites' || name === 'settings') {
      return `${name}:pid-${pid}`
    }
    return `${name || 'unknown'}:pid-${pid}`
  }
  if (name === 'search' || name === 'cloudSearch') {
    const sid = typeof route.query.sid === 'string' ? route.query.sid : ''
    const entity = name === 'cloudSearch' ? `:${cloudEntity(route)}` : ''
    return `${name}:${sid || `direct:${queryKey(route)}`}${entity}`
  }
  if (name === 'work' || name === 'cloudWork') {
    return 'work'
  }
  if (name === 'cloudUser') {
    // legacy 无 pid 的画师直达：同 uid 同实例，由组件内 uid 不可变保证。
    return `cloudUser:${String(route.params.userId || '')}`
  }
  if (name === 'cloudFavorites') return `cloudFavorites:${queryKey(route)}`
  if (name === 'source') return `source:${String(route.params.sourceId || '')}`
  if (name === 'favorites') return `favorites:${queryKey(route)}`
  return name
}
