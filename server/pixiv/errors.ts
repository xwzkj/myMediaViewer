export class PixivApiError extends Error {
  expose = true
  constructor(message: string, public statusCode = 400, public code?: string) {
    super(message)
    this.name = 'PixivApiError'
  }
}

/** 只放安全数值，避免把路径、上游响应或堆栈带进接口响应。 */
export type UgoiraErrorDetails = Record<string, string | number | boolean>

/**
 * Ugoira 转换的公开错误：资源预算超限、压缩包/元数据无效、转码超时。
 * 全局错误处理器会序列化 code / retryable / details（见 server/app.ts）。
 */
export class UgoiraError extends Error {
  expose = true
  constructor(
    message: string,
    public statusCode = 400,
    public code = 'ugoira_failed',
    public retryable = false,
    public details?: UgoiraErrorDetails,
  ) {
    super(message)
    this.name = 'UgoiraError'
  }
}

export function pixivErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const body = payload as Record<string, unknown>
  const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
  const errors = body.errors && typeof body.errors === 'object' ? body.errors as Record<string, unknown> : {}
  return String(error.user_message || error.message || body.error_description || errors.message || body.message || (typeof body.error === 'string' ? body.error : ''))
}
