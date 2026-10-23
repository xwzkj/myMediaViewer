import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  COMPUTE_HEADER_PROTOCOL, COMPUTE_HEADER_REQUEST_ID, COMPUTE_HEADER_SHA256, COMPUTE_MAX_UPLOAD_BYTES,
  COMPUTE_PROTOCOL_VERSION, type ComputeJobStatus, type ComputeStatus,
} from '../../../shared/compute.js'
import { MangaEngineError, type EnginePage } from './engine.js'

/**
 * 远程计算端客户端。
 *
 * 主服务把原图上传给计算端，拿回识别结果和底图。在线翻译始终留在主服务，
 * 计算端不接触任何媒体库、SQLite 或在线 AI 凭据。
 *
 * 回退只允许发生在「任务还没被接收」的连接失败：一旦计算端返回了任务 ID，
 * 就不会在本地再算一遍，避免同一页产生两份结果或重复占用本机算力。
 */

export interface RemoteComputeConfig {
  baseUrl: string
  apiKey: string
  connectTimeoutMs: number
  timeoutMs: number
}

/** 失败发生在哪一步，决定能不能回退到本地主机。 */
export type RemotePhase = 'connect' | 'auth' | 'protocol' | 'job' | 'download'

export class RemoteComputeError extends Error {
  expose = true
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public phase: RemotePhase,
    public retryable = false,
  ) {
    super(message)
    this.name = 'RemoteComputeError'
  }
}

function baseUrlOf(config: RemoteComputeConfig): string {
  return config.baseUrl.trim().replace(/\/+$/, '')
}

function authHeaders(config: RemoteComputeConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}`, ...extra }
}

/** 把网络层异常统一成可判断阶段的错误。 */
function connectError(error: unknown, connectTimeoutMs: number): RemoteComputeError {
  const name = (error as Error).name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new RemoteComputeError(`连接远程计算端超时（${Math.round(connectTimeoutMs / 1000)} 秒）`, 504, 'compute_connect_timeout', 'connect', true)
  }
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause
  const detail = cause?.code || cause?.message
  return new RemoteComputeError(
    `无法连接远程计算端：${(error as Error).message}${detail ? `（${detail}）` : ''}`,
    502, 'compute_unreachable', 'connect', true,
  )
}

async function describeFailure(response: Response): Promise<{ code: string; message: string; retryable: boolean }> {
  try {
    const data = await response.json() as { code?: unknown; message?: unknown; retryable?: unknown }
    return {
      code: typeof data.code === 'string' ? data.code : 'compute_error',
      message: typeof data.message === 'string' && data.message ? data.message : `计算端返回 HTTP ${response.status}`,
      retryable: data.retryable === true,
    }
  } catch {
    return { code: 'compute_error', message: `计算端返回 HTTP ${response.status}`, retryable: false }
  }
}

function phaseForStatus(status: number): RemotePhase {
  return status === 401 || status === 403 ? 'auth' : 'protocol'
}

/** 读取计算端状态：鉴权、协议版本、模型就位情况和实际设备。 */
export async function checkRemoteCompute(config: RemoteComputeConfig): Promise<ComputeStatus> {
  if (!config.apiKey) throw new RemoteComputeError('尚未填写远程计算端 API Key', 400, 'compute_key_missing', 'auth')
  if (!/^https?:\/\//i.test(config.baseUrl)) throw new RemoteComputeError('远程计算端地址需要以 http:// 或 https:// 开头', 400, 'compute_url_invalid', 'protocol')
  let response: Response
  try {
    response = await fetch(`${baseUrlOf(config)}/v1/status`, {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(config.connectTimeoutMs),
    })
  } catch (error) {
    throw connectError(error, config.connectTimeoutMs)
  }
  if (!response.ok) {
    const failure = await describeFailure(response)
    throw new RemoteComputeError(failure.message, response.status, failure.code, phaseForStatus(response.status), failure.retryable)
  }
  const status = await response.json().catch(() => null) as ComputeStatus | null
  if (!status || typeof status !== 'object') {
    throw new RemoteComputeError('远程计算端返回了无法解析的状态', 502, 'compute_invalid_response', 'protocol')
  }
  if (status.protocol !== COMPUTE_PROTOCOL_VERSION) {
    throw new RemoteComputeError(
      `远程计算端协议版本是 ${status.protocol ?? '未知'}，当前主服务需要 ${COMPUTE_PROTOCOL_VERSION}，请同步更新两端`,
      409, 'compute_protocol_mismatch', 'protocol',
    )
  }
  return status
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface RemoteJobInput {
  /** 原图路径，必须在调用方已确认可访问的媒体目录内。 */
  imagePath: string
  /** 阶段回调，用于把任务进度透传给界面。 */
  onStage?: (stage: string) => void
}

/**
 * 把一页交给远程计算端并取回结果。
 *
 * 内容哈希同时用作幂等请求 ID：网络抖动导致的重传不会让计算端重复处理同一张图。
 */
export async function runRemoteMangaJob(config: RemoteComputeConfig, input: RemoteJobInput): Promise<EnginePage> {
  const setStage = input.onStage ?? (() => {})
  if (!config.apiKey) throw new RemoteComputeError('尚未填写远程计算端 API Key', 400, 'compute_key_missing', 'auth')

  const image = await readFile(input.imagePath)
  if (!image.length) throw new MangaEngineError('图片文件为空', 422, 'invalid_image')
  if (image.length > COMPUTE_MAX_UPLOAD_BYTES) {
    throw new MangaEngineError(
      `图片有 ${(image.length / 1048576).toFixed(1)} MB，超过远程计算端 ${COMPUTE_MAX_UPLOAD_BYTES / 1048576} MB 上限`,
      413, 'image_too_large',
    )
  }
  const digest = sha256(image)
  const base = baseUrlOf(config)

  setStage('发送到远程计算端')
  let response: Response
  try {
    response = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: authHeaders(config, {
        'Content-Type': 'application/octet-stream',
        [COMPUTE_HEADER_REQUEST_ID]: digest,
        [COMPUTE_HEADER_SHA256]: digest,
        [COMPUTE_HEADER_PROTOCOL]: String(COMPUTE_PROTOCOL_VERSION),
      }),
      body: new Uint8Array(image),
      // 上传本身可能比建连久，这里给一个足够宽的独立时限。
      signal: AbortSignal.timeout(Math.max(config.connectTimeoutMs, 60_000)),
    })
  } catch (error) {
    throw connectError(error, config.connectTimeoutMs)
  }
  if (!response.ok) {
    const failure = await describeFailure(response)
    throw new RemoteComputeError(
      failure.message, response.status, failure.code,
      phaseForStatus(response.status), failure.retryable,
    )
  }
  const accepted = await response.json().catch(() => null) as { id?: unknown } | null
  const jobId = typeof accepted?.id === 'string' ? accepted.id : ''
  if (!jobId) throw new RemoteComputeError('远程计算端没有返回任务编号', 502, 'compute_invalid_response', 'protocol')

  // 一旦任务被接收，后面任何失败都不再回退本地：否则同一页会被计算两次。
  const deadline = Date.now() + config.timeoutMs
  let status: ComputeJobStatus | null = null
  let interval = 250
  while (Date.now() < deadline) {
    let poll: Response
    try {
      poll = await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: authHeaders(config),
        signal: AbortSignal.timeout(Math.max(config.connectTimeoutMs, 15_000)),
      })
    } catch (error) {
      throw connectErrorAfterAccept(error, config.connectTimeoutMs)
    }
    if (!poll.ok) {
      const failure = await describeFailure(poll)
      throw new RemoteComputeError(failure.message, poll.status, failure.code, 'job', failure.retryable)
    }
    status = await poll.json().catch(() => null) as ComputeJobStatus | null
    if (!status) throw new RemoteComputeError('远程计算端返回了无法解析的任务状态', 502, 'compute_invalid_response', 'job')
    if (status.state === 'failed') {
      const failure = status.error
      throw new RemoteComputeError(
        failure?.message || '远程计算失败',
        failure?.code === 'compute_timeout' ? 504 : 422,
        failure?.code || 'compute_job_failed',
        'job', failure?.retryable === true,
      )
    }
    if (status.state === 'ready') break
    if (status.stage) setStage(`远程：${status.stage}`)
    await sleep(interval)
    interval = Math.min(interval * 1.5, 2000)
  }
  if (!status || status.state !== 'ready') {
    throw new RemoteComputeError(
      `远程计算超时（${Math.round(config.timeoutMs / 1000)} 秒）`,
      504, 'compute_timeout', 'job', true,
    )
  }
  const result = status.result
  if (!result) throw new RemoteComputeError('远程计算端没有返回结果', 502, 'compute_invalid_response', 'job')

  let baseImage: Buffer | undefined
  if (result.baseBytes > 0) {
    setStage('下载译图底图')
    let download: Response
    try {
      download = await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}/base`, {
        headers: authHeaders(config),
        signal: AbortSignal.timeout(Math.max(config.connectTimeoutMs, 60_000)),
      })
    } catch (error) {
      throw connectErrorAfterAccept(error, config.connectTimeoutMs)
    }
    if (!download.ok) {
      const failure = await describeFailure(download)
      throw new RemoteComputeError(failure.message, download.status, failure.code, 'download', failure.retryable)
    }
    baseImage = Buffer.from(await download.arrayBuffer())
    if (baseImage.length !== result.baseBytes || sha256(baseImage) !== result.baseSha256) {
      throw new RemoteComputeError('远程计算端返回的底图校验失败，请重试', 502, 'compute_checksum_mismatch', 'download', true)
    }
  }

  // 结果已经在本机落地，通知计算端清理临时文件即可；失败不影响本页。
  void fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: authHeaders(config),
    signal: AbortSignal.timeout(Math.max(config.connectTimeoutMs, 10_000)),
  }).then(response => response.body?.cancel()).catch(() => undefined)

  return {
    width: result.width,
    height: result.height,
    regions: result.regions,
    base: baseImage,
    engine: result.engine,
    timings: result.timings,
  }
}

/** 任务已被接收之后的连接失败：不可回退，只能报错并让用户重试。 */
function connectErrorAfterAccept(error: unknown, connectTimeoutMs: number): RemoteComputeError {
  if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
    return new RemoteComputeError(
      `远程计算端响应超时（${Math.round(connectTimeoutMs / 1000)} 秒）`,
      504, 'compute_connect_timeout', 'job', true,
    )
  }
  return new RemoteComputeError(
    `与远程计算端的连接中断：${(error as Error).message}`,
    502, 'compute_disconnected', 'job', true,
  )
}
