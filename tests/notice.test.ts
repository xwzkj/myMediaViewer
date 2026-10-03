import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { useNotice } from '../src/use-notice.js'

test('提示保留错误类型，操作按钮只执行一次并清除提示', () => {
  const scope = effectScope()
  const notices = scope.run(useNotice)!
  try {
    let called = 0
    notices.notice('已显示缓存译文', { label: '重新翻译', handler: () => { called++ } })
    assert.equal(notices.toast.value?.action?.label, '重新翻译')
    notices.runAction()
    notices.runAction()
    assert.equal(called, 1)
    assert.equal(notices.toast.value, null)
    notices.notice('翻译失败', undefined, 'error')
    assert.equal(notices.toast.value?.tone, 'error')
  } finally { scope.stop() }
})

test('新提示替换旧计时器，销毁作用域后清除提示和回调', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const scope = effectScope()
  const notices = scope.run(useNotice)!
  try {
    notices.notice('旧提示')
    t.mock.timers.tick(4000)
    notices.notice('新提示')
    t.mock.timers.tick(200)
    assert.equal(notices.toast.value?.message, '新提示')
    t.mock.timers.tick(4000)
    assert.equal(notices.toast.value, null)

    let called = false
    notices.notice('带操作的提示', { label: '重试', handler: () => { called = true } })
    t.mock.timers.tick(7999)
    assert.ok(notices.toast.value)
    t.mock.timers.tick(1)
    assert.equal(notices.toast.value, null)
    notices.notice('离开页面前的提示', { label: '重试', handler: () => { called = true } })
    scope.stop()
    notices.runAction()
    t.mock.timers.tick(8000)
    assert.equal(notices.toast.value, null)
    assert.equal(called, false)
  } finally { scope.stop() }
})
