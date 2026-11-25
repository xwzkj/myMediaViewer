/** Opt-in per source. Limits count attempts, including failed paid requests. */
export interface SourceBackgroundSettings {
  watch: boolean
  watchIntervalSeconds: number
  semantic: boolean
  ocr: boolean
  autoTranslate: boolean
  maxPagesPerDay: number
  maxTranslationRequestsPerDay: number
  localDutyPercent: number
}
export const defaultSourceBackground: SourceBackgroundSettings = {
  watch: false, watchIntervalSeconds: 300, semantic: false, ocr: false, autoTranslate: false,
  maxPagesPerDay: 100, maxTranslationRequestsPerDay: 20, localDutyPercent: 25,
}
const integer = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
export function normalizeSourceBackground(raw: unknown): SourceBackgroundSettings {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    watch: value.watch === true, semantic: value.semantic === true, ocr: value.ocr === true, autoTranslate: value.autoTranslate === true,
    watchIntervalSeconds: integer(value.watchIntervalSeconds, 300, 30, 86400),
    maxPagesPerDay: integer(value.maxPagesPerDay, 100, 1, 100000),
    maxTranslationRequestsPerDay: integer(value.maxTranslationRequestsPerDay, 20, 1, 10000),
    localDutyPercent: integer(value.localDutyPercent, 25, 5, 100),
  }
}
export type BackgroundTaskKind = 'semantic' | 'ocr' | 'translate'
export type BackgroundTaskState = 'queued' | 'running' | 'done' | 'failed' | 'stopped'
export interface BackgroundSourceStatus {
  sourceId: string
  settings: SourceBackgroundSettings
  state: 'running' | 'paused' | 'stopped'
  counts: Record<BackgroundTaskState, number>
  pagesToday: number
  translationRequestsToday: number
  translationConsentValid: boolean
  lastFileCount: number | null
  lastCheckedAt: number | null
  message: string
}
export interface BackgroundStatus {
  localComputeMode: 'local' | 'remote'
  sources: BackgroundSourceStatus[]
  /** 远程模式可能同时有多项；本地模式最多一项。 */
  active: Array<{ sourceId: string; assetId: string; kind: BackgroundTaskKind }>
}
