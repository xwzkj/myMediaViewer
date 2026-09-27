import { readdir, stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { sources } from './config.js'
import { db, saveSource, type StoredAsset, type StoredWork } from './database.js'
import { emptyMetadata, parseMetadataFile, parseName, type Metadata, type ParsedName } from './parsers.js'
import type { ScanStatus, Source } from '../shared/types.js'

// 解析器行为变化后要让旧缓存失效，所以缓存戳里带上版本号。
const PARSE_VERSION = 2
export const scanStatus: ScanStatus = { running: false, phase: '尚未扫描', files: 0, works: 0, startedAt: null, finishedAt: null, errors: [] }
export const sourceOnline = new Map<string, boolean>()
let afterScan: () => void = () => {}
export function onScan(callback: () => void) { afterScan = callback }

async function* filesIn(folder: string): AsyncGenerator<string> {
  const entries = await readdir(folder, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) yield* filesIn(fullPath)
    else if (entry.isFile()) yield fullPath
  }
}

async function metadata(file: string, stamp: string, source: Source): Promise<Metadata> {
  const row = db.prepare('SELECT stamp, data FROM metadata_cache WHERE path = ?').get(file) as { stamp: string; data: string } | undefined
  if (row?.stamp === stamp) return JSON.parse(row.data)
  const value = parseMetadataFile(await readFile(file), file, source.kind)
  db.prepare('INSERT OR REPLACE INTO metadata_cache VALUES (?, ?, ?)').run(file, stamp, JSON.stringify(value))
  return value
}

export async function scanLibrary(): Promise<void> {
  if (scanStatus.running) return
  Object.assign(scanStatus, { running: true, phase: '正在读取目录', files: 0, works: 0, startedAt: Date.now(), errors: [] })
  try {
    for (const source of sources) {
      scanStatus.phase = `正在整理 ${source.name}`
      try {
        type Entry = { path: string; filename: string; parsed: ParsedName; size: number; modified: number }
        const groups = new Map<string, Entry[]>()
        for await (const file of filesIn(source.path)) {
          const parsed = parseName(path.basename(file), source.kind)
          if (!parsed) continue
          const info = await stat(file)
          const entries = groups.get(parsed.externalId) || []
          entries.push({ path: file, filename: path.basename(file), parsed, size: info.size, modified: info.mtimeMs })
          groups.set(parsed.externalId, entries)
          scanStatus.files++
        }
        const works: StoredWork[] = []
        const assets: StoredAsset[] = []
        for (const [externalId, entries] of groups) {
          const media = entries.filter(e => !e.parsed.metadata)
          if (!media.length) continue
          const id = `${source.id}:${externalId}`
          // json 元文件字段更全（含翻译标签），以它为主；json 缺的字段再由 txt 补齐。
          const metas = entries.filter(e => e.parsed.metadata)
          const newest = (extension: string) => metas.filter(e => e.parsed.extension === extension).sort((a, b) => b.modified - a.modified)[0]
          const chosen = [newest('json'), newest('txt')].filter((entry): entry is Entry => Boolean(entry))
          let details: Metadata = emptyMetadata()
          for (const meta of chosen) {
            try {
              const value = await metadata(meta.path, `${meta.modified}:${meta.size}:${PARSE_VERSION}`, source)
              details = {
                title: details.title || value.title,
                author: details.author || value.author,
                description: details.description || value.description,
                tags: [...new Set([...details.tags, ...value.tags])],
                date: details.date || value.date,
                originalUrl: details.originalUrl || value.originalUrl,
              }
            } catch { scanStatus.errors.push(`无法读取描述：${meta.filename}`) }
          }
          // Repeated exports and GIF/WebM alternatives share a logical page.
          const priority = (entry: Entry) => entry.parsed.kind === 'animation' && entry.parsed.extension === 'webm' ? 2 : 1
          media.sort((a, b) => a.parsed.page - b.parsed.page || priority(b) - priority(a) || b.modified - a.modified)
          const seen = new Set<string>()
          const workAssets: StoredAsset[] = media.map(entry => {
            const key = `${entry.parsed.kind}:${entry.parsed.page}`
            const display = !seen.has(key)
            seen.add(key)
            return {
              id: createHash('sha256').update(`${source.id}:${path.relative(source.path, entry.path)}`).digest('hex').slice(0, 24),
              workId: id, path: entry.path, filename: entry.filename, page: entry.parsed.page,
              kind: entry.parsed.kind, extension: entry.parsed.extension, size: entry.size, modified: entry.modified, display,
            }
          })
          const visible = workAssets.filter(a => a.display)
          assets.push(...workAssets)
          const updated = Math.max(...entries.map(e => e.modified))
          const defaultDate = source.kind === 'telegram'
            ? `${externalId.split('_')[1].slice(0, 4)}-${externalId.split('_')[1].slice(4)}-01`
            : new Date(updated).toISOString()
          works.push({
            id, externalId, sourceId: source.id, sourceName: source.name, sourceKind: source.kind,
            ...details, title: details.title || `${source.kind === 'pixiv' ? 'Pixiv' : '媒体'} · ${externalId}`,
            date: details.date || defaultDate, updated, count: visible.length,
            // 同一作品可能留下多个收藏编号（重新收藏或分批导出），取最大的那个，代表最近一次收藏位置。
            collected: Math.max(...entries.map(entry => entry.parsed.sequence)),
            kind: visible.some(a => a.kind === 'video') ? 'video' : visible.some(a => a.kind === 'animation') ? 'animation' : 'image',
            coverId: visible[0].id,
          })
          scanStatus.works++
        }
        saveSource(source, works, assets)
        sourceOnline.set(source.id, true)
      } catch (error) {
        sourceOnline.set(source.id, false)
        scanStatus.errors.push(`${source.name} 扫描失败，保留已有索引：${(error as Error).message}`)
      }
    }
    afterScan()
    scanStatus.phase = scanStatus.errors.length ? '扫描完成，部分文件需要检查' : '媒体库已更新'
  } finally { scanStatus.running = false; scanStatus.finishedAt = Date.now() }
}
