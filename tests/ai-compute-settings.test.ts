import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 本地计算设置：Key 只进不出、省略表示保留、显式清除才删除。
 *
 * 浏览器读到的设置里不能出现 Key 本体，否则任何能看到设置页的人都能拿到计算端权限。
 */

const testDir = mkdtempSync(path.join(os.tmpdir(), 'ai-compute-settings-'))
process.env.MEDIA_DATA_DIR = testDir
// 测试进程不应被外部 .env / shell 里的计算 Key 影响，先清掉再验证兜底行为。
delete process.env.COMPUTE_API_KEY

const { getAiSettings, saveAiSettings, getLocalComputeConfig, mergeLocalComputeSettings } = await import('../server/ai.js')
const { db } = await import('../server/database.js')

after(() => db.close())

const base = {
  baseUrl: 'https://example.com/v1',
  apiKey: 'online-key',
  model: 'test-model',
  targetLanguage: '简体中文',
}

test('本地计算设置：Key 不回传、缺省保留、显式清除', async t => {
  await t.test('旧配置默认回退到本地主机 + 直接报错', () => {
    const settings = getAiSettings()
    assert.equal(settings.localCompute.mode, 'local')
    assert.equal(settings.localCompute.fallback, 'error')
    assert.equal(settings.localCompute.apiKeyConfigured, false)
  })

  await t.test('本地线程默认为 1，保存与测试配置始终限制在 1–16', () => {
    assert.equal(getLocalComputeConfig().localThreads, 1)
    saveAiSettings({ ...base, localCompute: { mode:'local', localThreads:2 } })
    assert.equal(getLocalComputeConfig().localThreads, 2)
    assert.equal(mergeLocalComputeSettings({}).localThreads, 2)
    assert.equal(mergeLocalComputeSettings({ localCompute:{localThreads:999} }).localThreads, 16)
    assert.equal(mergeLocalComputeSettings({ localCompute:{localThreads:0} }).localThreads, 1)
    assert.equal(getLocalComputeConfig().localThreads, 2, '测试配置不能改动已保存限制')
  })

  await t.test('保存远程模式后，公开设置只有 apiKeyConfigured', () => {
    const saved = saveAiSettings({
      ...base,
      localCompute: { mode: 'remote', baseUrl: 'http://10.0.0.5:3211', fallback: 'local', apiKey: 'secret-key' },
    })
    assert.equal(saved.localCompute.mode, 'remote')
    assert.equal(saved.localCompute.baseUrl, 'http://10.0.0.5:3211')
    assert.equal(saved.localCompute.fallback, 'local')
    assert.equal(saved.localCompute.apiKeyConfigured, true)
    assert.equal('apiKey' in saved.localCompute, false, '不能把 Key 回传给浏览器')
    assert.equal(getLocalComputeConfig().apiKey, 'secret-key')
  })

  await t.test('再次保存时不带 Key 表示保留', () => {
    const saved = saveAiSettings({
      ...base,
      localCompute: { mode: 'remote', baseUrl: 'http://10.0.0.6:3211', fallback: 'error' },
    })
    assert.equal(saved.localCompute.apiKeyConfigured, true)
    assert.equal(getLocalComputeConfig().apiKey, 'secret-key')
    assert.equal(saved.localCompute.baseUrl, 'http://10.0.0.6:3211')
  })

  await t.test('clearApiKey 才会真正清除', () => {
    const saved = saveAiSettings({
      ...base,
      localCompute: { mode: 'local', baseUrl: 'http://10.0.0.6:3211', fallback: 'error', clearApiKey: true },
    })
    assert.equal(saved.localCompute.apiKeyConfigured, false)
    assert.equal(getLocalComputeConfig().apiKey, '')
  })

  await t.test('远程模式必须填合法地址', () => {
    assert.throws(
      () => saveAiSettings({ ...base, localCompute: { mode: 'remote', baseUrl: 'ftp://bad' } }),
      /远程计算端地址/,
    )
  })

  await t.test('测试连接可以带未保存的 Key，但不落盘', () => {
    const merged = mergeLocalComputeSettings({
      localCompute: { mode: 'remote', baseUrl: 'http://10.0.0.7:3211', apiKey: 'temporary' },
    })
    assert.equal(merged.baseUrl, 'http://10.0.0.7:3211')
    assert.equal(merged.apiKey, 'temporary')
    // 合并只用于本次请求，已保存的配置仍然没有 Key。
    assert.equal(getLocalComputeConfig().apiKey, '')
  })

  await t.test('没有保存 Key 时用 COMPUTE_API_KEY 兜底，便于两端共用一份 .env', () => {
    process.env.COMPUTE_API_KEY = 'env-fallback-key'
    try {
      assert.equal(getLocalComputeConfig().apiKey, 'env-fallback-key')
      assert.equal(getAiSettings().localCompute.apiKeyConfigured, true)
    } finally {
      delete process.env.COMPUTE_API_KEY
    }
    assert.equal(getLocalComputeConfig().apiKey, '')
    assert.equal(getAiSettings().localCompute.apiKeyConfigured, false)
  })

  await t.test('已保存的 Key 优先于环境变量', () => {
    saveAiSettings({ ...base, localCompute: { mode: 'remote', baseUrl: 'http://10.0.0.8:3211', apiKey: 'saved-key' } })
    process.env.COMPUTE_API_KEY = 'env-fallback-key'
    try {
      assert.equal(getLocalComputeConfig().apiKey, 'saved-key')
    } finally {
      delete process.env.COMPUTE_API_KEY
    }
  })
})
