import test from 'node:test'
import assert from 'node:assert/strict'

import { toon } from '../shared/toon.js'
import { customRules } from '../shared/source-presets.js'
import type { SourceAiPreviewSummary } from '../shared/types.js'

test('TOON：标量、嵌套对象与数组', () => {
  assert.equal(toon({ a: 1, b: true, c: null, d: 'x' }), 'a: 1\nb: true\nc: null\nd: x')
  assert.equal(toon({ a: { b: { c: '深' } } }), 'a:\n  b:\n    c: 深')
  assert.equal(toon({ list: [1, 2, 3] }), 'list[3]: 1,2,3')
  assert.equal(toon({ empty: [] }), 'empty[0]:')
  assert.equal(toon({ nothing: {} }), 'nothing:\n  {}')
  assert.equal(toon({ skip: undefined, keep: 1 }), 'keep: 1')
})

test('TOON：需要时给字符串和键名加引号', () => {
  assert.equal(toon({ pattern: '{id}[_p{page}].{ext}' }), 'pattern: "{id}[_p{page}].{ext}"')
  assert.equal(toon({ pattern: '*.[a-z]+' }), 'pattern: "*.[a-z]+"')
  assert.equal(toon({ text: 'a, b' }), 'text: "a, b"')
  assert.equal(toon({ text: 'a: b' }), 'text: "a: b"')
  assert.equal(toon({ text: '两行\n内容' }), 'text: "两行\\n内容"')
  assert.equal(toon({ text: ' 前后空格 ' }), 'text: " 前后空格 "')
  assert.equal(toon({ text: '' }), 'text: ""')
  assert.equal(toon({ '奇怪 键': 1 }), '"奇怪 键": 1')
})

test('TOON：扁对象数组写成表格', () => {
  const text = toon({ entries: [{ name: '100_p1.jpg', type: 'file' }, { name: '作者A', type: 'directory' }] })
  assert.equal(text, 'entries[2]{name,type}:\n  100_p1.jpg,file\n  作者A,directory')
  // 列取并集，缺失列补 null
  const mixed = toon({ rows: [{ a: 1 }, { b: 2 }] })
  assert.equal(mixed, 'rows[2]{a,b}:\n  1,null\n  null,2')
})

test('TOON：嵌套数组用列表', () => {
  const text = toon({ groups: [{ id: '100', sample: ['a', 'b'] }] })
  assert.equal(text, 'groups[1]:\n  -\n    id: 100\n    sample[2]: a,b')
})

test('TOON：真实规则与自检摘要都明显比 JSON 短', () => {
  const rules = toon(customRules())
  assert.ok(rules.includes('media:\n  mode:'), rules)
  assert.ok(rules.includes('script:'))
  assert.ok(!rules.includes('":"'), '不应出现 JSON 结构')
  const summary: SourceAiPreviewSummary = {
    enumerated: 8, matched: 5, groupCount: 4, truncated: false, errors: [],
    groups: [{ id: '100', directory: '作者A', media: 2, metadata: 1, sample: ['作者A/100_p1.jpg', '作者A/100_p2.jpg'] }],
  }
  const compact = toon({ ...summary, groups: summary.groups.map(group => ({ ...group, sample: group.sample.join(' | ') })) })
  assert.ok(compact.includes('groups[1]{id,directory,media,metadata,sample}:'), compact)
  assert.ok(compact.includes('作者A/100_p1.jpg | 作者A/100_p2.jpg'))
  assert.ok(compact.length < JSON.stringify(summary).length, 'TOON 应比 JSON 短')
  assert.ok(toon(customRules()).length < JSON.stringify(customRules(), null, 2).length)
})
