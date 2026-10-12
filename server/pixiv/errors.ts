export class PixivApiError extends Error {
  expose = true
  constructor(message: string, public statusCode = 400, public code?: string) {
    super(message)
    this.name = 'PixivApiError'
  }
}

export function pixivErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const body = payload as Record<string, unknown>
  const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
  const errors = body.errors && typeof body.errors === 'object' ? body.errors as Record<string, unknown> : {}
  return String(error.user_message || error.message || body.error_description || errors.message || body.message || (typeof body.error === 'string' ? body.error : ''))
}
