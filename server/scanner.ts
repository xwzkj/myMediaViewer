import path from 'node:path'
import { createHash } from 'node:crypto'
import { sources } from './config.js'
import { db, saveSource, type StoredAsset, type StoredWork } from './database.js'
import { emptyMetadata, type Metadata } from './parsers.js'
import { collectGroups, extractGroup, groupStamp, groupWorkId, rulesFor, type Group } from './source-engine.js'
import type { ScanStatus, Source } from '../shared/types.js'
import { formatDuration, logError, logInfo, logWarn } from './log.js'

export const scanStatus: ScanStatus = { running: false, phase: '尚未扫描', files: 0, works: 0, startedAt: null, finishedAt: null, errors: [] }
export const sourceOnline = new Map<string, boolean>()
let afterScan: () => void = () => {}
export function onScan(callback: () => void) { afterScan = callback }

async function metadata(source: Source, group: Group): Promise<Metadata> {
  const key = groupWorkId(source, group), stamp = groupStamp(source, group)
  const row = db.prepare('SELECT stamp, data FROM group_metadata_cache WHERE key = ?').get(key) as { stamp: string; data: string } | undefined
  if (row?.stamp === stamp) return JSON.parse(row.data)
  const value = await extractGroup(source, group)
  db.prepare('INSERT OR REPLACE INTO group_metadata_cache VALUES (?, ?, ?)').run(key, stamp, JSON.stringify(value))
  return value
}

export interface ScanOptions {
  /** manual：用户手动刷新或启动时整理，逐目录汇报；auto：每 5 分钟的对账，只在发现变化或出错时说话。 */
  reason?: 'manual' | 'auto'
}

export async function scanLibrary(options: ScanOptions = {}): Promise<void> {
  if (scanStatus.running) return
  const manual = options.reason !== 'auto'
  const started = Date.now()
  const previous = { files: scanStatus.files, works: scanStatus.works }
  Object.assign(scanStatus, { running: true, phase: '正在读取目录', files: 0, works: 0, startedAt: started, errors: [] })
  if (manual) logInfo('扫描', `开始检查 ${sources.length} 个媒体目录`)
  try {
    for (const source of sources) {
      const sourceStarted = Date.now()
      const baseline = scanStatus.works
      scanStatus.phase = `正在整理 ${source.name}`
      try {
        const rules = rulesFor(source)
        const collected = await collectGroups(source)
        scanStatus.files += collected.matched
        scanStatus.errors.push(...collected.errors.map(e => `${source.name}: ${e}`))
        const works: StoredWork[] = [], assets: StoredAsset[] = []
        for (const group of collected.groups) {
          const { id: externalId, entries } = group
          const media = entries.filter(e => !e.metadata)
          const id = groupWorkId(source, group)
          let details: Metadata = emptyMetadata()
          try { details = await metadata(source, group) }
          catch (error) { if (scanStatus.errors.length < 200) scanStatus.errors.push(`${source.name} / ${externalId}: ${(error as Error).message}`) }
          const priority = (entry: typeof media[number]) => entry.kind === 'animation' && entry.extension === 'webm' ? 2 : 1
          media.sort((a, b) => (a.page ?? 0) - (b.page ?? 0)
            || (rules.duplicates === 'page' && a.page !== undefined && b.page !== undefined ? priority(b) - priority(a) || b.modified - a.modified : 0)
            || a.relativePath.localeCompare(b.relativePath, 'en', { numeric: true }))
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
        }
        saveSource(source, works, assets)
        sourceOnline.set(source.id, true)
        if (manual) logInfo('扫描', `${source.name}：整理出 ${scanStatus.works - baseline} 组作品 · 用时 ${formatDuration(Date.now() - sourceStarted)}`)
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
    // 定时对账大多数时候没有变化，静默处理；只有内容或文件数变了、或出错才留下记录。
    const changed = scanStatus.files !== previous.files || scanStatus.works !== previous.works
    if (manual || changed || scanStatus.errors.length) {
      const summary = `完成 · ${scanStatus.works} 组作品 / ${scanStatus.files} 个文件 · 用时 ${formatDuration(Date.now() - started)}`
      if (scanStatus.errors.length) logWarn('扫描', `${summary} · ${scanStatus.errors.length} 处需要检查`)
      else logInfo('扫描', summary)
    }
  }
}
