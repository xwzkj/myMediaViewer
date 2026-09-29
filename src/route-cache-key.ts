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

export function createSearchSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function routeCacheKey(route: CacheRoute): string {
  const name = String(route.name || '')
  if (name === 'search') {
    const sid = typeof route.query.sid === 'string' ? route.query.sid : ''
    return `search:${sid || `direct:${queryKey(route)}`}`
  }
  if (name === 'source') return `source:${String(route.params.sourceId || '')}`
  if (name === 'favorites') return `favorites:${queryKey(route)}`
  return name
}
