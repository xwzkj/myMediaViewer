import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { zipSync } from 'fflate'
import Fastify from 'fastify'

test('Ugoira 转码、格式回退与 Range 响应', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-ugoira-'))
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  const first = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ff0000' } }).png().toBuffer()
  const second = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#0000ff' } }).png().toBuffer()
  const zip = zipSync({ '000.png': first, '001.png': second })
  const originalFetch = globalThis.fetch
  let downloads = 0
  globalThis.fetch = (async input => {
    if (String(input).includes('oauth.secure.pixiv.net')) return Response.json({ access_token: 'fixture', refresh_token: 'fixture', expires_in: 3600, user: { id: '42' } })
    downloads++
    return new Response(zip, { status: 200, headers: { 'Content-Type': 'application/zip' } })
  }) as typeof fetch
  try {
    const { prepareUgoira } = await import('../server/pixiv/ugoira.js')
    const { db } = await import('../server/database.js')
    const media = await import('../server/media.js')
    const { detectFFmpeg, runFFmpeg } = media
    const { registerPixivResource, pixivCacheKey } = await import('../server/pixiv/cache.js')
    const { cloudAssets } = await import('../server/pixiv/catalog.js')
    const { UGOIRA_ENCODING_VERSION } = await import('../shared/ugoira.js')
    const { savePixivSettings } = await import('../server/pixiv/auth.js')
    const { normalizePixivIllust } = await import('../server/pixiv/catalog.js')
    const { savePixivWorkRecords } = await import('../server/pixiv/store.js')
    const { registerPixivRoutes } = await import('../server/pixiv/routes.js')
    const app = Fastify()
    const frames = [{ file: '000.png', delay: 80 }, { file: '001.png', delay: 160 }]
    try {
      await savePixivSettings({ refreshToken: 'fixture', localMode: false })
      await t.test('无 FFmpeg 时生成动画 WebP，保留帧数和延迟', async () => {
        const result = await prepareUgoira('123', 'https://i.pximg.net/ugoira.zip', frames)
        assert.ok(result.size > 0)
        assert.equal(result.contentType, 'image/webp')
        const metadata = await sharp(await readFile(result.path), { animated: true }).metadata()
        assert.equal(metadata.pages, 2)
        assert.deepEqual(metadata.delay, [80, 160])
        assert.equal(metadata.loop, 0)
      })
      await detectFFmpeg()
      await t.test('视频缓存不影响强制 WebP，复用 ZIP 并合并并发转码', async () => {
        const video = await prepareUgoira('456', 'https://i.pximg.net/ugoira.zip', frames)
        if (media.ffmpegAvailable) assert.equal(video.contentType, 'video/webm')
        const before = downloads
        const pending = prepareUgoira('456', 'https://i.pximg.net/ugoira.zip', frames, 'webp')
        assert.equal(prepareUgoira('456', 'https://i.pximg.net/ugoira.zip', frames, 'webp'), pending)
        const image = await pending
        assert.equal(image.contentType, 'image/webp')
        assert.notEqual(image.path, video.path)
        assert.equal(downloads, before)
        assert.equal((await prepareUgoira('456', 'https://i.pximg.net/ugoira.zip', frames)).path, video.path)
        assert.equal((await prepareUgoira('456', 'https://i.pximg.net/ugoira.zip', frames, 'webp')).path, image.path)
      })
      await t.test('升级编码版本重新生成动画，复用原 ZIP 并更新浏览器地址', async () => {
        const previous = await prepareUgoira('789', 'https://i.pximg.net/ugoira.zip', frames, 'webp')
        registerPixivResource(pixivCacheKey('ugoira', '789', 0, 'animation'), previous.path, previous.size, previous.contentType)
        const before = downloads
        const current = await prepareUgoira('789', 'https://i.pximg.net/ugoira.zip', frames)
        assert.notEqual(current.path, previous.path)
        assert.equal(downloads, before)
        const work = normalizePixivIllust({ id: 789, type: 'ugoira' })
        assert.equal(cloudAssets('789', work.work, work.meta)[0].url, `/api/pixiv/ugoira/789/animation?v=${UGOIRA_ENCODING_VERSION}`)
      })
      await t.test('VP9 保留不等帧间隔和最后一帧时长，不插帧或丢帧', { skip: !media.ffmpegAvailable }, async () => {
        const timed = [{ file: '000.png', delay: 30 }, { file: '001.png', delay: 70 }, { file: '000.png', delay: 110 }]
        const result = await prepareUgoira('987', 'https://i.pximg.net/ugoira.zip', timed)
        assert.equal(result.contentType, 'video/webm')
        const checksum = path.join(root, 'packets.txt')
        await runFFmpeg(['-y', '-i', result.path, '-map', '0:v:0', '-c:v', 'copy', '-f', 'framecrc', checksum])
        const data = await readFile(checksum, 'utf8')
        assert.match(data, /#tb 0: 1\/1000/)
        const packets = data.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').map(value => Number(value.trim())))
        assert.deepEqual(packets.map(packet => packet[2]), [0, 30, 100])
        assert.deepEqual(packets.map(packet => packet[3]), [30, 70, 110])
      })
      await registerPixivRoutes(app)
      const record = normalizePixivIllust({ id: 456, type: 'ugoira', page_count: 1, image_urls: { large: 'https://i.pximg.net/456.png' } })
      record.meta.ugoira = { zipUrl: 'https://i.pximg.net/ugoira.zip', frames }
      record.meta.bookmarkTags = []
      record.meta.detailFetchedAt = Date.now()
      savePixivWorkRecords('42', [record])
      await t.test('回退接口返回真实动画 WebP，Range 返回正确字节及 MIME', async () => {
        const image = await app.inject('/api/pixiv/ugoira/456/animation?format=webp')
        assert.equal(image.statusCode, 200)
        assert.equal(image.headers['content-type'], 'image/webp')
        assert.equal((await sharp(image.rawPayload, { animated: true }).metadata()).pages, 2)
        const full = await app.inject('/api/pixiv/ugoira/456/animation')
        const partial = await app.inject({ url: '/api/pixiv/ugoira/456/animation', headers: { range: 'bytes=0-31' } })
        assert.equal(partial.statusCode, 206)
        assert.equal(partial.headers['content-type'], full.headers['content-type'])
        assert.equal(partial.headers['content-range'], `bytes 0-31/${full.rawPayload.length}`)
        assert.deepEqual(partial.rawPayload, full.rawPayload.subarray(0, 32))
        assert.equal((await app.inject('/api/pixiv/ugoira/456/animation?format=invalid')).statusCode, 400)
      })
      await t.test('准备接口返回真实 MIME 与可播放地址，且复用同一份缓存', async () => {
        const prepared = await app.inject({
          url: '/api/pixiv/ugoira/456/prepare',
          method: 'POST',
          payload: { format: 'webp' },
        })
        assert.equal(prepared.statusCode, 200)
        const body = prepared.json() as { url: string; contentType: string }
        assert.equal(body.contentType, 'image/webp')
        assert.equal(body.url, '/api/pixiv/ugoira/456/animation?format=webp')
        const media = await app.inject(body.url)
        assert.equal(media.statusCode, 200)
        assert.equal(media.headers['content-type'], 'image/webp')
      })
    } finally {
      await app.close()
      db.close()
    }
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
