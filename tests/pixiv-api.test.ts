import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('Pixiv 设置默认不泄露 token，本地模式拒绝云接口', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixiv-api-'))
  const data = path.join(root, 'data')
  const media = path.join(root, 'media')
  await mkdir(data, { recursive: true })
  await mkdir(media, { recursive: true })
  await writeFile(path.join(data, 'sources.json'), '[]')
  await writeFile(path.join(media, '1-2_p0.jpg'), 'x')
  process.env.MEDIA_DATA_DIR = data
  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const app = await createApp(false)
  try {
    const settings = await app.inject('/api/pixiv/settings')
    assert.equal(settings.statusCode, 200)
    assert.equal(settings.json().configured, false)
    assert.equal('refreshToken' in settings.json(), false)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/pixiv/settings', payload: { localMode: true } })).statusCode, 200)
    assert.equal((await app.inject('/api/pixiv/search?q=test')).statusCode, 403)
  } finally {
    await app.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
