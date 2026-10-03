import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, h, ref, nextTick, withDirectives } from 'vue'
import { vReleaseVideo } from '../src/video-lifecycle'

// 模拟媒体元素，验证 Vue 实际替换/卸载节点时会释放旧播放器。
class Element {
  parent: Element | null = null
  children: Element[] = []
  autoplay = true
  playing = true
  src = 'media.mp4'
  loads = 0
  pause() { this.playing = false }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
  load() { this.loads++ }
}

test('切换分 P、切换兼容源及退出查看器都释放原视频节点', async () => {
  const renderer = createRenderer<Element, Element>({
    createElement: () => new Element(), createText: () => new Element(), createComment: () => new Element(),
    setText() {}, setElementText() {}, patchProp() {},
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) {
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove(node) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = null
    },
  })
  const key = ref('page-1')
  const host = new Element()
  const app = renderer.createApp({ setup: () => () => withDirectives(h('video', { key: key.value }), [ [vReleaseVideo] ]) })
  app.mount(host)
  function released(node: Element) {
    assert.equal(node.playing, false)
    assert.equal(node.autoplay, false)
    assert.equal(node.src, '')
    assert.equal(node.loads, 1)
  }
  for (const next of ['page-2', 'page-2-compatible']) {
    const old = host.children[0]
    key.value = next
    await nextTick()
    released(old)
    assert.equal(host.children[0].playing, true)
  }
  const last = host.children[0]
  app.unmount()
  released(last)
})
