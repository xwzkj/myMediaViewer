import path from 'node:path'
import { setImmediate as yieldToRequests } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { sources } from './config.js'
import { db, saveSource, type StoredAsset, type StoredWork } from './database.js'
import { emptyMetadata, type Metadata } from './parsers.js'
import { collectGroups, extractGroup, groupStamp, groupWorkId, rulesFor } from './source-engine.js'
import type { ScanStatus } from '../shared/types.js'
import { formatDuration, logError, logInfo, logWarn } from './log.js'

export const scanStatus: ScanStatus = { running: false, phase: '尚未扫描', files: 0, works: 0, startedAt: null, finishedAt: null, errors: [] }
export const sourceOnline = new Map<string, boolean>()
let afterScan: () => void = () => {}
export function onScan(callback: () => void) { afterScan = callback }

export interface ScanOptions {
  /** Omit to scan the entire library. Configuration changes pass only the changed source. */
  sourceIds?: string[]
  reason?: 'manual' | 'startup' | 'source-change'
}

export async function scanLibrary(options: ScanOptions = {}): Promise<void> {
  if (scanStatus.running) return
  const selected = options.sourceIds ? sources.filter(s => options.sourceIds!.includes(s.id)) : [...sources]
  const started = Date.now()
  Object.assign(scanStatus, { running: true, phase: '正在读取目录', files: 0, works: 0, startedAt: started, errors: [] })
  logInfo('扫描', `开始检查 ${selected.length} 个媒体目录`)
  try {
    for (const source of selected) {
      const sourceStarted = Date.now()
      const baseline = scanStatus.works
      scanStatus.phase = `正在整理 ${source.name}`
      try {
        const rules = rulesFor(source)
        const fileBaseline = scanStatus.files
        const collected = await collectGroups(source, Infinity, matched => { scanStatus.files = fileBaseline + matched })
        scanStatus.files = fileBaseline + collected.matched
        scanStatus.errors.push(...collected.errors.map(e => `${source.name}: ${e}`))
        const collectedAt = Date.now()
        const ruleJSON = JSON.stringify(rules)
        const cachedRows = new Map((db.prepare('SELECT key, stamp, data FROM group_metadata_cache WHERE key IN (SELECT id FROM works WHERE source_id = ?)').all(source.id) as Array<{key: string; stamp: string; data: string}>).map(row => [row.key, row]))
        const pendingCache: Array<{key: string; stamp: string; data: string}> = []
        const detailsByGroup: Metadata[] = new Array(collected.groups.length)
        let next = 0, hits = 0, completed = 0
        // Two independent runtimes, bounded input preparation and no unbounded sandbox queue.
        await Promise.all(Array.from({length: Math.min(2, collected.groups.length)}, async () => {
          while (next < collected.groups.length) {
            const index = next++, group = collected.groups[index]
            const key = groupWorkId(source, group), stamp = groupStamp(source, group, ruleJSON)
            const row = cachedRows.get(key)
            try {
              if (row?.stamp === stamp) { detailsByGroup[index] = JSON.parse(row.data); hits++ }
              else {
                const value = await extractGroup(source, group)
                detailsByGroup[index] = value
                pendingCache.push({key, stamp, data: JSON.stringify(value)})
              }
            } catch (error) {
              detailsByGroup[index] = emptyMetadata()
              if (scanStatus.errors.length < 200) scanStatus.errors.push(`${source.name} / ${group.id}: ${(error as Error).message}`)
            }
            completed++
            scanStatus.phase = `正在整理 ${source.name} · 元信息 ${completed}/${collected.groups.length}`
            if (index % 128 === 0) await yieldToRequests()
          }
        }))
        const extractedAt = Date.now()
        const works: StoredWork[] = [], assets: StoredAsset[] = []
        const natural = new Intl.Collator('en', { numeric: true }).compare
        for (const [groupIndex, group] of collected.groups.entries()) {
          const { id: externalId, entries } = group
          const media = entries.filter(e => !e.metadata)
          const id = groupWorkId(source, group)
          const details = detailsByGroup[groupIndex]
          const priority = (entry: typeof media[number]) => entry.kind === 'animation' && entry.extension === 'webm' ? 2 : 1
          media.sort((a, b) => (a.page ?? 0) - (b.page ?? 0)
            || (rules.duplicates === 'page' && a.page !== undefined && b.page !== undefined ? priority(b) - priority(a) || b.modified - a.modified : 0)
            || natural(a.relativePath, b.relativePath))
          // Missing page numbers never collapse unrelated files. Presets explicitly capture a default page.
          const seen = new Set<string>()
          const workAssets: StoredAsset[] = media.map((entry, index) => {
            const key = entry.page === undefined ? entry.relativePath : `${entry.kind}:${entry.page}`
            const display = rules.duplicates === 'all' || !seen.has(key)
            seen.add(key)
            return {
              id: createHash('sha256').update(`${source.id}:${path.relative(source.path, entry.path)}`).digest('hex').slice(0, 24),
              workId: id, path: entry.path, filename: entry.filename, page: entry.page ?? index,
              kind: entry.kind, extension: entry.extension, size: entry.size, modified: entry.modified, display,
            }
          })
          const visible = workAssets.filter(a => a.display)
          assets.push(...workAssets)
          const updated = entries.reduce((max, e) => Math.max(max, e.modified), 0)
          const sequences = entries.flatMap(e => e.sequence === undefined ? [] : [e.sequence])
          works.push({
            id, externalId, sourceId: source.id, sourceName: source.name, sourceKind: source.kind,
            ...details, title: details.title || `${source.name} · ${externalId}`,
            date: details.date || new Date(updated).toISOString(), updated, count: visible.length,
            collected: sequences.length ? sequences.reduce((max, n) => Math.max(max, n), 0) : updated,
            kind: visible.some(a => a.kind === 'video') ? 'video' : visible.some(a => a.kind === 'animation') ? 'animation' : 'image',
            coverId: visible[0].id,
          })
          scanStatus.works++
          if (groupIndex % 128 === 0) await yieldToRequests()
        }
        saveSource(source, works, assets, pendingCache)
        sourceOnline.set(source.id, true)
        logInfo('扫描', `${source.name}：整理出 ${scanStatus.works - baseline} 组作品 · 用时 ${formatDuration(Date.now() - sourceStarted)}（枚举/匹配 ${formatDuration(collectedAt - sourceStarted)} · 元信息 ${formatDuration(extractedAt - collectedAt)} · 缓存 ${hits}/${collected.groups.length}）`)
      } catch (error) {
        sourceOnline.set(source.id, false)
        const detail = `${source.name} 扫描失败，保留已有索引：${(error as Error).message}`
        scanStatus.errors.push(detail)
        logError('扫描', detail, error)
      }
    }
    afterScan()
    scanStatus.phase = scanStatus.errors.length ? '扫描完成，部分文件需要检查' : '媒体库已更新'
  } finally {
    scanStatus.running = false
    scanStatus.finishedAt = Date.now()
    const summary = `完成 · ${scanStatus.works} 组作品 / ${scanStatus.files} 个文件 · 用时 ${formatDuration(Date.now() - started)}`
    if (scanStatus.errors.length) logWarn('扫描', `${summary} · ${scanStatus.errors.length} 处需要检查`)
    else logInfo('扫描', summary)
  }
}
