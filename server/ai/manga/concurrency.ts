/** 按入队顺序分配名额；失败也释放名额，排队不阻塞调用方继续识别。 */
export function createTranslationLimiter(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数')
  let active = 0
  const waiting: Array<() => void> = []

  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>(resolve => waiting.push(resolve))
    } else {
      active++
    }
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
