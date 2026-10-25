/**
 * 模型文件的下载与就位。主服务与远程计算端共用这一份实现。
 *
 * 模型不随仓库分发，首次真正需要时按需下载。访问不了 huggingface.co 时，把
 * HF_ENDPOINT 指向镜像站（例如 https://hf-mirror.com）即可。
 *
 * 这里刻意不引用服务端配置模块：计算端也要复用同一套下载/加载逻辑，而它
 * 不应该因此创建媒体目录或读取 sources.json。
 */
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { logInfo, logWarn } from '../log.js'

/** 单个模型文件在 HuggingFace 上的位置，以及下载后的落盘位置。 */
export interface ModelSpec {
  /** 相对模型根目录的目标路径，也是模型加载时使用的路径。 */
  target: string
  /** HuggingFace 仓库名。 */
  repo: string
  /** 仓库内的文件路径。 */
  file: string
}

export interface DownloadProgress {
  target: string
  received: number
  total: number
}

/** 一次下载最多等 20 分钟；大文件在慢速镜像上也要能下完。 */
const DOWNLOAD_TIMEOUT = 20 * 60_000

export function modelPath(spec: ModelSpec, root: string): string {
  return path.join(root, spec.target)
}

export function hasModel(spec: ModelSpec, root: string): boolean {
  return existsSync(modelPath(spec, root))
}

export function missingModels(specs: ModelSpec[], root: string): ModelSpec[] {
  return specs.filter(spec => !hasModel(spec, root))
}

/**
 * 下载单个模型文件。先写 .part 再改名：中断或长度校验失败都不会留下半个可用
 * 文件，下次启动会重新下载，而不是加载到损坏的模型。
 *
 * 临时文件名带进程号：主服务与计算端可能共享同一个模型目录，两个进程同时
 * 首次下载时不至于互相覆盖同一个 .part。
 */
export async function downloadModel(
  spec: ModelSpec,
  root: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const dest = modelPath(spec, root)
  if (existsSync(dest)) return
  await mkdir(path.dirname(dest), { recursive: true })
  const temp = `${dest}.${process.pid}.part`
  const endpoint = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '')
  const url = endpoint + '/' + spec.repo + '/resolve/main/' + spec.file
  logInfo('模型', '下载 ' + spec.target + ' · ' + spec.repo)
  let received = 0
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
    const total = Number(response.headers.get('content-length') || 0)
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        onProgress?.({ target: spec.target, received, total })
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(temp),
    )
    if (total && received !== total) throw new Error('下载不完整：' + received + '/' + total + ' 字节')
    await rename(temp, dest)
    logInfo('模型', '已就位 ' + spec.target + ' · ' + (received / 1048576).toFixed(1) + ' MB')
  } catch (error) {
    await unlink(temp).catch(() => {})
    const reason = error instanceof Error ? error.message : String(error)
    logWarn('模型', '下载失败 ' + spec.target + '：' + reason)
    throw new Error('下载模型 ' + spec.target + ' 失败：' + reason + '。可设置 HF_ENDPOINT 指向镜像站后重试')
  }
}

/** 下载全部缺失的模型文件，已存在的直接跳过。 */
export async function ensureModels(
  specs: ModelSpec[],
  root: string,
  onProgress?: (progress: DownloadProgress) => void,
  label = '模型',
): Promise<void> {
  const missing = missingModels(specs, root)
  if (!missing.length) return
  logInfo('模型', `缺少 ${missing.length} 个${label}，开始从 HuggingFace 下载`)
  for (const spec of missing) await downloadModel(spec, root, onProgress)
}
