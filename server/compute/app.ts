import Fastify, { type FastifyInstance } from 'fastify'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  COMPUTE_HEADER_PROTOCOL, COMPUTE_HEADER_REQUEST_ID, COMPUTE_HEADER_SHA256, COMPUTE_MAX_UPLOAD_BYTES,
  COMPUTE_PROTOCOL_VERSION, type ComputeError, type ComputeJobResult, type ComputeJobStatus, type ComputeStatus,
} from '../../shared/compute.js'
import { PIPELINE_VERSION, type EnginePage } from '../ai/manga/engine.js'
import { formatDuration, logError, logInfo, logWarn, oneLine } from '../log.js'
import { registerSemanticComputeRoutes } from '../semantic/compute-routes.js'
import type { SemanticProvider } from '../semantic/provider.js'

/**
 * 远程计算端：只做本地 AI 计算的独立 HTTP 服务。
 *
 * 与主服务同属一个项目、共用计算核心，但**不导入**主服务的配置、数据库、媒体库或
 * 在线 AI 客户端。它只认识三样东西：原图、模型、临时目录。
 *
 * 所有接口（含状态、结果、覆盖层）都要求 Bearer Key。错误只回传白名单字段，
 * 不暴露本地路径、堆栈或 FFmpeg/ONNX 内部信息。
 */

/** 计算端只需要引擎的这一小部分能力，测试可以注入假实现。 */
export interface ComputeEngine {
  modelStatus(): {
    ready: boolean
    device: string
    models: Array<{ name: string; ready: boolean; files: string[]; missing: string[] }>
    message?: string
  }
  process(imagePath: string, setStage?: (stage: string) => void): Promise<EnginePage>
  ensureModels?(setStage?: (stage: string) => void): Promise<void>
}

export interface ComputeAppOptions {
  apiKey: string
  /** 原图与底图的临时目录，调用方保证存在。 */
  workDir: string
  engine: ComputeEngine
  /** 任务与结果保留时间。 */
  ttlMs?: number
  /** 结果文件总容量上限，超出按最旧清理。 */
  maxDiskBytes?: number
  /** 测试可以关掉日志，避免刷屏。 */
  quiet?: boolean
  /** 语义编码 provider；不传时按默认模型目录懒加载，首次使用自动下载。 */
  semanticProvider?: SemanticProvider
}

interface JobRecord {
  id: string
  requestId: string
  state: ComputeJobStatus['state']
  stage: string
  progress: number
  createdAt: number
  updatedAt: number
  inputPath: string
  overlayPath: string
  overlayBytes: number
  overlaySha256: string
  result?: ComputeJobResult
  error?: ComputeError
}

const DEFAULT_TTL = 60 * 60_000
const DEFAULT_DISK_LIMIT = 2 * 1024 * 1024 * 1024

/** 日志里用短编号指代任务，完整 UUID 只会占地方。 */
const shortId = (id: string) => id.slice(0, 8)
const megabytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 恒定时间比较：先把两端都摘要成等长缓冲，避免长度差异泄露信息。 */
function keyMatches(expected: string, provided: string): boolean {
  if (!expected || !provided) return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(provided).digest()
  return timingSafeEqual(a, b)
}

/** 只把可公开的字段转成错误，内部异常统一成一句笼统提示。 */
function toComputeError(error: unknown): ComputeError {
  const value = error as Error & { expose?: boolean; code?: string; statusCode?: number }
  if (value?.expose === true) {
    return {
      code: typeof value.code === 'string' && value.code ? value.code : 'compute_failed',
      message: value.message || '计算失败',
      retryable: value.statusCode === 503 || value.statusCode === 504,
    }
  }
  return { code: 'compute_failed', message: '计算端处理失败，请查看计算端日志', retryable: false }
}

export async function createComputeApp(options: ComputeAppOptions): Promise<FastifyInstance> {
  const ttl = options.ttlMs ?? DEFAULT_TTL
  const diskLimit = options.maxDiskBytes ?? DEFAULT_DISK_LIMIT
  const quiet = options.quiet === true
  const info = (message: string) => { if (!quiet) logInfo('计算端', message) }
  const warn = (message: string) => { if (!quiet) logWarn('计算端', message) }
  const fail = (message: string, error?: unknown) => { if (!quiet) logError('计算端', message, error) }
  const jobs = new Map<string, JobRecord>()
  /** 内容哈希 → 任务 ID，用于重传幂等。 */
  const byRequest = new Map<string, string>()
  let queue: Promise<void> = Promise.resolve()
  let queued = 0
  let processing = false

  await mkdir(options.workDir, { recursive: true })

  const app = Fastify({
    logger: false,
    bodyLimit: COMPUTE_MAX_UPLOAD_BYTES,
  })

  // 原图是二进制，Fastify 默认不解析；这里按 buffer 接收并按大小限制。
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: COMPUTE_MAX_UPLOAD_BYTES }, (_request, body, done) => {
    done(null, body)
  })
  registerSemanticComputeRoutes(app, options.semanticProvider)

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    const header = request.headers.authorization
    const provided = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!keyMatches(options.apiKey, provided)) {
      // 只记录来源与路径，绝不记录对方提供的 Key 内容。
      warn(`拒绝请求 · ${request.method} ${request.url.split('?')[0]} · Key ${provided ? '无效' : '缺失'} · 来自 ${request.ip}`)
      return reply.code(401).send({ code: 'compute_unauthorized', message: '远程计算端 API Key 无效', retryable: false })
    }
  })

  app.setErrorHandler((error, request, reply) => {
    const status = typeof (error as { statusCode?: number }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500
    // 请求体超限时 Fastify 抛的是框架错误，转成协议内的明确错误码。
    const code = (error as { code?: string }).code
    if (status === 413 || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      warn(`拒绝请求 · ${request.method} ${request.url.split('?')[0]} · 请求体超过 ${megabytes(COMPUTE_MAX_UPLOAD_BYTES)} 上限`)
      return reply.code(413).send({
        code: 'upload_too_large',
        message: `原图超过 ${Math.round(COMPUTE_MAX_UPLOAD_BYTES / 1048576)} MB 上传上限`,
        retryable: false,
      })
    }
    if (status < 500) {
      warn(`请求无效 · ${request.method} ${request.url.split('?')[0]} · ${status} · ${(error as Error).message}`)
      return reply.code(status).send({
        code: code || 'compute_bad_request',
        message: (error as Error).message || '请求无效',
        retryable: false,
      })
    }
    // 明确标注可公开的 5xx（例如语义模型正在下载/繁忙）要保留真实状态码与原因，
    // 否则主服务只能看到笼统的 500，既无法重试也无法提示用户。
    if ((error as { expose?: boolean }).expose === true) {
      warn(`请求暂不可用 · ${request.method} ${request.url.split('?')[0]} · ${status} · ${(error as Error).message}`)
      return reply.code(status).send({
        code: code || 'compute_unavailable',
        message: (error as Error).message || '计算端暂时不可用',
        retryable: status === 503 || status === 504,
      })
    }
    // 未预期异常只在计算端日志里保留完整堆栈，返回给主服务的仍是笼统提示。
    fail(`内部错误 · ${request.method} ${request.url.split('?')[0]} · 500`, error)
    return reply.code(500).send({ code: 'compute_failed', message: '计算端处理失败，请查看计算端日志', retryable: false })
  })

  function publicStatus(job: JobRecord): ComputeJobStatus {
    return {
      id: job.id,
      state: job.state,
      stage: job.stage,
      progress: job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}),
    }
  }

  function totalBytes(): number {
    let total = 0
    for (const job of jobs.values()) total += job.overlayBytes
    return total
  }

  async function removeJob(job: JobRecord): Promise<void> {
    jobs.delete(job.id)
    byRequest.delete(job.requestId)
    await Promise.all([
      rm(job.inputPath, { force: true }).catch(() => undefined),
      job.overlayBytes ? rm(job.overlayPath, { force: true }).catch(() => undefined) : Promise.resolve(),
    ])
  }

  /** 过期任务按最旧清理；总磁盘超额时继续淘汰最旧结果。 */
  async function sweep(): Promise<void> {
    const now = Date.now()
    const removed: JobRecord[] = []
    for (const job of [...jobs.values()]) {
      if (now - job.updatedAt > ttl && (job.state === 'ready' || job.state === 'failed')) {
        removed.push(job)
        await removeJob(job)
      }
    }
    while (totalBytes() > diskLimit) {
      const oldest = [...jobs.values()]
        .filter(job => job.state === 'ready' || job.state === 'failed')
        .sort((a, b) => a.updatedAt - b.updatedAt)[0]
      if (!oldest) break
      removed.push(oldest)
      await removeJob(oldest)
    }
    if (!removed.length) return
    const freed = removed.reduce((total, job) => total + job.overlayBytes, 0)
    info(`清理 ${removed.length} 个任务 · 释放 ${megabytes(freed)} · 当前结果 ${megabytes(totalBytes())}`)
  }

  async function runJob(job: JobRecord): Promise<void> {
    const startedAt = Date.now()
    const queueWait = startedAt - job.createdAt
    job.state = 'processing'
    job.stage = '开始计算'
    job.progress = 5
    job.updatedAt = startedAt
    info(`开始计算 ${shortId(job.id)} · 排队 ${formatDuration(queueWait)}${queued > 0 ? ` · 后面还有 ${queued} 个` : ''}`)
    // 阶段日志按"去掉数字后的阶段名"去重：每种阶段只记一次，逐框进度不会刷屏。
    let lastFamily = ''
    const publishStage = (stage: string) => {
      job.stage = stage
      job.updatedAt = Date.now()
      const family = stage.replace(/\d+(\/\d+)?/g, '').trim()
      if (family === lastFamily) return
      lastFamily = family
      info(`${shortId(job.id)} 阶段 · ${oneLine(stage, 80)}`)
    }
    try {
      const page = await options.engine.process(job.inputPath, publishStage)
      const overlay = page.overlay
      let overlayBytes = 0
      let overlaySha256 = ''
      if (overlay?.length) {
        overlayBytes = overlay.length
        overlaySha256 = sha256(overlay)
        await writeFile(job.overlayPath, overlay)
      }
      job.overlayBytes = overlayBytes
      job.overlaySha256 = overlaySha256
      job.result = {
        width: page.width,
        height: page.height,
        regions: page.regions,
        overlayBytes,
        overlaySha256,
        engine: page.engine,
        pipelineVersion: PIPELINE_VERSION,
        timings: page.timings,
      }
      job.state = 'ready'
      job.stage = '完成'
      job.progress = 100
      const { timings } = page
      info(
        `完成 ${shortId(job.id)} · ${page.width}×${page.height} · ${page.regions.length} 处文本`
        + ` · 检测 ${formatDuration(timings.detectionMs)} / OCR ${formatDuration(timings.ocrMs)}`
        + ` / 擦字 ${formatDuration(timings.eraseMs)} / 编码 ${formatDuration(timings.encodeMs)}`
        + ` · 覆盖层 ${overlayBytes ? megabytes(overlayBytes) : '无（本页没有文本）'}`
        + ` · 总 ${formatDuration(Date.now() - startedAt)}`,
      )
    } catch (error) {
      job.state = 'failed'
      job.error = toComputeError(error)
      job.stage = '计算失败'
      job.progress = 100
      const elapsed = formatDuration(Date.now() - startedAt)
      if ((error as { expose?: boolean })?.expose === true) {
        warn(`失败 ${shortId(job.id)} · ${job.error.code} · ${job.error.message} · ${elapsed}`)
      } else {
        // 未预期异常保留完整堆栈给计算端日志，返回给主服务的仍是笼统提示。
        fail(`失败 ${shortId(job.id)} · 内部错误 · ${elapsed}`, error)
      }
    } finally {
      // 原图只是本次计算的输入，失败或成功都不需要留着。
      await rm(job.inputPath, { force: true }).catch(() => undefined)
      job.updatedAt = Date.now()
      await sweep()
    }
  }

  function enqueue(job: JobRecord): void {
    queued++
    // 计算端一次只跑一个任务：本机推理本来就会占满模型会话，并行只会互相拖慢。
    const task = queue.then(() => {
      queued--
      processing = true
      return runJob(job).finally(() => { processing = false })
    }, () => undefined)
    queue = task.then(() => undefined, () => undefined)
  }

  app.get('/v1/status', async (): Promise<ComputeStatus> => {
    const models = options.engine.modelStatus()
    return {
      protocol: COMPUTE_PROTOCOL_VERSION,
      ready: models.ready,
      device: models.device,
      models: models.models,
      busy: processing || queued > 0,
      queued,
      ...(models.message ? { message: models.message } : {}),
    }
  })

  app.post('/v1/jobs', async (request, reply) => {
    const body = request.body
    if (!Buffer.isBuffer(body) || !body.length) {
      warn(`拒绝上传 · 没有收到原图 · 来自 ${request.ip}`)
      return reply.code(400).send({ code: 'empty_upload', message: '没有收到原图', retryable: false })
    }
    const protocol = Number(request.headers[COMPUTE_HEADER_PROTOCOL])
    if (protocol !== COMPUTE_PROTOCOL_VERSION) {
      warn(`拒绝上传 · 协议版本不符（主服务 ${request.headers[COMPUTE_HEADER_PROTOCOL] || '未提供'}，计算端 ${COMPUTE_PROTOCOL_VERSION}）`)
      return reply.code(409).send({
        code: 'compute_protocol_mismatch',
        message: `协议版本不匹配：计算端 ${COMPUTE_PROTOCOL_VERSION}，主服务 ${request.headers[COMPUTE_HEADER_PROTOCOL] || '未知'}`,
        retryable: false,
      })
    }
    const requestId = String(request.headers[COMPUTE_HEADER_REQUEST_ID] || '')
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) {
      warn('拒绝上传 · 请求编号无效')
      return reply.code(400).send({ code: 'invalid_request_id', message: '请求编号无效', retryable: false })
    }
    const declared = String(request.headers[COMPUTE_HEADER_SHA256] || '')
    const actual = sha256(body)
    if (declared && declared !== actual) {
      warn(`拒绝上传 · 内容摘要不符 · ${megabytes(body.length)}`)
      return reply.code(400).send({ code: 'checksum_mismatch', message: '上传内容校验失败', retryable: false })
    }

    // 重传同一张图时直接复用已有任务，避免重复推理。
    const existingId = byRequest.get(requestId)
    const existing = existingId ? jobs.get(existingId) : undefined
    if (existing) {
      info(`重复上传 · 复用任务 ${shortId(existing.id)}（${existing.state}）· ${megabytes(body.length)}`)
      return reply.code(202).send({ id: existing.id, state: existing.state })
    }

    const id = randomUUID()
    const job: JobRecord = {
      id,
      requestId,
      state: 'queued',
      stage: '排队中',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inputPath: path.join(options.workDir, `${id}.input`),
      overlayPath: path.join(options.workDir, `${id}.png`),
      overlayBytes: 0,
      overlaySha256: '',
    }
    await writeFile(job.inputPath, body)
    jobs.set(id, job)
    byRequest.set(requestId, id)
    enqueue(job)
    info(`收到任务 ${shortId(id)} · ${megabytes(body.length)} · 哈希 ${requestId.slice(0, 12)}… · 队列 ${queued + (processing ? 1 : 0)}`)
    return reply.code(202).send({ id, state: job.state })
  })

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id)
    if (!job) return reply.code(404).send({ code: 'job_not_found', message: '计算任务不存在或已过期', retryable: false })
    return publicStatus(job)
  })

  app.get<{ Params: { id: string } }>('/v1/jobs/:id/result', async (request, reply) => {
    const job = jobs.get(request.params.id)
    if (!job) return reply.code(404).send({ code: 'job_not_found', message: '计算任务不存在或已过期', retryable: false })
    if (job.state === 'failed') return reply.code(422).send(job.error || { code: 'compute_failed', message: '计算失败', retryable: false })
    if (job.state !== 'ready' || !job.result) {
      return reply.code(409).send({ code: 'job_not_ready', message: '计算任务尚未完成', retryable: true })
    }
    return job.result
  })

  app.get<{ Params: { id: string } }>('/v1/jobs/:id/overlay', async (request, reply) => {
    const job = jobs.get(request.params.id)
    if (!job || !job.result) return reply.code(404).send({ code: 'job_not_found', message: '计算任务不存在或尚未完成', retryable: false })
    if (!job.overlayBytes) return reply.code(404).send({ code: 'no_overlay', message: '这一页没有可翻译文本，没有擦字覆盖层', retryable: false })
    try {
      const fileInfo = await stat(job.overlayPath)
      reply.header('Content-Type', 'image/png').header('Content-Length', fileInfo.size).header('Cache-Control', 'no-store')
      return reply.send(createReadStream(job.overlayPath))
    } catch {
      warn(`覆盖层丢失 ${shortId(job.id)} · ${job.overlayPath}`)
      return reply.code(404).send({ code: 'no_overlay', message: '覆盖层文件已被清理', retryable: true })
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/jobs/:id', async request => {
    const job = jobs.get(request.params.id)
    if (job) {
      // 正在计算时只删结果，等任务自己收尾；避免删除正在写入的文件。
      if (job.state === 'ready' || job.state === 'failed') await removeJob(job)
    }
    return { removed: Boolean(job) }
  })

  // 定期清理过期任务与超出容量上限的结果；unref 让测试进程不被定时器挂住。
  const timer = setInterval(() => { void sweep() }, 10 * 60_000)
  timer.unref?.()
  app.addHook('onClose', async () => { clearInterval(timer) })

  return app
}
