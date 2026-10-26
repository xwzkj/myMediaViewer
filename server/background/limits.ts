/** 远程模式下同时排队的后台预热任务数。计算端再按自己的并发数执行。 */
export const DEFAULT_REMOTE_BACKGROUND_CONCURRENCY = 3
export const MAX_REMOTE_BACKGROUND_CONCURRENCY = 8

/**
 * 远程后台预热的流水线深度。
 *
 * 一个任务从上传、排队、推理到下载覆盖层通常要 1 秒左右，计算端真正算一张
 * 只要几百毫秒。只派发一个任务会让计算端在两次计算之间完全空转；保留 2-4 个
 * 在途任务才能让队列持续非空。环境变量便于按局域网带宽和内存调整。
 */
export function remoteBackgroundConcurrency(raw = process.env.BACKGROUND_CONCURRENCY): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1) return DEFAULT_REMOTE_BACKGROUND_CONCURRENCY
  return Math.min(MAX_REMOTE_BACKGROUND_CONCURRENCY, Math.floor(value))
}
