import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { unzipSync } from 'fflate'
import { cacheDir } from '../config.js'
import { ffmpegAvailable, runFFmpeg } from '../media.js'
import { logWarn, oneLine } from '../log.js'
import { UGOIRA_ENCODING_VERSION } from '../../shared/ugoira.js'
import { findCachedPixivResource, getOrCachePixivResource, registerPixivResource, pixivCacheKey, type CachedResource } from './cache.js'

const MAX_FRAMES = 240
const MAX_UNZIP_BYTES = 512 * 1024 * 1024
const inFlight = new Map<string, Promise<CachedResource>>()

function safeFrameName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null
  return normalized.split('/').pop() || null
}

async function renderWebm(frames: Array<{ file: string; delay: number }>, files: string[], tempDir: string, output: string): Promise<void> {
  const listPath = path.join(tempDir, 'frames.txt')
  const lines: string[] = []
  const delays = frames.map(frame => Math.max(10, Math.round(frame.delay)))
  frames.forEach((frame, index) => {
    const escaped = files[index].replace(/'/g, "'\\''")
    lines.push(`file '${escaped}'`)
    // image2 defaults to 25 fps (40 ms ticks), which rounds Ugoira frame delays.
    lines.push('option framerate 1000')
    lines.push(`duration ${(delays[index] / 1000).toFixed(3)}`)
  })
  await fs.writeFile(listPath, `${lines.join('\n')}\n`, 'utf8')
  // Set each packet's duration, including the final frame; no duplicate tail frame.
  const durations = `setts=duration=if(eq(N\\,${frames.length - 1})\\,${(delays.at(-1)! / 1000).toFixed(3)}/TB\\,NEXT_PTS-PTS)`
  await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-c:v', 'libvpx-vp9',
    '-crf', '18', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2',
    '-profile:v', '0', '-pix_fmt', 'yuv420p', '-an', '-row-mt', '1',
    '-bsf:v', durations, output], 5 * 60_000)
}

async function renderWebp(frames: Array<{ file: string; delay: number }>, files: string[], output: string): Promise<void> {
  const buffers = await Promise.all(files.map(file => fs.readFile(file)))
  await sharp(buffers, { join: { animated: true } }).webp({
    quality: 95,
    effort: 4,
    loop: 0,
    delay: frames.map(frame => Math.min(65_535, Math.max(10, Math.round(frame.delay)))),
  }).toFile(output)
}

export function prepareUgoira(illustId: string, zipUrl: string, frames: Array<{ file: string; delay: number }>, format: 'auto' | 'webp' = 'auto'): Promise<CachedResource> {
  // A browser that cannot decode VP9 must receive a real image, even if WebM is cached.
  const variant = format === 'webp' ? 'animation-webp' : 'animation'
  const key = pixivCacheKey('ugoira', illustId, 0, `${variant}-v${UGOIRA_ENCODING_VERSION}`)
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
      const webm = path.join(tempDir, 'animation.webm')
      const webp = path.join(tempDir, 'animation.webp')
      async function publish(file: string, extension: string, contentType: string) {
        const target = path.join(cacheDir, 'pixiv', `${outputId}.${extension}`)
        await fs.rename(file, target)
        const info = await fs.stat(target)
        return registerPixivResource(key, target, info.size, contentType)
      }
      if (format === 'auto' && ffmpegAvailable) {
        try {
          await renderWebm(frames, files, tempDir, webm)
          return await publish(webm, 'webm', 'video/webm')
        } catch (error) {
          logWarn('Ugoira', `${illustId} WebM 转码失败，回退动画 WebP：${oneLine((error as Error).message, 200)}`)
        }
      }
      await renderWebp(frames, files, webp)
      return await publish(webp, 'webp', 'image/webp')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}
