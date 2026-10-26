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

test('远程模式一次补满后台流水线，而不是算完一页再等定时器', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'background-pipeline-')), media = path.join(root, 'media')
  await mkdir(media)
  for (let i = 1; i <= 4; i++) await writeFile(path.join(media, `${i}.jpg`), `image-${i}`)
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  process.env.COMPUTE_API_KEY = 'pipeline-key'
  process.env.BACKGROUND_CONCURRENCY = '2'
  const { saveSources } = await import('../server/config.js')
  const { saveAiSettings, getAiSettings } = await import('../server/ai.js')
  const { db } = await import('../server/database.js')
  const { scanLibrary } = await import('../server/scanner.js')
  const service = await import('../server/background/service.js')
  saveSources([{ id: 's', name: 'Pipeline', kind: 'custom', path: media, rules: customRules() }])
  const base = getAiSettings()
  saveAiSettings({
    ...base,
    localCompute: { ...base.localCompute, mode: 'remote', baseUrl: 'http://127.0.0.1:3211', fallback: 'error', apiKey: 'pipeline-key' },
  })
  let started = 0, active = 0, peak = 0
  const releases: Array<() => void> = []
  const runtime = {
    manga: {
      hasManualMangaWork: () => false,
      runBackgroundMangaAsset: async () => {
        started++; peak = Math.max(peak, ++active)
        await new Promise<void>(resolve => releases.push(resolve))
        active--
      },
    },
  }
  try {
    await scanLibrary()
    service.saveBackgroundSettings('s', { ...normalizeSourceBackground(undefined), ocr: true, maxPagesPerDay: 100 })
    await service.synchronizeBackground()
    assert.equal(service.backgroundQueue.counts('s').queued, 4)

    await service.runBackgroundTick(runtime)
    await waitFor(() => started === 2, '同时启动两个后台任务')
    assert.equal(peak, 2)
    assert.equal(service.backgroundQueue.counts('s').running, 2)
    assert.equal(service.getBackgroundStatus().active.length, 2)

    for (const release of releases.splice(0)) release()
    await waitFor(() => started === 4, '空位立即补上，不等 1 秒定时器')
    assert.equal(peak, 2, '并发数不应超过配置')
    for (const release of releases.splice(0)) release()
    await waitFor(() => service.backgroundQueue.counts('s').done === 4, '全部任务完成')
    assert.equal(active, 0)
  } finally {
    service.stopBackgroundRuntime()
    await service.synchronizeBackground()
    db.close()
    delete process.env.BACKGROUND_CONCURRENCY
    delete process.env.COMPUTE_API_KEY
    await rm(root, { recursive: true, force: true })
  }
})
