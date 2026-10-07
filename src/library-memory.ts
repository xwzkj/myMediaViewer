import { watch, type WatchStopHandle } from 'vue'

/** Route entry itself must persist, even when KeepAlive restores unchanged local filters. */
export function watchLibraryMemory<T>(
  read: () => T,
  currentPath: () => string,
  isCurrentPage: () => boolean,
  save: (state: T) => void,
): WatchStopHandle {
  return watch([read, currentPath], ([state]) => {
    if (!isCurrentPage()) return
    // Storage can be denied or full; browsing must still work.
    try { save(state) } catch { /* Best-effort local preference only. */ }
  }, { immediate: true, deep: true })
}
