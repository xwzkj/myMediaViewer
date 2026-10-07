/** Serial polling: never overlaps requests, stops on unmount, and ignores late responses. */
export function createStatusPoller<T>(load: () => Promise<T>, receive: (value: T) => void, fail: (error: unknown) => void, delay = 1500) {
  let stopped = true, pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0, again = false
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (pending) { again = true; return pending }
    clearTimeout(timer)
    const run = generation
    pending = (async () => {
      try { const value = await load(); if (!stopped && generation === run) receive(value) }
      catch (error) { if (!stopped && generation === run) fail(error) }
      finally {
        pending = undefined
        if (!stopped && generation === run) {
          const immediate = again; again = false
          timer = setTimeout(() => { void refresh() }, immediate ? 0 : delay)
        }
      }
    })()
    return pending
  }
  return {
    start() { stopped = false; generation++; void refresh() },
    refresh,
    stop() { stopped = true; generation++; again = false; clearTimeout(timer) },
  }
}
