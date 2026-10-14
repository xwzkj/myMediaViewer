import type { LocationQueryRaw, RouteLocationNormalizedLoaded, RouteLocationRaw, Router } from 'vue-router'
import { createSearchSessionId } from './route-cache-key'

// returnFromPage 允许的目标：应用内浏览页 name 白名单。
const browseNames = new Set([
  'library', 'favorites', 'source', 'search', 'cloudSearch',
  'cloudFavorites', 'settings', 'work', 'cloudWork', 'cloudUser',
])

function queryRecord(query: unknown): Record<string, unknown> {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {}
  return query as Record<string, unknown>
}

function withFreshPid(query: Record<string, unknown>): LocationQueryRaw {
  return { ...query, pid: createSearchSessionId() } as LocationQueryRaw
}

/**
 * 新历史实例：生成全新 pid，业务 query 原样保留。
 * 调用方负责传入 from/list 等业务上下文，这里只负责实例身份。
 */
export function pushPage(router: Router, target: RouteLocationRaw): ReturnType<Router['push']> {
  const normalized = router.resolve(target)
  const next = {
    name: normalized.name ?? undefined,
    params: { ...normalized.params },
    query: withFreshPid({ ...normalized.query }),
    hash: normalized.hash || undefined,
  }
  return router.push(next)
}

/**
 * 同实例替换：默认沿用当前快照 pid；仅当 target 显式指向另一个已存在 pid
 *（如 recorded from 返回 URL）时采用目标 pid。业务 query 以 target 为准。
 */
export function replacePage(
  router: Router,
  target: RouteLocationRaw,
  current?: RouteLocationNormalizedLoaded,
): ReturnType<Router['replace']> {
  const normalized = router.resolve(target)
  const incomingPid = queryRecord(normalized.query).pid
  const currentPid = current && typeof current.query.pid === 'string' ? current.query.pid : ''
  const nextQuery = { ...normalized.query } as Record<string, unknown>
  if (typeof incomingPid === 'string' && incomingPid) {
    nextQuery.pid = incomingPid
  } else if (currentPid) {
    nextQuery.pid = currentPid
  }
  const next = {
    name: normalized.name ?? undefined,
    params: { ...normalized.params },
    query: nextQuery as LocationQueryRaw,
    hash: normalized.hash || undefined,
  }
  return router.replace(next)
}

/**
 * 返回登记占位：back 判断完全依赖浏览器公开 history.state.back，
 * 不再维护自有 pid 历史，避免 A-B-A 等场景误判。
 */
export function trackPagePid(_pid: string): void {
  // 保留导出名供旧调用方兼容；无实际副作用。
}

function historyBackFullPath(router: Router): string {
  try {
    const state = window.history.state as { back?: string } | null
    if (state && typeof state.back === 'string' && state.back) {
      return router.resolve(state.back).fullPath
    }
  } catch {
    /* 无公开 back 信息时降级为 replace。 */
  }
  return ''
}

/**
 * 从详情/创作者页返回：仅当浏览器公开 history.state.back 与 recorded from
 * 同源时才 back（保留原生滚动/历史语义），否则 replace 回 from 原始 pid，
 * 再否则回媒体库。永远不信任不可解析的 from，不猜测历史栈。
 * `//evil` 类 from 直接拒绝（router.resolve 不会外部 push，但也不回写）。
 */
export function returnFromPage(
  router: Router,
  route: RouteLocationNormalizedLoaded,
): ReturnType<Router['replace']> | void {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  if (!from.startsWith('/') || from.startsWith('//')) return router.replace({ name: 'library' })
  let target: ReturnType<Router['resolve']> | null = null
  try {
    target = router.resolve(from)
  } catch {
    return router.replace({ name: 'library' })
  }
  // 只允许应用内已知浏览页：未知 name（如解析失败的兜底）一律回媒体库。
  if (!target || typeof target.name !== 'string' || !browseNames.has(target.name)) {
    return router.replace({ name: 'library' })
  }
  if (target.fullPath === route.fullPath) return router.replace({ name: 'library' })
  const backFullPath = historyBackFullPath(router)
  if (backFullPath && backFullPath === target.fullPath && typeof window !== 'undefined' && window.history.length > 1) {
    router.back()
    return
  }
  return replacePage(router, target.fullPath, route)
}
