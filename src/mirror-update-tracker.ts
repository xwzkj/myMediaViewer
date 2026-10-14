import type { PixivBookmarkRestrict, PixivStatus } from '../shared/types'

/** First observation establishes a baseline, never an update notification. */
export function createMirrorUpdateTracker() {
  const baselines = new Map<string, number>()
  return {
    observe(status: PixivStatus, restrict: PixivBookmarkRestrict): boolean {
      const settings = status.settings
      const key = JSON.stringify([settings.account?.id || '', settings.configured, settings.localMode, restrict])
      const items = status.mirrors[restrict].items
      const previous = baselines.get(key)
      baselines.set(key, items)
      return previous !== undefined && previous !== items
    },
    reset() { baselines.clear() },
  }
}
