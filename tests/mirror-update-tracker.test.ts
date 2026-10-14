import test from 'node:test'
import assert from 'node:assert/strict'
import { createMirrorUpdateTracker } from '../src/mirror-update-tracker.js'
import type { PixivStatus } from '../shared/types.js'

function status(items: number, accountId = '42', privateItems = 7): PixivStatus {
  const mirror = (restrict: 'public' | 'private', count: number) => ({ restrict, started: true, phase: 'ready' as const, pages: 1, items: count, lastSynced: 100, lastFullSweep: null, error: '' })
  return { settings: { configured: true, localMode: false, account: { id: accountId } }, mirrors: { public: mirror('public', items), private: mirror('private', privateItems) } } as PixivStatus
}

test('首次进入已有收藏只建立基线，重复读取不提示更新', () => {
  const tracker = createMirrorUpdateTracker()
  assert.equal(tracker.observe(status(120), 'public'), false)
  assert.equal(tracker.observe(status(120), 'public'), false)
  assert.equal(tracker.observe(status(121), 'public'), true)
  assert.equal(tracker.observe(status(121), 'public'), false)
  assert.equal(tracker.observe(status(119), 'public'), true)
})

test('公开/私人、账号和新页面实例分别建立基线', () => {
  const tracker = createMirrorUpdateTracker()
  assert.equal(tracker.observe(status(120), 'public'), false)
  assert.equal(tracker.observe(status(120), 'private'), false)
  assert.equal(tracker.observe(status(120, '42', 8), 'private'), true)
  assert.equal(tracker.observe(status(250, '43'), 'public'), false)
  assert.equal(createMirrorUpdateTracker().observe(status(250, '43'), 'public'), false)
  tracker.reset()
  assert.equal(tracker.observe(status(251, '43'), 'public'), false)
})
