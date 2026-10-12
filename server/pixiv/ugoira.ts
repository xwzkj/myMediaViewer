import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { unzipSync } from 'fflate'
import { cacheDir, ffmpegPath } from '../config.js'
import { ffmpegAvailable } from '../media.js'
import { findCachedPixivResource, getOrCachePixivResource, registerPixivResource, pixivCacheKey, type CachedResource } from './cache.js'

const MAX_FRAMES = 240
const MAX_UNZIP_BYTES = 512 * 1024 * 1024
const inFlight = new Map<string, Promise<CachedResource>>()

function safeFrameName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null
  return normalized.split('/').pop() || null
}

function runFFmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Ugoira 转码超时')) }, timeoutMs)
    child.stderr.on('data', chunk => { error += chunk.toString().slice(-4000) })
    child.once('error', err => { clearTimeout(timer); reject(err) })
    child.once('exit', code => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(error.trim() || `FFmpeg 退出码 ${code}`))
    })
  })
}

async function renderWebm(frames: Array<{ file: string; delay: number }>, files: string[], tempDir: string, output: string): Promise<void> {
  const listPath = path.join(tempDir, 'frames.txt')
  const lines: string[] = []
  frames.forEach((frame, index) => {
    const escaped = files[index].replace(/'/g, "'\\''")
    lines.push(`file '${escaped}'`)
    lines.push(`duration ${Math.max(0.01, frame.delay / 1000).toFixed(3)}`)
  })
  if (files.length) lines.push(`file '${files.at(-1)!.replace(/'/g, "'\\''")}'`)
  await fs.writeFile(listPath, `${lines.join('\n')}\n`, 'utf8')
  await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-an', '-row-mt', '1', output], 5 * 60_000)
}

async function renderWebp(frames: Array<{ file: string; delay: number }>, files: string[], output: string): Promise<void> {
  const buffers = await Promise.all(files.map(file => fs.readFile(file)))
  await sharp(buffers, { join: { animated: true } }).webp({
    quality: 86,
    effort: 4,
    loop: 0,
    delay: frames.map(frame => Math.min(65_535, Math.max(10, Math.round(frame.delay)))),
  }).toFile(output)
}

export function prepareUgoira(illustId: string, zipUrl: string, frames: Array<{ file: string; delay: number }>): Promise<CachedResource> {
  const key = pixivCacheKey('ugoira', illustId, 0, 'animation')
  const cached = findCachedPixivResource(key)
  if (cached) return Promise.resolve(cached)
  const running = inFlight.get(key)
  if (running) return running
  const task = (async () => {
    if (!frames.length) throw new Error('Ugoira 没有可播放的帧')
    if (frames.length > MAX_FRAMES) throw new Error(`Ugoira 帧数超过 ${MAX_FRAMES}，已停止转换`)
    const zip = await getOrCachePixivResource(pixivCacheKey('ugoira', illustId, 0, 'zip'), zipUrl, 'application/zip', MAX_UNZIP_BYTES)
    const archive = unzipSync(new Uint8Array(await fs.readFile(zip.path)))
    const byName = new Map<string, Uint8Array>()
    let total = 0
    for (const [name, data] of Object.entries(archive)) {
      total += data.byteLength
      if (total > MAX_UNZIP_BYTES) throw new Error('Ugoira 解压后超过大小限制')
      byName.set(name, data)
    }
    const tempDir = path.join(cacheDir, 'pixiv', 'tmp', randomUUID())
    await fs.mkdir(tempDir, { recursive: true })
    const files: string[] = []
    try {
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]
        const source = byName.get(frame.file) || byName.get(frame.file.replace(/\\/g, '/'))
        if (!source) throw new Error(`Ugoira 缺少帧 ${frame.file}`)
        const name = safeFrameName(frame.file) || `${index}.png`
        const file = path.join(tempDir, `${String(index).padStart(4, '0')}-${name}`)
        await fs.writeFile(file, source)
        files.push(file)
      }
      const outputId = key.replace(/[^a-zA-Z0-9-]/g, '-')
      const webm = path.join(cacheDir, 'pixiv', `${outputId}.webm`)
      const webp = path.join(cacheDir, 'pixiv', `${outputId}.webp`)
      if (ffmpegAvailable) {
        try {
          await renderWebm(frames, files, tempDir, webm)
          const info = await fs.stat(webm)
          return registerPixivResource(key, webm, info.size, 'video/webm')
        } catch { /* Fall back to animated WebP. */ }
      }
      await renderWebp(frames, files, webp)
      const info = await fs.stat(webp)
      return registerPixivResource(key, webp, info.size, 'image/webp')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}
