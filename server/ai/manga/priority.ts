export type InferencePriority = 'manual' | 'background'

export interface PriorityQueueOptions {
  /** 后台任务同时执行的数量；默认 1。传函数时每次补位重新读取。 */
  backgroundConcurrency?: number | (() => number)
  /** 手动任务是否可以越过已满的后台名额；默认 true。 */
  manualBypass?: boolean
}

/**
 * 非抢占式优先队列。
 *
 * 手动任务永远排在后台任务前面；`manualBypass` 打开时（远程模式），后台任务
 * 占满名额也不会挡住用户刚发起的手动任务，计算端再按请求头决定先跑谁。
 * 本地 ONNX 会话必须保持串行，因此本地队列关闭 bypass，名额同时约束两类任务。
 */
export function createPriorityQueue(options: PriorityQueueOptions = {}) {
  type Entry = {
    priority: InferencePriority
    run: () => Promise<unknown>
    resolve: (value: any) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
  }
  const entries: Entry[] = []
  const manualBypass = options.manualBypass !== false
  let active = 0
  let backgroundActive = 0

  function limit(): number {
    const value = typeof options.backgroundConcurrency === 'function'
      ? options.backgroundConcurrency()
      : options.backgroundConcurrency ?? 1
    return Number.isInteger(value) && value > 0 ? value : 1
  }

  function start(entry: Entry, background: boolean) {
    active++
    if (background) backgroundActive++
    // 先让出同步栈：调用方拿到 Promise 之后再真正执行，避免递归 pump 过深。
    void Promise.resolve().then(async () => {
      try {
        entry.signal?.throwIfAborted()
        entry.resolve(await entry.run())
      } catch (error) {
        entry.reject(error)
      } finally {
        active--
        if (background) backgroundActive--
        pump()
      }
    })
  }

  function pump() {
    for (;;) {
      const manualIndex = entries.findIndex(entry => entry.priority === 'manual')
      if (manualIndex >= 0) {
        // 手动任务在远程模式直接执行；本地模式仍受总名额限制。
        if (!manualBypass && active >= limit()) return
        start(entries.splice(manualIndex, 1)[0]!, false)
        continue
      }
      if (!entries.length || backgroundActive >= limit()) return
      if (!manualBypass && active >= limit()) return
      start(entries.shift()!, true)
    }
  }

  return <T>(run: () => Promise<T>, priority: InferencePriority = 'manual', signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    if (entries.length >= 1000) { reject(new Error('计算队列已满，请稍后再试')); return }
    entries.push({ run, priority, signal, resolve, reject })
    pump()
  })
}
