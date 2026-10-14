import { computed, shallowRef, watch, type ComputedRef, type ShallowRef } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { useRoute } from 'vue-router'
import { routeCacheKey } from './route-cache-key'

export interface PageRoute {
  route: ShallowRef<RouteLocationNormalizedLoaded>
  active: ComputedRef<boolean>
  pageKey: string
}

export function clonePageRoute(route: RouteLocationNormalizedLoaded): RouteLocationNormalizedLoaded {
  return {
    ...route,
    params: { ...route.params },
    query: { ...route.query },
    matched: [...route.matched],
  }
}

/**
 * 实例路由快照：setup 期捕获 live 对象（useRoute 响应式对象或外部 ref），
 * 此后仅当全局路由回到同一 key 才更新快照。watch 追踪 fullPath 标量，
 * 前后作品 replace 同 key 也能更新；不同 key 不更新，失活页永远读自己。
 * 返回的 route 是 ShallowRef，调用方一律用 .value 读取。
 */
export function usePageRoute(live?: ShallowRef<RouteLocationNormalizedLoaded>): PageRoute {
  // setup 期一次性捕获：禁止在 watch/computed 回调里调 inject/useRoute。
  const injected = live ? null : (useRoute() as unknown as RouteLocationNormalizedLoaded)
  const current = (): RouteLocationNormalizedLoaded => (live ? live.value : (injected as RouteLocationNormalizedLoaded))
  const pageKey = routeCacheKey(current())
  const snapshot = shallowRef<RouteLocationNormalizedLoaded>(clonePageRoute(current()))
  const active = computed(() => routeCacheKey(current()) === pageKey)
  watch(
    () => current().fullPath,
    () => {
      const next = current()
      if (routeCacheKey(next) === pageKey) snapshot.value = clonePageRoute(next)
    },
    { flush: 'sync' },
  )
  return { route: snapshot, active, pageKey }
}
