import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { zipSync } from 'fflate'

/**
 * Ugoira 资源预算与错误语义。
 *
 * 不再有"超过 240 帧一律拒绝"的规则，但帧数、单帧字节、单帧像素和总时长仍有
 * 明确上限；超限时抛出可公开的类型化错误，并且不会留下缓存产物。
 */

const root = await mkdtemp(path.join(os.tmpdir(), 'ugoira-limits-'))
process.env.MEDIA_DATA_DIR = path.join(root, 'data')

const { prepareUgoira, UgoiraError } = await import('../server/pixiv/ugoira.js')
const { db } = await import('../server/database.js')
const { findCachedPixivResource, pixivCacheKey } = await import('../server/pixiv/cache.js')

after(async () => {
  db.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function frameBuffer(width = 16, height = 16, color = '#3366cc'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

/** 用 fetch 桩把一次下载指向本地构造的 ZIP。 */
async function withArchive<T>(archive: Uint8Array, task: (zipUrl: string) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(archive, { status: 200, headers: { 'Content-Type': 'application/zip' } })) as typeof fetch
  try {
    return await task(`https://i.pximg.net/ugoira-${Math.random().toString(36).slice(2)}.zip`)
  } finally {
    globalThis.fetch = original
  }
}

/** 临时设置预算环境变量，结束后恢复，避免子用例互相影响。 */
async function withBudget<T>(vars: Record<string, string>, task: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await task()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function framesOf(count: number, file = '000.png', delay = 40) {
  return Array.from({ length: count }, () => ({ file, delay }))
}

test('Ugoira 资源预算：允许 241 帧，超限返回可公开错误', async t => {
  // 两帧交替：sharp 会把完全相同的连续帧合并，交替帧才能验证真实帧数被保留。
  const red = await frameBuffer(16, 16, '#ff0000')
  const blue = await frameBuffer(16, 16, '#0000ff')
  const archive = zipSync({ '000.png': red, '001.png': blue })
  const alternating = Array.from({ length: 241 }, (_value, index) => ({
    file: index % 2 === 0 ? '000.png' : '001.png',
    delay: 40,
  }))

  await t.test('241 帧、预算内可正常转成动画 WebP', async () => {
    await withArchive(archive, async zipUrl => {
      const result = await prepareUgoira('241', zipUrl, alternating, 'webp')
      assert.equal(result.contentType, 'image/webp')
      const metadata = await sharp(await readFile(result.path), { animated: true }).metadata()
      assert.equal(metadata.pages, 241)
    })
  })

  await t.test('超过帧数上限时返回 413 + ugoira_resource_limit', async () => {
    await withBudget({ UGOIRA_MAX_FRAMES: '10' }, () => withArchive(archive, async zipUrl => {
      await assert.rejects(
        () => prepareUgoira('too-many', zipUrl, framesOf(11), 'webp'),
        (error: unknown) => {
          assert.ok(error instanceof UgoiraError)
          assert.equal(error.statusCode, 413)
          assert.equal(error.code, 'ugoira_resource_limit')
          assert.equal(error.expose, true)
          assert.equal(error.details?.limit, 10)
          return true
        },
      )
    }))
  })

  await t.test('单帧字节超限时及时中止，且不登记成品缓存', async () => {
    await withBudget({ UGOIRA_MAX_FRAME_BYTES: '32' }, () => withArchive(archive, async zipUrl => {
      await assert.rejects(
        () => prepareUgoira('too-big', zipUrl, framesOf(2), 'webp'),
        (error: unknown) => error instanceof UgoiraError && error.statusCode === 413 && error.code === 'ugoira_resource_limit',
      )
    }))
    assert.equal(findCachedPixivResource(pixivCacheKey('ugoira', 'too-big', 0, 'animation-webp-v2')), null)
  })

  await t.test('非法帧时长返回 422', async () => {
    const invalidDelay = framesOf(1)
    invalidDelay[0]!.delay = 0
    await assert.rejects(
      () => prepareUgoira('bad-delay', 'https://i.pximg.net/x.zip', invalidDelay, 'webp'),
      (error: unknown) => error instanceof UgoiraError && error.statusCode === 422 && error.code === 'ugoira_invalid_frames',
    )
  })

  await t.test('压缩包缺少引用的帧返回 422', async () => {
    await withArchive(archive, async zipUrl => {
      await assert.rejects(
        () => prepareUgoira('missing-frame', zipUrl, [{ file: '999.png', delay: 40 }], 'webp'),
        (error: unknown) => error instanceof UgoiraError && error.statusCode === 422 && error.code === 'ugoira_invalid_archive',
      )
    })
  })

  await t.test('总时长超限返回 413，且不会退化成更耗内存的 WebP', async () => {
    await withBudget({ UGOIRA_MAX_DURATION_MS: '1000' }, () => withArchive(archive, async zipUrl => {
      await assert.rejects(
        () => prepareUgoira('too-long', zipUrl, framesOf(40, '000.png', 100), 'auto'),
        (error: unknown) => error instanceof UgoiraError && error.statusCode === 413 && error.code === 'ugoira_resource_limit',
      )
    }))
  })
})
