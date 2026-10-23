import { randomUUID } from 'node:crypto'
import { promises as fs, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { Unzip, UnzipInflate } from 'fflate'
import { cacheDir } from '../config.js'
import { ffmpegAvailable, runFFmpeg } from '../media.js'
import { logWarn, oneLine } from '../log.js'
import { UGOIRA_ENCODING_VERSION } from '../../shared/ugoira.js'
import { findCachedPixivResource, getOrCachePixivResource, registerPixivResource, pixivCacheKey, type CachedResource } from './cache.js'
import { UgoiraError } from './errors.js'

/**
 * Ugoira（Pixiv 动图）转码。
 *
 * 早先的实现用一条「超过 240 帧就拒绝」的规则；这条规则挡掉了很多正常作品，
 * 而且限制发生在全量解压之后，既不能保护内存也不能防 zip bomb。
 *
 * 现在改用一组可配置的预算：只解压元数据真正引用的帧、按实际输出字节及时中止、
 * 单独限制 WebP 的累计解码像素。超限时返回可公开的具体原因（帧数/字节/像素/超时），
 * 而不是让前端只看到一句「无法读取这张图片」。
 */

/** 计算端只做输入校验与流式处理，不做全局转码调度。预算可用环境变量调整。 */
function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

interface UgoiraBudget {
  maxFrames: number
  maxUnzipBytes: number
  maxFrameBytes: number
  maxFramePixels: number
  webpMaxPixels: number
  maxDurationMs: number
  maxOutputBytes: number
  timeoutMs: number
}

/** 每次调用时读取，方便测试注入小预算。 */
function budget(): UgoiraBudget {
  return {
    maxFrames: positiveEnv('UGOIRA_MAX_FRAMES', 10_000),
    maxUnzipBytes: positiveEnv('UGOIRA_MAX_UNZIP_BYTES', 512 * 1024 * 1024),
    maxFrameBytes: positiveEnv('UGOIRA_MAX_FRAME_BYTES', 64 * 1024 * 1024),
    maxFramePixels: positiveEnv('UGOIRA_MAX_FRAME_PIXELS', 16_000_000),
    webpMaxPixels: positiveEnv('UGOIRA_WEBP_MAX_TOTAL_PIXELS', 128_000_000),
    maxDurationMs: positiveEnv('UGOIRA_MAX_DURATION_MS', 10 * 60_000),
    maxOutputBytes: positiveEnv('UGOIRA_MAX_OUTPUT_BYTES', 256 * 1024 * 1024),
    timeoutMs: positiveEnv('UGOIRA_TIMEOUT_MS', 10 * 60_000),
  }
}

/** 可安全展示给用户的 Ugoira 错误：定义在 errors.ts，这里重新导出便于调用方引用。 */
export { UgoiraError } from './errors.js'

const inFlight = new Map<string, Promise<CachedResource>>()

function safeFrameName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null
  return normalized.split('/').pop() || null
}

/** 校验元数据里的帧列表，去掉重复与非法延迟。 */
function validateFrames(frames: Array<{ file: string; delay: number }>, limits: UgoiraBudget): number[] {
  if (!frames.length) throw new UgoiraError('Ugoira 没有可播放的帧', 422, 'ugoira_invalid_frames')
  if (frames.length > limits.maxFrames) {
    throw new UgoiraError(
      `Ugoira 有 ${frames.length} 帧，超过单次转换上限 ${limits.maxFrames} 帧`,
      413, 'ugoira_resource_limit', false, { observed: frames.length, limit: limits.maxFrames },
    )
  }
  const seen = new Set<string>()
  const delays: number[] = []
  for (const frame of frames) {
    if (!frame.file || !safeFrameName(frame.file)) throw new UgoiraError('Ugoira 帧路径无效', 422, 'ugoira_invalid_frames')
    // 同一个文件可以被多帧复用（Pixiv 常见），这里只校验路径本身可用。
    seen.add(frame.file)
    const delay = Number(frame.delay)
    if (!Number.isFinite(delay) || delay <= 0) throw new UgoiraError('Ugoira 帧时长无效', 422, 'ugoira_invalid_frames')
    delays.push(Math.max(10, Math.round(delay)))
  }
  const duration = delays.reduce((sum, value) => sum + value, 0)
  if (duration > limits.maxDurationMs) {
    throw new UgoiraError(
      `Ugoira 总时长 ${Math.round(duration / 1000)} 秒，超过单次转换上限 ${Math.round(limits.maxDurationMs / 1000)} 秒`,
      413, 'ugoira_resource_limit', false, { observed: duration, limit: limits.maxDurationMs },
    )
  }
  return delays
}

/**
 * 只解压元数据引用到的帧，并在解压过程中按实际输出字节中止。
 *
 * fflate 的流式 Unzip 对未调 start() 的条目不会解压，所以未引用的条目（包括
 * 解压后会膨胀的垃圾数据）不会进入内存；每个条目内部按 chunk 计数，超限立刻抛出。
 */
async function extractFrames(
  archive: Buffer,
  frames: Array<{ file: string; delay: number }>,
  tempDir: string,
  limits: UgoiraBudget,
): Promise<string[]> {
  // 同一个源文件可能被多帧复用，因此名字映射到一组帧下标。
  const indexed = new Map<string, number[]>()
  frames.forEach((frame, index) => {
    for (const name of new Set([frame.file, frame.file.replace(/\\/g, '/')])) {
      const list = indexed.get(name)
      if (list) { if (!list.includes(index)) list.push(index) }
      else indexed.set(name, [index])
    }
  })
  const files: string[] = new Array(frames.length)
  let written = 0

  const unzipper = new Unzip(file => {
    const targets = indexed.get(file.name) ?? indexed.get(file.name.replace(/\\/g, '/'))
    if (!targets) return
    const chunks: Uint8Array[] = []
    let frameBytes = 0
    file.ondata = (error, chunk, final) => {
      if (error) throw error
      frameBytes += chunk.length
      written += chunk.length
      if (frameBytes > limits.maxFrameBytes) {
        throw new UgoiraError(`Ugoira 单帧解压后超过 ${Math.round(limits.maxFrameBytes / 1048576)} MB 上限`, 413, 'ugoira_resource_limit')
      }
      if (written > limits.maxUnzipBytes) {
        throw new UgoiraError(
          `Ugoira 解压后超过 ${Math.round(limits.maxUnzipBytes / 1048576)} MB 上限`,
          413, 'ugoira_resource_limit', false, { limit: limits.maxUnzipBytes },
        )
      }
      chunks.push(chunk)
      if (!final) return
      const data = Buffer.concat(chunks)
      chunks.length = 0
      const name = safeFrameName(file.name) || 'frame.png'
      for (const index of targets) {
        const target = path.join(tempDir, `${String(index).padStart(4, '0')}-${name}`)
        writeFileSync(target, data)
        files[index] = target
      }
    }
    file.start()
  })
  // fflate 的流式解压需要显式注册 deflate 解码器，否则压缩条目会报 unknown compression。
  unzipper.register(UnzipInflate)
  unzipper.push(new Uint8Array(archive), true)

  const missing = frames.findIndex((_frame, index) => !files[index])
  if (missing >= 0) {
    throw new UgoiraError(`Ugoira 压缩包缺少帧 ${safeFrameName(frames[missing]!.file) || frames[missing]!.file}`, 422, 'ugoira_invalid_archive')
  }
  return files
}

/** 校验每帧尺寸并累计像素；WebP 需要一次性组合所有帧，所以额外受累计像素限制。 */
async function inspectFrames(files: string[], limits: UgoiraBudget, forWebp: boolean): Promise<void> {
  let totalPixels = 0
  for (const file of files) {
    const meta = await sharp(file).metadata()
    if (!meta.width || !meta.height) throw new UgoiraError('Ugoira 帧不是可读的图片', 422, 'ugoira_invalid_archive')
    const pixels = meta.width * meta.height
    if (pixels > limits.maxFramePixels) {
      throw new UgoiraError(
        `Ugoira 单帧 ${meta.width}×${meta.height}，超过 ${(limits.maxFramePixels / 1_000_000).toFixed(0)} MP 上限`,
        413, 'ugoira_resource_limit', false, { observed: pixels, limit: limits.maxFramePixels },
      )
    }
    totalPixels += pixels
  }
  if (forWebp && totalPixels > limits.webpMaxPixels) {
    throw new UgoiraError(
      `这组 Ugoira 需要一次性解码 ${(totalPixels / 1_000_000).toFixed(0)} MP，超过动画 WebP 的 ${(limits.webpMaxPixels / 1_000_000).toFixed(0)} MP 上限`,
      413, 'ugoira_resource_limit', false, { observed: totalPixels, limit: limits.webpMaxPixels },
    )
  }
}

async function renderWebm(frames: Array<{ file: string; delay: number }>, files: string[], delays: number[], tempDir: string, output: string, timeoutMs: number): Promise<void> {
  const listPath = path.join(tempDir, 'frames.txt')
  const lines: string[] = []
  frames.forEach((frame, index) => {
    const escaped = files[index]!.replace(/'/g, "'\\''")
    lines.push(`file '${escaped}'`)
    // image2 defaults to 25 fps (40 ms ticks), which rounds Ugoira frame delays.
    lines.push('option framerate 1000')
    lines.push(`duration ${(delays[index]! / 1000).toFixed(3)}`)
  })
  await fs.writeFile(listPath, `${lines.join('\n')}\n`, 'utf8')
  // Set each packet's duration, including the final frame; no duplicate tail frame.
  const durations = `setts=duration=if(eq(N\\,${frames.length - 1})\\,${(delays.at(-1)! / 1000).toFixed(3)}/TB\\,NEXT_PTS-PTS)`
  try {
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-c:v', 'libvpx-vp9',
      '-crf', '18', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2',
      '-profile:v', '0', '-pix_fmt', 'yuv420p', '-an', '-row-mt', '1',
      '-bsf:v', durations, output], timeoutMs)
  } catch (error) {
    if (/超时/.test((error as Error).message)) {
      throw new UgoiraError(`Ugoira 视频转码超过 ${Math.round(timeoutMs / 60_000)} 分钟`, 504, 'ugoira_transcode_timeout', true)
    }
    throw error
  }
}

async function renderWebp(files: string[], delays: number[], output: string): Promise<void> {
  const buffers = await Promise.all(files.map(file => fs.readFile(file)))
  await sharp(buffers, { join: { animated: true } }).webp({
    quality: 95,
    effort: 4,
    loop: 0,
    delay: delays.map(delay => Math.min(65_535, Math.max(10, Math.round(delay)))),
  }).toFile(output)
}

/** Windows 上被杀掉的 FFmpeg 可能短暂占用文件；删除失败时重试几次再放弃。 */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
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
    const limits = budget()
    const delays = validateFrames(frames, limits)
    const zip = await getOrCachePixivResource(pixivCacheKey('ugoira', illustId, 0, 'zip'), zipUrl, 'application/zip', limits.maxUnzipBytes)
    const archive = await fs.readFile(zip.path)
    const tempDir = path.join(cacheDir, 'pixiv', 'tmp', randomUUID())
    await fs.mkdir(tempDir, { recursive: true })
    try {
      const files = await extractFrames(archive, frames, tempDir, limits)
      // WebM 交给 FFmpeg 流式编码，不受 WebP 的累计像素限制；但每帧尺寸仍然校验。
      await inspectFrames(files, limits, format === 'webp')
      const outputId = key.replace(/[^a-zA-Z0-9-]/g, '-')
      const webm = path.join(tempDir, 'animation.webm')
      const webp = path.join(tempDir, 'animation.webp')
      async function publish(file: string, extension: string, contentType: string) {
        const info = await fs.stat(file)
        if (info.size > limits.maxOutputBytes) {
          throw new UgoiraError(
            `Ugoira 输出 ${(info.size / 1048576).toFixed(1)} MB，超过 ${Math.round(limits.maxOutputBytes / 1048576)} MB 上限`,
            413, 'ugoira_resource_limit', false, { observed: info.size, limit: limits.maxOutputBytes },
          )
        }
        const target = path.join(cacheDir, 'pixiv', `${outputId}.${extension}`)
        await fs.rename(file, target)
        const moved = await fs.stat(target)
        return registerPixivResource(key, target, moved.size, contentType)
      }
      if (format === 'auto' && ffmpegAvailable) {
        try {
          await renderWebm(frames, files, delays, tempDir, webm, limits.timeoutMs)
          return await publish(webm, 'webm', 'video/webm')
        } catch (error) {
          // 资源超限、坏包、超时不换格式重试：换到 WebP 只会更耗内存。
          if (error instanceof UgoiraError) throw error
          logWarn('Ugoira', `${illustId} WebM 转码失败，回退动画 WebP：${oneLine((error as Error).message, 200)}`)
        }
      }
      // 回退 WebP 时按 WebP 的累计像素预算再检查一次，避免失败后走更耗内存的路径。
      if (format !== 'webp') await inspectFrames(files, limits, true)
      await renderWebp(files, delays, webp)
      return await publish(webp, 'webp', 'image/webp')
    } finally {
      await removeTempDir(tempDir)
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}
