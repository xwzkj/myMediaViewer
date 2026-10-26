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
import { remoteBackgroundConcurrency } from './limits.js'

export const backgroundQueue = new BackgroundQueue(db)
const challenges = new Map<string, { sourceId: string; signature: string; settings: string; expires: number }>()
interface ActiveTask { task: Task; controller: AbortController }
/** 正在执行的后台任务；远程模式可同时有多个，本地模式最多一个。 */
const activeTasks = new Map<string, ActiveTask>()
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
/** 当前允许的后台并发数：远程流水线可调，本机 ONNX 会话始终逐页。 */
function backgroundWorkerLimit(): number {
  return getLocalComputeConfig().mode === 'remote' ? remoteBackgroundConcurrency() : 1
}
function abortSource(sourceId: string) {
  for (const entry of activeTasks.values()) if (entry.task.source_id === sourceId) entry.controller.abort()
}
/** 同一种任务同时只跑一个：CLIP 会话与付费翻译都不适合并发堆积。 */
function allowedKinds(): BackgroundTaskKind[] {
  const kinds: BackgroundTaskKind[] = ['semantic', 'ocr', 'translate']
  if ([...activeTasks.values()].some(entry => entry.task.kind === 'semantic')) kinds.splice(kinds.indexOf('semantic'), 1)
  if ([...activeTasks.values()].some(entry => entry.task.kind === 'translate')) kinds.splice(kinds.indexOf('translate'), 1)
  return kinds
}
function deferTask(sourceId: string, task: Task, message: string) {
  backgroundQueue.mark(task.id, 'queued', message)
  backgroundQueue.message(sourceId, message)
  blockedUntil.set(sourceId, Date.now() + 60000)
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
  abortSource(sourceId)
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
  if (action === 'pause' || action === 'stop') { directoryChecks.get(sourceId)?.abort(); abortSource(sourceId) }
  blockedUntil.delete(sourceId)
  if (state === 'running') void synchronizeBackground().catch(error => backgroundQueue.message(sourceId,String(error)))
}
export function getBackgroundStatus(): BackgroundStatus {
  const signature = translationSignature()
  return { localComputeMode: getLocalComputeConfig().mode, active: [...activeTasks.values()].map(({ task }) => ({ sourceId: task.source_id, assetId: task.asset_id, kind: task.kind })), sources: sources.map(source => {
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
function pickTask(kinds: BackgroundTaskKind[]): { source: (typeof sources)[number]; task: Task } | undefined {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[(roundRobin + i) % sources.length]!
    if (sourceOnline.get(source.id) === false || Date.now() < (blockedUntil.get(source.id) || 0)) continue
    const task = backgroundQueue.next(source.id, kinds)
    if (!task) continue
    roundRobin = (roundRobin + i + 1) % sources.length
    return { source, task }
  }
  return undefined
}

const taskLabel = (task: Task) => task.kind === 'semantic' ? 'CLIP 索引' : task.kind === 'translate' ? '自动翻译' : 'OCR 预热'

/**
 * 启动一轮后台任务。
 *
 * 远程模式会一次补满流水线（默认 3 个），而不是算完一张再等下一次 1 秒定时器：
 * 上传、排队、推理和下载覆盖层互相重叠，计算端才不会在任务之间空转。
 * 本地模式仍只有一个名额，并由占空比在任务之间休息。
 */
export async function runBackgroundTick(services?: BackgroundRuntimeServices) {
  if (ticking || stopped || scanStatus.running || Date.now() < cooldownUntil) return
  if (activeTasks.size >= backgroundWorkerLimit()) return
  ticking = true
  try {
    if (!sources.some(source => enabledKinds(normalizeSourceBackground(source.background)).length)) return
    const manga = services?.manga || await import('../ai/manga/service.js')
    if (manga.hasManualMangaWork()) return
    const limit = backgroundWorkerLimit()
    let guard = 0
    while (activeTasks.size < limit && guard++ < sources.length * 8) {
      const picked = pickTask(allowedKinds())
      if (!picked) break
      const { source, task } = picked
      const settings = normalizeSourceBackground(source.background)
      const asset = getAsset(task.asset_id)
      if (!asset || task.stamp !== taskStamp(asset, task.kind) || !enabledKinds(settings).includes(task.kind)) {
        backgroundQueue.mark(task.id, 'stopped')
        continue
      }
      if (task.kind === 'translate' && backgroundQueue.control(source.id).consent !== translationSignature()) {
        deferTask(source.id, task, 'AI 配置已变更，请重新确认自动翻译费用')
        continue
      }
      if (task.kind === 'translate' && backgroundQueue.usage(source.id).requests >= settings.maxTranslationRequestsPerDay) {
        deferTask(source.id, task, '今日自动翻译请求预算已用完；UTC 次日恢复')
        continue
      }
      if (!backgroundQueue.reserve(source.id, 'pages', settings.maxPagesPerDay)) {
        deferTask(source.id, task, '今日后台计算预算已用完；UTC 次日恢复')
        continue
      }
      const controller = new AbortController()
      backgroundQueue.mark(task.id, 'running')
      activeTasks.set(task.id, { task, controller })
      logInfo('后台', `开始 ${taskLabel(task)} · ${source.name} · ${asset.filename}`)
      void runBackgroundTask(source, task, asset, settings, controller, manga, services)
    }
  } finally { ticking = false }
}

async function runBackgroundTask(
  source: (typeof sources)[number],
  task: Task,
  asset: StoredAsset,
  settings: SourceBackgroundSettings,
  controller: AbortController,
  manga: BackgroundRuntimeServices['manga'],
  services?: BackgroundRuntimeServices,
) {
  const started = Date.now()
  let duty = 100, billed = false
  // 只有真正在本机执行（本地模式或实际回退）才按占空比休息；远程任务被 1 秒
  // 定时器拖慢已经是过去式，不能因为配置里保留了本地回退就人为降速。
  let usedLocal = getLocalComputeConfig().mode === 'local'
  try {
    assertAllowed(task, controller.signal)
    duty = usedLocal ? settings.localDutyPercent : 100
    if (task.kind === 'semantic') {
      const semantic = services?.semantic || await import('../semantic/service.js')
      const result = await semantic.indexSemanticAsset(asset)
      if (!result.indexed && result.reason !== 'cached') throw new Error(result.reason || 'CLIP 模型尚未就绪')
      logInfo('后台', `${result.indexed ? '完成' : '跳过（已索引）'} ${taskLabel(task)} · ${asset.filename} · ${formatDuration(Date.now() - started)}`)
    } else {
      await manga.runBackgroundMangaAsset(asset, {
        translate: task.kind === 'translate',
        signal: controller.signal,
        onLocalFallback: () => { usedLocal = true },
        beforeTranslate: () => {
          assertAllowed(task, controller.signal)
          if (manga.hasManualMangaWork()) throw new DeferredTask('让位给手动翻译')
          const current = normalizeSourceBackground(sourceById(source.id).background)
          if (!backgroundQueue.reserve(source.id, 'requests', current.maxTranslationRequestsPerDay)) throw new DeferredTask('今日自动翻译请求预算已用完；UTC 次日恢复')
          billed = true
        },
      })
      logInfo('后台', `完成 ${taskLabel(task)} · ${asset.filename} · ${formatDuration(Date.now() - started)}`)
    }
    backgroundQueue.mark(task.id, 'done')
    backgroundQueue.message(source.id, '')
  } catch (error) {
    // 首次启用语义索引会先自动下载 CLIP 模型：这不是失败，等下载完成后重试。
    const downloading = (error as { code?: string }).code === 'semantic_downloading'
    const deferred = error instanceof DeferredTask || controller.signal.aborted || downloading
    // After a request was reserved, interruption is ambiguous: require an explicit retry to avoid surprise billing.
    const state = deferred && !billed ? (backgroundQueue.control(task.source_id).state === 'stopped' ? 'stopped' : 'queued') : 'failed'
    backgroundQueue.mark(task.id, state, (error as Error).message)
    backgroundQueue.message(task.source_id, (error as Error).message)
    if (state === 'failed') logError('后台', `失败 ${taskLabel(task)} · ${(error as Error).message}`)
    else if (downloading) logInfo('后台', 'CLIP 模型正在下载/加载，任务稍后自动重试')
    else logWarn('后台', `暂缓任务 · ${(error as Error).message}`)
    blockedUntil.set(task.source_id, Date.now() + 60000)
  } finally {
    activeTasks.delete(task.id)
    if (usedLocal) duty = settings.localDutyPercent
    if (usedLocal && duty < 100 && !stopped) cooldownUntil = Math.max(cooldownUntil, Date.now() + (Date.now() - started) * (100 / duty - 1))
    // 有空位就立刻补，不必等下一次 1 秒定时器。
    if (!stopped) void runBackgroundTick(services).catch(() => {})
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
  timer = undefined; for (const check of directoryChecks.values()) check.abort(); stopWatcher?.abort(); for (const entry of activeTasks.values()) entry.controller.abort(); removeScanListener?.()
}
