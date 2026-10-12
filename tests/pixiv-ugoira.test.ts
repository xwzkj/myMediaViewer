import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { zipSync } from 'fflate'

test('Ugoira 帧包会缓存并转换为可播放动画', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-ugoira-'))
  process.env.MEDIA_DATA_DIR = path.join(root, 'data')
  const first = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer()
  const second = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0000ff' } }).png().toBuffer()
  const zip = zipSync({ '000.png': first, '001.png': second })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(zip, { status: 200, headers: { 'Content-Type': 'application/zip' } })) as typeof fetch
  try {
    const { prepareUgoira } = await import('../server/pixiv/ugoira.js')
    const { db } = await import('../server/database.js')
    try {
      const result = await prepareUgoira('123', 'https://i.pximg.net/ugoira.zip', [
        { file: '000.png', delay: 100 },
        { file: '001.png', delay: 100 },
      ])
      assert.ok(result.size > 0)
      assert.ok(result.contentType === 'video/webm' || result.contentType === 'image/webp')
    } finally {
      db.close()
    }
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
