import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { customRules } from '../shared/source-presets.js'
import { normalizeSourceBackground } from '../shared/background.js'

async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`等待超时：${label}`)
}

/**
 * 计算端离线时的行为：任务留在队列里等，不堆成需要人工重试的「失败项」；
 * 整个来源按 1 → 2 分钟翻倍退避，而不是每分钟撞一次。
 */
test('计算端连不上时任务回到队列并指数退避，手动继续立即重试', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'background-backoff-')), media = path.join(root, 'media')
  await mkdir(media)
  for (const name of ['1.jpg', '2.jpg']) await writeFile(path.join(media, name), name)
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  process.env.BACKGROUND_CONCURRENCY = '1'
  const { saveSources } = await import('../server/config.js')
  const { db } = await import('../server/database.js')
  const { scanLibrary } = await import('../server/scanner.js')
  const service = await import('../server/background/service.js')
  saveSources([{ id: 's', name: 'Backoff', kind: 'custom', path: media, rules: customRules() }])
  let calls = 0
  const offline = {
    manga: {
      hasManualMangaWork: () => false,
      runBackgroundMangaAsset: async () => {
        calls++
        throw Object.assign(new Error('连接远程计算端超时（3 秒）'), { code: 'compute_connect_timeout', statusCode: 504, retryable: true })
      },
    },
  }
  try {
    await scanLibrary()
    service.saveBackgroundSettings('s', { ...normalizeSourceBackground(undefined), ocr: true, maxPagesPerDay: 100 })
    await service.synchronizeBackground()
    await service.runBackgroundTick(offline)
    await waitFor(() => calls === 1 && /已退避 1 分钟/.test(service.backgroundQueue.control('s').message), '首次失败后退避 1 分钟')
    assert.equal(service.backgroundQueue.counts('s').failed, 0, '连接失败不能记成失败项')
    assert.equal(service.backgroundQueue.counts('s').queued, 2, '两张图都还在队列里')

    // 退避期内定时器每秒触发也不该再撞计算端。
    await service.runBackgroundTick(offline)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(calls, 1, '退避期内不得重试')

    // 手动「继续」清零退避：立刻再跑一次；人工干预后阶梯从 1 分钟重新开始。
    service.controlBackground('s', 'resume')
    await service.runBackgroundTick(offline)
    await waitFor(() => calls === 2 && /已退避 1 分钟/.test(service.backgroundQueue.control('s').message), '继续后立即重试')

    assert.deepEqual([1, 2, 3, 4, 5, 6].map(service.backoffDelayMs), [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000], '退避时长逐次翻倍并以 30 分钟封顶')
  } finally {
    service.stopBackgroundRuntime()
    await service.synchronizeBackground()
    delete process.env.BACKGROUND_CONCURRENCY
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
