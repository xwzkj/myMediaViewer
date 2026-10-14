import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, defineComponent, h, KeepAlive, nextTick, onActivated, onDeactivated, onUnmounted, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { usePageRoute } from '../src/use-page-route.js'
import { pushPage, replacePage, returnFromPage } from '../src/navigation.js'
import { routeCacheKey } from '../src/route-cache-key.js'
import { retainLibrarySession, releaseLibrarySession, setLibraryLoader, getLibrarySession } from '../src/library-session.js'

type Host = { tag: string; text: string; children: Host[]; parent: Host | null }
function node(tag: string, text = ''): Host { return { tag, text, children: [], parent: null } }
function customRenderer() {
  return createRenderer<Host, Host>({
    patchProp() {},
    insert(child, parent, anchor = null) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child)
      else parent.children.splice(index, 0, child)
      child.parent = parent
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      child.parent = null
    },
    createElement: tag => node(tag),
    createText: text => node('#text', text),
    createComment: text => node('#comment', text),
    setText: (target, text) => { target.text = text },
    setElementText: (target, text) => { target.text = text; target.children = [] },
    parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  })
}
function rendered(host: Host): string { return host.text + host.children.map(rendered).join('') }

const Bare = defineComponent({ setup: () => () => h('div', 'bare') })
function makeRouter(component = Bare) {
  return createRouter({ history: createMemoryHistory(), routes: [
    { path: '/library', name: 'library', component },
    { path: '/search', name: 'search', component },
    { path: '/cloud/works/:workId', name: 'cloudWork', component },
  ] })
}

test('real RouterView + KeepAlive: A/B/back freezes route, keeps state and requests; replace updates same instance', async () => {
  const probes = new Map<string, ReturnType<typeof usePageRoute> & { index: ReturnType<typeof ref<number>>; activated: number; deactivated: number; unmounted: number }>()
  const requests = new Map<string, number>()
  const Page = defineComponent({ name: 'PageProbe', setup() {
    const snapshot = usePageRoute()
    const index = ref(1)
    const probe = { ...snapshot, index, activated: 0, deactivated: 0, unmounted: 0 }
    probes.set(snapshot.pageKey, probe)
    requests.set(snapshot.pageKey, (requests.get(snapshot.pageKey) || 0) + 1)
    onActivated(() => { probe.activated++ })
    onDeactivated(() => { probe.deactivated++ })
    onUnmounted(() => { probe.unmounted++ })
    return () => h('div', `${snapshot.route.value.params.workId}:${index.value}:${snapshot.active.value}`)
  } })
  const router = makeRouter(Page)
  await router.push({ name: 'cloudWork', params: { workId: '100' }, query: { pid: 'a' } })
  await router.isReady()
  const Shell = defineComponent({ setup: () => () => h(RouterView, null, {
    default: ({ Component, route }: any) => h(KeepAlive, { include: 'PageProbe', max: 32 }, { default: () => Component ? h(Component, { key: routeCacheKey(route) }) : null }),
  }) })
  const host = node('root')
  const app = customRenderer().createApp(Shell)
  app.use(router)
  app.mount(host)
  await nextTick()
  const a = probes.get('work:pid-a')!
  assert.ok(a, 'actual setup must run')
  assert.equal(a.activated, 1)
  a.index.value = 2
  await nextTick()
  assert.equal(rendered(host), '100:2:true')
  await pushPage(router, { name: 'cloudWork', params: { workId: '200' }, query: { from: router.currentRoute.value.fullPath } })
  await nextTick()
  const bKey = routeCacheKey(router.currentRoute.value)
  const b = probes.get(bKey)!
  assert.ok(b && b !== a)
  assert.equal(a.route.value.params.workId, '100')
  assert.equal(a.active.value, false)
  assert.equal(a.deactivated, 1)
  assert.equal(rendered(host), '200:1:true')
  const returned = new Promise<void>(resolve => {
    const off = router.afterEach(to => { if (to.query.pid === 'a') { off(); resolve() } })
  })
  router.back()
  await returned
  await nextTick()
  assert.equal(rendered(host), '100:2:true')
  assert.equal(a.activated, 2)
  assert.equal(b.active.value, false)
  assert.equal(b.route.value.params.workId, '200')
  assert.equal(requests.get('work:pid-a'), 1)
  assert.equal(requests.get(bKey), 1)
  await replacePage(router, { name: 'cloudWork', params: { workId: '101' }, query: { q: 'new' } }, a.route.value)
  await nextTick()
  assert.equal(router.currentRoute.value.query.pid, 'a')
  assert.equal(a.route.value.params.workId, '101', 'reactive useRoute object must update frozen snapshot for same key')
  assert.equal(a.index.value, 2)
  assert.equal(probes.size, 2)
  assert.equal(rendered(host), '101:2:true')
  app.unmount()
  assert.equal(a.unmounted, 1)
  assert.equal(b.unmounted, 1)
})

test('navigation: push uses fresh pid, replace preserves it and business context', async () => {
  const router = makeRouter()
  await router.push({ name: 'search', query: { q: 'a', pid: 'original' } })
  await pushPage(router, { name: 'search', query: { q: 'b', pid: 'original', sid: 'business' } })
  const pid = router.currentRoute.value.query.pid
  assert.ok(pid && pid !== 'original')
  assert.equal(router.currentRoute.value.query.sid, 'business')
  await replacePage(router, { name: 'search', query: { q: 'c', sid: 'business' } }, router.currentRoute.value)
  assert.equal(router.currentRoute.value.query.pid, pid)
})

test('return without trusted browser history replaces recorded parent with original pid; invalid parent falls back', async () => {
  const router = makeRouter()
  await router.push({ name: 'search', query: { q: 'a', pid: 'source' } })
  const source = router.currentRoute.value.fullPath
  await pushPage(router, { name: 'cloudWork', params: { workId: '100' }, query: { from: source } })
  await returnFromPage(router, router.currentRoute.value)
  assert.equal(router.currentRoute.value.fullPath, source)
  for (const from of ['', 'https://evil.example/', '//evil.example/', '/not-a-page']) {
    await router.push({ name: 'cloudWork', params: { workId: '100' }, query: { from, pid: 'child' } })
    await returnFromPage(router, router.currentRoute.value)
    assert.equal(router.currentRoute.value.name, 'library', from)
  }
})

test('inactive explicit loader remains held until detail owner releases', async () => {
  const key = 'test:lifecycle-held'
  let calls = 0
  retainLibrarySession(key)
  setLibraryLoader(key, async () => { calls++ })
  retainLibrarySession(key)
  releaseLibrarySession(key)
  await getLibrarySession(key)?.loadMore?.()
  assert.equal(calls, 1)
  releaseLibrarySession(key)
  assert.equal(getLibrarySession(key), undefined)
})
