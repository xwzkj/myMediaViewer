/**
 * 远程计算端的稳定协议。
 *
 * 主服务（家庭服务器）把一张原图交给计算端，计算端只做本地 AI：检测 → OCR →
 * 阅读顺序整理 → 擦字 → 底图编码。在线翻译始终留在主服务，计算端不接触媒体库、
 * SQLite 或任何在线 AI 凭据。
 *
 * 所有接口都要求 `Authorization: Bearer <key>`，包括状态、结果与底图。
 */

/** 协议版本。字段含义变化时必须递增，主服务只接受同版本的计算端。 */
export const COMPUTE_PROTOCOL_VERSION = 1

/** 计算端默认端口，避免和主服务的 3210 冲突。 */
export const COMPUTE_DEFAULT_PORT = 3211

/** 请求头：幂等请求 ID、原图内容摘要、协议版本。 */
export const COMPUTE_HEADER_REQUEST_ID = 'x-compute-request-id'
export const COMPUTE_HEADER_SHA256 = 'x-compute-sha256'
export const COMPUTE_HEADER_PROTOCOL = 'x-compute-protocol'

/** 单张原图上传上限（字节）。属于输入校验，不是任务调度。 */
export const COMPUTE_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
/** 单页像素上限，防止异常扫描件把内存打满。 */
export const COMPUTE_MAX_PAGE_PIXELS = 40_000_000
/** 单页最多识别的文本区域；超过时返回明确错误，不静默截断。 */
export const COMPUTE_MAX_REGIONS = 80

export type ComputeJobState = 'queued' | 'processing' | 'ready' | 'failed'

/** 可以安全返回给主服务、再由主服务展示给用户的错误。 */
export interface ComputeError {
  /** 机器可读的错误码，例如 compute_unauthorized / image_too_large。 */
  code: string
  message: string
  retryable: boolean
}

export interface ComputeRegion {
  id: number
  x: number
  y: number
  width: number
  height: number
  /** 识别出的原文（未翻译）。 */
  source: string
  /** 检测模型置信度。 */
  detection: number
  /** OCR 每 token 几何平均置信度。 */
  confidence: number
  /** 擦字时估出的底色，供 Canvas 兜底。 */
  background: string
  textColor: string
}

export interface ComputeTimings {
  detectionMs: number
  ocrMs: number
  eraseMs: number
  encodeMs: number
}

export interface ComputeJobResult {
  width: number
  height: number
  regions: ComputeRegion[]
  /** 底图字节数与摘要；没有可翻译文本时都为 0 / 空串。 */
  baseBytes: number
  baseSha256: string
  /** 实际使用的模型/设备描述，便于任务日志排查。 */
  engine: string
  pipelineVersion: number
  timings: ComputeTimings
}

export interface ComputeJobStatus {
  id: string
  state: ComputeJobState
  stage: string
  /** 0-100，仅用于界面展示。 */
  progress: number
  createdAt: number
  updatedAt: number
  error?: ComputeError
  result?: ComputeJobResult
}

export interface ComputeModelEntry {
  name: string
  ready: boolean
  files: string[]
  missing: string[]
}

export interface ComputeStatus {
  protocol: number
  ready: boolean
  /** 如实描述实际设备；自动回退 CPU 时不能谎报 GPU。 */
  device: string
  models: ComputeModelEntry[]
  busy: boolean
  queued: number
  message?: string
}
