import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { readSourceTreeDirectory, SOURCE_TREE_MAX_LENGTH } from '../server/source-tree.js'
import { summarizeRules } from '../server/source-engine.js'
import { customRules } from '../shared/source-presets.js'

test('AI 目录读取工具支持安全分页与 length 上限', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-ai-tools-'))
  try {
    await mkdir(path.join(root, 'nested'))
    await Promise.all(Array.from({ length: 6 }, (_, i) => writeFile(path.join(root, `${String(i).padStart(2, '0')}.jpg`), 'x')))
    await writeFile(path.join(root, 'nested', 'secret.txt'), 'not returned as content')
    const first = await readSourceTreeDirectory(root, '.', 0, 3)
    assert.equal(first.path, '.')
    assert.equal(first.offset, 0)
    assert.equal(first.length, 3)
    assert.equal(first.entries.length, 3)
    assert.equal(first.hasMore, true)
    const second = await readSourceTreeDirectory(root, '.', 3, SOURCE_TREE_MAX_LENGTH)
    assert.equal(second.offset, 3)
    assert.equal(second.entries.some(entry => entry.name === 'nested'), true)
    await assert.rejects(readSourceTreeDirectory(root, '.', 0, SOURCE_TREE_MAX_LENGTH + 1), /length|最大|must/i)
    await assert.rejects(readSourceTreeDirectory(root, '../', 0, 1), /越过|boundary/i)
    await assert.rejects(readSourceTreeDirectory(root, path.join(root, 'nested'), 0, 1), /相对|relative/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('规则自检摘要：只统计分组，不读取元文件内容', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-ai-preview-'))
  try {
    await writeFile(path.join(root, '100_p1.jpg'), 'x')
    await writeFile(path.join(root, '100_p2.jpg'), 'x')
    await writeFile(path.join(root, '200.jpg'), 'x')
    await writeFile(path.join(root, 'notes.txt'), 'PRIVATE METADATA CONTENT')
    const summary = await summarizeRules(root, customRules())
    assert.equal(summary.enumerated, 4)
    assert.equal(summary.matched, 3)
    assert.equal(summary.groupCount, 2)
    assert.equal(summary.truncated, false)
    assert.deepEqual(summary.errors, [])
    assert.ok(summary.groups.some(group => group.id === '100' && group.media === 2))
    assert.ok(summary.groups.some(group => group.id === '200' && group.media === 1))
    assert.ok(summary.groups.every(group => group.sample.every(name => !name.includes('\\'))))
    assert.ok(!JSON.stringify(summary).includes('PRIVATE'))
    // 规则本身不合法时应当直接报错，而不是返回一份误导性的摘要。
    await assert.rejects(summarizeRules(root, { ...customRules(), media: { mode: 'template', pattern: '{title}', caseSensitive: false } }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
