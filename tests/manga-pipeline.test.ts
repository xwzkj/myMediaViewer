import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// config.ts 在导入时就会解析数据目录，必须在动态 import 之前指定。
process.env.MEDIA_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'media-manga-pipeline-'))

const { saveAiSettings, getAiSettings } = await import('../server/ai.js')

function save(patch: Record<string, unknown>) {
  saveAiSettings({
    baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', targetLanguage: '简体中文',
    params: {}, timeoutMs: 120000, ...patch,
  })
}

test('漫画流水线默认逐页处理、并发数 3', () => {
  save({})
  const settings = getAiSettings()
  assert.equal(settings.mangaPipelineMode, 'sequential')
  assert.equal(settings.mangaConcurrency, 3)
})

test('三种流水线模式都能保存并读回', () => {
  for (const mode of ['sequential', 'merged', 'parallel'] as const) {
    save({ mangaPipelineMode: mode })
    assert.equal(getAiSettings().mangaPipelineMode, mode)
  }
})

test('非法模式回落到逐页处理', () => {
  save({ mangaPipelineMode: 'turbo' })
  assert.equal(getAiSettings().mangaPipelineMode, 'sequential')
})

test('并发数被夹在 1 - 10 之间', () => {
  save({ mangaConcurrency: 0 })
  assert.equal(getAiSettings().mangaConcurrency, 1)
  save({ mangaConcurrency: 999 })
  assert.equal(getAiSettings().mangaConcurrency, 10)
  save({ mangaConcurrency: 4.6 })
  assert.equal(getAiSettings().mangaConcurrency, 5)
  save({ mangaConcurrency: 'abc' })
  assert.equal(getAiSettings().mangaConcurrency, 3)
})

test('旧配置缺少新字段时自动补默认值', () => {
  // 直接写一份不含新字段的配置，模拟升级前的 ai.json
  save({})
  const settings = getAiSettings()
  assert.equal(settings.mangaPipelineMode, 'sequential')
  assert.equal(settings.mangaConcurrency, 3)
})
