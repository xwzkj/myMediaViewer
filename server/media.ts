import { createReadStream, existsSync } from 'node:fs'
import { stat, rename, unlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { cacheDir, ffmpegPath, sources } from './config.js'
import type { StoredAsset } from './database.js'
import { formatDuration, logError, logInfo, logWarn, oneLine } from './log.js'

const mimeTypes: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', m4v: 'video/mp4', avi: 'video/x-msvideo',
}
export function runFFmpeg(args: string[], timeout = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-3000) })
    const timer = setTimeout(() => { child.kill(); reject(new Error('媒体处理超时')) }, timeout)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(diagnostic || 'FFmpeg 未能完成处理'))
    })
  })
}
export let ffmpegAvailable = false
export async function detectFFmpeg() {
  try { await runFFmpeg(['-version'], 5000); ffmpegAvailable = true } catch { ffmpegAvailable = false }
  if (ffmpegAvailable) logInfo('转换', 'FFmpeg 可用，视频封面与兼容版本转码已就绪')
  else logWarn('转换', '未找到 FFmpeg，视频封面与兼容版本转码不可用，可设置 FFMPEG_PATH')
}

export async function accessibleAsset(asset: StoredAsset): Promise<boolean> {
  const source = sources.find(s => asset.workId.startsWith(`${s.id}:`))
  if (!source) return false
  try {
    const [root, file] = await Promise.all([realpath(source.path), realpath(asset.path)])
    const relative = path.relative(root, file)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  } catch { return false }
}

export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size <= 0) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null
  return { start, end }
}

export async function sendMedia(request: FastifyRequest, reply: FastifyReply, file: string, extension?: string) {
  let info
  try { info = await stat(file) } catch { return reply.code(404).send({ message: '文件不存在或媒体目录离线' }) }
  if (!info.isFile()) return reply.code(404).send({ message: '文件不存在' })
  const etag = `"${info.size}-${Math.trunc(info.mtimeMs)}"`
  reply.header('Accept-Ranges', 'bytes').header('ETag', etag).header('Cache-Control', 'private, max-age=3600')
    .type(mimeTypes[extension || path.extname(file).slice(1)] || 'application/octet-stream')
  if (request.headers['if-none-match'] === etag && !request.headers.range) return reply.code(304).send()
  if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
    const range = parseRange(request.headers.range, info.size)
    if (!range) return reply.code(416).header('Content-Range', `bytes */${info.size}`).send()
    reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`).header('Content-Length', range.end - range.start + 1)
    return reply.send(createReadStream(file, range))
  }
  return reply.header('Content-Length', info.size).send(createReadStream(file))
}

const pendingThumbs = new Map<string, Promise<string>>()
const thumbnailWaiters: Array<() => void> = []
let thumbnailWorkers = 0
async function acquireThumbnail() {
  if (thumbnailWorkers >= 2) await new Promise<void>(resolve => thumbnailWaiters.push(resolve))
  else thumbnailWorkers++
}
function releaseThumbnail() {
  const next = thumbnailWaiters.shift()
  if (next) next()
  else thumbnailWorkers--
}
function cacheKey(asset: StoredAsset) { return `${asset.id}-${Math.trunc(asset.modified)}-${asset.size}` }

export async function thumbnail(asset: StoredAsset): Promise<string> {
  const output = path.join(cacheDir, `${cacheKey(asset)}.webp`)
  if (existsSync(output)) return output
  const pending = pendingThumbs.get(output)
  if (pending) return pending
  const task = (async () => {
    await acquireThumbnail()
    const temp = `${output}.tmp`
    try {
      if (asset.kind === 'video' || asset.extension === 'webm') {
        if (!ffmpegAvailable) throw new Error('FFmpeg 不可用')
        await runFFmpeg(['-v', 'error', '-nostdin', '-i', asset.path, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-c:v', 'libwebp', '-f', 'webp', '-y', temp])
      } else {
        await sharp(asset.path, { animated: false, limitInputPixels: 180_000_000 }).rotate()
          .resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(temp)
      }
      await rename(temp, output)
      return output
    } finally { await unlink(temp).catch(() => {}); releaseThumbnail() }
  })()
  pendingThumbs.set(output, task)
  try { return await task } finally { pendingThumbs.delete(output) }
}

export interface ConversionJob { state: 'queued' | 'processing' | 'ready' | 'failed'; message?: string }
const conversionJobs = new Map<string, ConversionJob>()
let conversionChain = Promise.resolve()
export function conversionPath(asset: StoredAsset): string { return path.join(cacheDir, `${cacheKey(asset)}.mp4`) }
export function conversionStatus(asset: StoredAsset): ConversionJob {
  if (existsSync(conversionPath(asset))) return { state: 'ready' }
  return conversionJobs.get(asset.id) || { state: 'failed', message: '尚未生成兼容版本' }
}
export function convert(asset: StoredAsset): ConversionJob {
  const current = conversionStatus(asset)
  if (current.state !== 'failed') return current
  if (!ffmpegAvailable) return { state: 'failed', message: '未找到 FFmpeg，请在服务器安装或配置 FFMPEG_PATH' }
  const queued = [...conversionJobs.values()].filter(j => j.state === 'queued' || j.state === 'processing').length
  if (queued >= 5) {
    logWarn('转换', `转码队列已满（${queued} 个任务），暂不接收「${asset.filename}」`)
    return { state: 'failed', message: '处理队列已满，请稍后重试' }
  }
  const started = Date.now()
  const job: ConversionJob = { state: 'queued' }
  conversionJobs.set(asset.id, job)
  logInfo('转换', `「${asset.filename}」进入转码队列${queued ? `（前面还有 ${queued} 个任务）` : ''}`)
  conversionChain = conversionChain.then(async () => {
    const output = conversionPath(asset)
    const temp = `${output}.partial.mp4`
    job.state = 'processing'
    logInfo('转换', `开始转码「${asset.filename}」`)
    try {
      await runFFmpeg(['-v', 'error', '-nostdin', '-i', asset.path, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-threads', '2', '-y', temp], 7_200_000)
      await rename(temp, output)
      job.state = 'ready'
      logInfo('转换', `「${asset.filename}」转码完成 · 用时 ${formatDuration(Date.now() - started)}`)
    } catch (error) {
      job.state = 'failed'; job.message = '兼容版本生成失败，请检查源文件、磁盘空间和 FFmpeg'
      logError('转换', `「${asset.filename}」转码失败：${oneLine((error as Error).message, 200)}`)
    } finally { await unlink(temp).catch(() => {}) }
  })
  return job
}
