import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeSearchToken, replaceWithTag, searchTokens, tagQuery } from '../shared/search-query.js'

test('搜索词拆分：普通关键词、标签与带引号的标签', () => {
  assert.deepEqual(searchTokens('山林 风景'), [
    { value: '山林', tag: false, start: 0, end: 2 },
    { value: '风景', tag: false, start: 3, end: 5 },
  ])
  assert.deepEqual(searchTokens('#山林 风景').map(token => [token.value, token.tag]), [['山林', true], ['风景', false]])
  assert.deepEqual(searchTokens('＃"初音 未来" 风景').map(token => [token.value, token.tag]), [['初音 未来', true], ['风景', false]])
  assert.deepEqual(searchTokens('#"a\\"b"').map(token => [token.value, token.tag]), [['a"b', true]])
})

test('标签查询串：普通标签直接拼接，含空格或引号时转义', () => {
  assert.equal(tagQuery('山林'), '#山林')
  assert.equal(tagQuery('初音 未来'), '#"初音 未来"')
  assert.equal(tagQuery('a"b'), '#"a\\"b"')
})

test('光标所在的搜索词：优先整体包含光标的词，其次是紧跟光标之后的词', () => {
  assert.equal(activeSearchToken('山间 旅行', 1).value, '山间')
  assert.equal(activeSearchToken('山间 旅行', 2).value, '山间')
  assert.equal(activeSearchToken('山间 旅行', 3).value, '旅行')
  assert.equal(activeSearchToken('山间 旅行', 5).value, '旅行')
  assert.equal(activeSearchToken('', 0).value, '')
  assert.equal(activeSearchToken('#山林 风景', 5).value, '风景')
  assert.equal(activeSearchToken('#山林 风景', 5).tag, false)
})

test('选择标签建议后只替换光标处的关键词并保留后续关键词', () => {
  assert.deepEqual(replaceWithTag('', 0, '山林'), { query: '#山林 ', caret: 4 })
  assert.deepEqual(replaceWithTag('山', 1, '山林'), { query: '#山林 ', caret: 4 })
  assert.deepEqual(replaceWithTag('山 风景', 1, '山林'), { query: '#山林 风景', caret: 4 })
  assert.deepEqual(replaceWithTag('风景', 2, '初音 未来'), { query: '#"初音 未来" ', caret: 9 })
})
