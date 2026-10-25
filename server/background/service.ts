import { createHash, randomUUID } from 'node:crypto'
import { opendir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate as yieldToRequests } from 'node:timers/promises'
import { normalizeSourceBackground, type BackgroundStatus, type BackgroundTaskKind, type SourceBackgroundSettings } from '../../shared/background.js'
import { sources, saveSources } from '../config.js'
import { db, getAsset, type StoredAsset } from '../database.js'
import { getAiSettings, getLocalComputeConfig } from '../ai.js'
import { onScanComplete, scanLibrary, scanStatus, sourceOnline } from '../scanner.js'
import { formatDuration, logError, logInfo, logWarn } from '../log.js'
import { BackgroundQueue, type Task, type SourceRunState } from './queue.js'

export const backgroundQueue = new BackgroundQueue(db)
const challenges = new Map<string, { sourceId: string; signature: string; settings: string; expires: number }>()
let active: { task: Task; controller: AbortController } | null = null
let timer: ReturnType<typeof setInterval> | undefined
let checking = false, ticking = false, synchronizing: Promise<void> | null = null, syncAgain = false
let stopped = false, cooldownUntil = 0, roundRobin = 0
let semanticRevision = 'unavailable'
const nextChecks = new Map<string, number>()
const directoryChecks = new Map<string,AbortController>()
const blockedUntil = new Map<string, number>()
let stopWatcher: AbortController | null = null
let removeScanListener: (() => void) | undefined
const httpError = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode, expose: true })
class DeferredTask extends Error {}
function sourceById(id: string) {
  const source = sources.find(item => item.id === id)
  if (!source) throw httpError('目录不存在', 404)
  return source
}
export function translationSignature(): string {
  const settings = getAiSettings()
  return createHash('sha256').update(JSON.stringify([settings.baseUrl,settings.apiKey,settings.model,settings.targetLanguage,settings.appendPrompt,settings.params,settings.outputMode])).digest('hex')
}
function taskStamp(asset: StoredAsset, kind: BackgroundTaskKind) {
  return JSON.stringify([asset.path,asset.size,asset.modified,kind === 'translate' ? translationSignature() : kind === 'semantic' ? semanticRevision : 'v2'])
}
function enabledKinds(settings: SourceBackgroundSettings): BackgroundTaskKind[] {
  return [...(settings.semantic ? ['semantic' as const] : []), ...(settings.autoTranslate ? ['translate' as const] : settings.ocr ? ['ocr' as const] : [])]
}
export function createTranslationConfirmation(sourceId: string, raw: unknown) {
  sourceById(sourceId)
  const settings = normalizeSourceBackground(raw)
  const ai = getAiSettings()
  if (!settings.autoTranslate) throw httpError('请先选择自动翻译')
  if (!ai.apiKey || !ai.model) throw httpError('请先保存 AI 接口及模型配置')
  for (const [key, challenge] of challenges) if (challenge.expires < Date.now()) challenges.delete(key)
  if (challenges.size >= 100) challenges.delete(challenges.keys().next().value!)
  const token = randomUUID()
  challenges.set(token, { sourceId, signature: translationSignature(), settings: JSON.stringify(settings), expires: Date.now() + 300000 })
  return { token, warning: `自动翻译会向 ${ai.baseUrl} 的 ${ai.model} 发送漫画文字并可能产生费用。每天最多 ${settings.maxTranslationRequestsPerDay} 次后台翻译请求（失败请求也计入）；每天最多 ${settings.maxPagesPerDay} 项计算。此上限不是金额或 token 上限，实际费用以供应商为准。按 UTC 日期重置。`, expiresInSeconds: 300 }
}
export function saveBackgroundSettings(sourceId: string, raw: unknown, token?: string) {
  const source = sourceById(sourceId), settings = normalizeSourceBackground(raw)
  const previous = normalizeSourceBackground(source.background)
  const signature = translationSignature()
  const needsConsent = settings.autoTranslate && (!previous.autoTranslate || backgroundQueue.control(sourceId).consent !== signature || settings.maxTranslationRequestsPerDay > previous.maxTranslationRequestsPerDay)
  if (needsConsent) {
    const challenge = token ? challenges.get(token) : undefined
    if (!challenge || challenge.sourceId !== sourceId || challenge.expires < Date.now() || challenge.signature !== signature || challenge.settings !== JSON.stringify(settings)) throw httpError('自动翻译涉及费用，请阅读警告并再次确认后启用', 409)
    challenges.delete(token!)
  }
  saveSources(sources.map(item => item.id === sourceId ? { ...item, background: settings } : item))
  if (needsConsent) backgroundQueue.consent(sourceId,signature)
  if (!settings.autoTranslate) backgroundQueue.consent(sourceId,'')
  active?.task.source_id === sourceId && active.controller.abort()
  directoryChecks.get(sourceId)?.abort()
  blockedUntil.delete(sourceId); nextChecks.delete(sourceId)
  void synchronizeBackground().catch(error => backgroundQueue.message(sourceId, String(error)))
  return settings
}
export function controlBackground(sourceId: string, action: 'pause' | 'stop' | 'resume' | 'retry') {
  sourceById(sourceId)
  const state: SourceRunState = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running'
  backgroundQueue.setState(sourceId,state)
  if (action === 'retry') backgroundQueue.retry(sourceId)
  if (action === 'pause' || action === 'stop') { directoryChecks.get(sourceId)?.abort(); if (active?.task.source_id === sourceId) active.controller.abort() }
  blockedUntil.delete(sourceId)
  if (state === 'running') void synchronizeBackground().catch(error => backgroundQueue.message(sourceId,String(error)))
}
export function getBackgroundStatus(): BackgroundStatus {
  const signature = translationSignature()
  return { localComputeMode: getLocalComputeConfig().mode, active: active ? { sourceId:active.task.source_id, assetId:active.task.asset_id, kind:active.task.kind } : null, sources: sources.map(source => {
    const control = backgroundQueue.control(source.id), usage = backgroundQueue.usage(source.id)
    return { sourceId:source.id, settings:normalizeSourceBackground(source.background), state:control.state, counts:backgroundQueue.counts(source.id), pagesToday:usage.pages, translationRequestsToday:usage.requests, translationConsentValid:control.consent === signature, lastFileCount:control.file_count, lastCheckedAt:control.checked, message:control.message }
  }) }
}
export async function synchronizeBackground(): Promise<void> {
  if (synchronizing) { syncAgain = true; return synchronizing }
  synchronizing = (async () => {
    do {
      syncAgain = false
      if (sources.some(source => normalizeSourceBackground(source.background).semantic && backgroundQueue.control(source.id).state === 'running')) {
        const semantic = await import('../semantic/service.js')
        semanticRevision = await semantic.semanticIndexRevision()
      }
      for (const source of [...sources]) {
        const kinds = enabledKinds(normalizeSourceBackground(source.background))
        backgroundQueue.removeDisabled(source.id,kinds)
        if (!kinds.length) continue
        let after = ''
        while (!stopped) {
          const rows = db.prepare('SELECT a.id,a.data FROM assets a JOIN works w ON w.id=a.work_id WHERE w.source_id=? AND a.id>? ORDER BY a.id LIMIT 128').all(source.id,after) as Array<{id:string;data:string}>
          if (!rows.length) break
          for (const row of rows) {
            const asset = JSON.parse(row.data) as StoredAsset
            if (!asset.display || asset.kind !== 'image' || asset.extension === 'gif') continue
            for (const kind of kinds) backgroundQueue.enqueue(source.id,asset.id,taskStamp(asset,kind),kind)
          }
          after = rows.at(-1)!.id
          await yieldToRequests()
        }
      }
      for (const row of db.prepare('SELECT source_id FROM background_sources').all() as Array<{source_id:string}>) if (!sources.some(source => source.id === row.source_id)) backgroundQueue.removeSource(row.source_id)
      db.prepare("DELETE FROM background_tasks WHERE state<>'running' AND asset_id NOT IN (SELECT id FROM assets)").run()
    } while (syncAgain && !stopped)
  })().finally(() => { synchronizing = null })
  return synchronizing
}
/** Async directory enumeration: do not follow links, never block the event loop with recursive sync IO. */
export async function countSourceFiles(root: string, signal?: AbortSignal): Promise<number> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('目录监测不跟随符号链接或目录联接')
  const canonical = await realpath(root), pending = [canonical]
  let count = 0, visited = 0
  while (pending.length) {
    signal?.throwIfAborted()
    const directory = pending.pop()!
    if ((await lstat(directory)).isSymbolicLink()) continue
    const resolved = await realpath(directory), relative = path.relative(canonical,resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    const dir = await opendir(resolved)
    for await (const item of dir) {
      signal?.throwIfAborted()
      if (item.isSymbolicLink()) continue
      if (item.isDirectory()) pending.push(path.join(dir.path,item.name))
      else if (item.isFile()) count++
      if (++visited % 128 === 0) await yieldToRequests()
    }
  }
  return count
}
export async function checkBackgroundDirectories() {
  if (checking || stopped || scanStatus.running) return
  checking = true
  try {
    for (const source of [...sources]) {
      const settings = normalizeSourceBackground(source.background)
      if (!settings.watch || backgroundQueue.control(source.id).state !== 'running' || Date.now() < (nextChecks.get(source.id) || 0)) continue
      nextChecks.set(source.id,Date.now() + settings.watchIntervalSeconds*1000)
      const check = new AbortController()
      directoryChecks.set(source.id,check)
      try {
        const signal = stopWatcher ? AbortSignal.any([check.signal,stopWatcher.signal]) : check.signal
        const count = await countSourceFiles(source.path,signal)
        const current = sources.find(item => item.id === source.id)
        if (stopped || !current || current.path !== source.path || !normalizeSourceBackground(current.background).watch || backgroundQueue.control(source.id).state !== 'running') continue
        const previous = backgroundQueue.control(source.id).file_count
        // First observation scans too, so files added between startup scan and first tick are not lost.
        if (previous === null || previous !== count || sourceOnline.get(source.id) === false) {
          if (scanStatus.running) { nextChecks.set(source.id,0); continue }
          await scanLibrary({ sourceIds:[source.id], reason:'watch' })
          if (sourceOnline.get(source.id) === false) throw new Error('目录扫描失败，保留原索引并稍后重试')
        }
        backgroundQueue.fileCount(source.id,count,Date.now())
      } catch (error) { if (!stopped && !check.signal.aborted) { sourceOnline.set(source.id,false); backgroundQueue.message(source.id,`目录监测：${(error as Error).message}`) } }
      finally { directoryChecks.delete(source.id) }
    }
  } finally { checking = false }
}
function assertAllowed(task: Task, signal: AbortSignal) {
  signal.throwIfAborted()
  const source = sources.find(item => item.id === task.source_id)
  if (stopped || !source || backgroundQueue.control(task.source_id).state !== 'running' || !enabledKinds(normalizeSourceBackground(source.background)).includes(task.kind)) throw new DeferredTask('任务已暂停或功能已关闭')
  const asset = getAsset(task.asset_id)
  if (!asset || task.stamp !== taskStamp(asset,task.kind)) throw new DeferredTask('文件或 AI 配置已变化，等待重新同步')
  if (task.kind === 'translate' && backgroundQueue.control(task.source_id).consent !== translationSignature()) throw new DeferredTask('AI 配置已变更，请重新确认自动翻译费用')
}
export interface BackgroundRuntimeServices {
  manga: Pick<typeof import('../ai/manga/service.js'), 'hasManualMangaWork' | 'runBackgroundMangaAsset'>
  semantic?: Pick<typeof import('../semantic/service.js'), 'indexSemanticAsset'>
}
export async function runBackgroundTick(services?: BackgroundRuntimeServices) {
  if (ticking || stopped || scanStatus.running || Date.now() < cooldownUntil) return
  ticking = true
  const started = Date.now()
  let duty = 100, billed = false
  try {
    if (!sources.some(source => enabledKinds(normalizeSourceBackground(source.background)).length)) return
    const manga = services?.manga || await import('../ai/manga/service.js')
    if (manga.hasManualMangaWork()) return
    for (let i=0; i<sources.length; i++) {
      const source = sources[(roundRobin+i)%sources.length]!
      if (sourceOnline.get(source.id) === false || Date.now() < (blockedUntil.get(source.id)||0)) continue
      const task = backgroundQueue.next(source.id)
      if (!task) continue
      roundRobin = (roundRobin+i+1)%sources.length
      const settings = normalizeSourceBackground(source.background)
      const asset = getAsset(task.asset_id)
      if (!asset || task.stamp !== taskStamp(asset,task.kind) || !enabledKinds(settings).includes(task.kind)) { backgroundQueue.mark(task.id,'stopped'); continue }
      const controller = new AbortController()
      active = {task,controller}
      assertAllowed(task,controller.signal)
      if (task.kind === 'translate' && backgroundQueue.usage(source.id).requests >= settings.maxTranslationRequestsPerDay) throw new DeferredTask('今日自动翻译请求预算已用完；UTC 次日恢复')
      if (!backgroundQueue.reserve(source.id,'pages',settings.maxPagesPerDay)) throw new DeferredTask('今日后台计算预算已用完；UTC 次日恢复')
      backgroundQueue.mark(task.id,'running')
      duty = getLocalComputeConfig().mode === 'local' || getLocalComputeConfig().fallback === 'local' ? settings.localDutyPercent : 100
      const taskStarted = Date.now()
      const label = task.kind === 'semantic' ? 'CLIP 索引' : task.kind === 'translate' ? '自动翻译' : 'OCR 预热'
      logInfo('后台', `开始 ${label} · ${source.name} · ${asset.filename}`)
      if (task.kind === 'semantic') {
        const semantic = services?.semantic || await import('../semantic/service.js')
        const result = await semantic.indexSemanticAsset(asset)
        if (!result.indexed && result.reason !== 'cached') throw new Error(result.reason || 'CLIP 模型尚未就绪')
        logInfo('后台', `${result.indexed ? '完成' : '跳过（已索引）'} ${label} · ${asset.filename} · ${formatDuration(Date.now() - taskStarted)}`)
      } else {
        await manga.runBackgroundMangaAsset(asset, { translate:task.kind === 'translate', signal:controller.signal, beforeTranslate: () => {
          assertAllowed(task,controller.signal)
          if (manga.hasManualMangaWork()) throw new DeferredTask('让位给手动翻译')
          const current = normalizeSourceBackground(sourceById(source.id).background)
          if (!backgroundQueue.reserve(source.id,'requests',current.maxTranslationRequestsPerDay)) throw new DeferredTask('今日自动翻译请求预算已用完；UTC 次日恢复')
          billed = true
        } })
        logInfo('后台', `完成 ${label} · ${asset.filename} · ${formatDuration(Date.now() - taskStarted)}`)
      }
      backgroundQueue.mark(task.id,'done')
      backgroundQueue.message(source.id,'')
      break
    }
  } catch (error) {
    if (active) {
      const {task,controller} = active
      // 首次启用语义索引会先自动下载 CLIP 模型：这不是失败，等下载完成后重试。
      const downloading = (error as { code?: string }).code === 'semantic_downloading'
      const deferred = error instanceof DeferredTask || controller.signal.aborted || downloading
      // After a request was reserved, interruption is ambiguous: require an explicit retry to avoid surprise billing.
      const state = deferred && !billed ? (backgroundQueue.control(task.source_id).state === 'stopped' ? 'stopped' : 'queued') : 'failed'
      backgroundQueue.mark(task.id,state,(error as Error).message)
      backgroundQueue.message(task.source_id,(error as Error).message)
      if (state === 'failed') logError('后台', `失败 ${task.kind === 'semantic' ? 'CLIP 索引' : task.kind === 'translate' ? '自动翻译' : 'OCR 预热'} · ${(error as Error).message}`)
      else if (downloading) logInfo('后台', 'CLIP 模型正在下载/加载，任务稍后自动重试')
      else logWarn('后台', `暂缓任务 · ${(error as Error).message}`)
      blockedUntil.set(task.source_id,Date.now()+60000)
    }
  } finally {
    if (active) cooldownUntil = Date.now() + (Date.now()-started)*(100/duty-1)
    active = null; ticking = false
  }
}
export function startBackgroundRuntime() {
  if (timer) return
  stopped = false; stopWatcher = new AbortController()
  removeScanListener = onScanComplete(() => { void synchronizeBackground().catch(() => {}) })
  void synchronizeBackground().catch(() => {})
  timer = setInterval(() => { void checkBackgroundDirectories().catch(() => {}); void runBackgroundTick().catch(() => {}) },1000)
  timer.unref()
}
export function stopBackgroundRuntime() {
  stopped = true
  if (timer) clearInterval(timer)
  timer = undefined; for (const check of directoryChecks.values()) check.abort(); stopWatcher?.abort(); active?.controller.abort(); removeScanListener?.()
}
