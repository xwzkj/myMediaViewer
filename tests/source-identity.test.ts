import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceContainsPixivWorks } from '../shared/source-identity.js'
import { sourcePreset, customRules } from '../shared/source-presets.js'

test('Pixiv 作品标记独立于分组预设，显式选择优先并兼容旧来源', () => {
  assert.equal(sourceContainsPixivWorks({ kind: 'custom', rules: customRules() }), false)
  assert.equal(sourceContainsPixivWorks({ kind: 'pixiv' }), true)
  assert.equal(sourceContainsPixivWorks({ kind: 'custom', rules: sourcePreset('pixiv') }), true)
  assert.equal(sourceContainsPixivWorks({ kind: 'custom', rules: customRules(), pixivWorks: true }), true)
  assert.equal(sourceContainsPixivWorks({ kind: 'pixiv', rules: sourcePreset('pixiv'), pixivWorks: false }), false)
})
