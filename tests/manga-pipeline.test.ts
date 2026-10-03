import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

test('漫画流水线默认边识别边并发翻译、并发数 3', () => {
  save({})
  const settings = getAiSettings()
  assert.equal(settings.mangaPipelineMode, 'streaming')
  assert.equal(settings.mangaConcurrency, 3)
})

test('四种流水线模式都能保存并读回', () => {
  for (const mode of ['sequential', 'merged', 'parallel', 'streaming'] as const) {
    save({ mangaPipelineMode: mode })
    assert.equal(getAiSettings().mangaPipelineMode, mode)
  }
})

test('非法模式回落到默认异步模式', () => {
  save({ mangaPipelineMode: 'sequential' })
  save({ mangaPipelineMode: 'turbo' })
  assert.equal(getAiSettings().mangaPipelineMode, 'streaming')
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

test('旧配置缺少新字段时自动补默认值', async () => {
  // 直接写一份不含新字段的配置，模拟升级前的 ai.json
  writeFileSync(path.join(process.env.MEDIA_DATA_DIR!, 'ai.json'), JSON.stringify({ model: 'm' }))
  const modulePath = '../server/ai.js?legacy-settings'
  const { getAiSettings: readLegacySettings } = await import(modulePath)
  const settings = readLegacySettings()
  assert.equal(settings.mangaPipelineMode, 'streaming')
  assert.equal(settings.mangaConcurrency, 3)
})
