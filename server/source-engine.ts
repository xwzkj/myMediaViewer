import type { Stats } from 'node:fs'
import { readdir, lstat, realpath, open } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Source, SourceRules, ScriptFile, ScriptInput, MediaKind, SourcePreview, MetadataFields } from '../shared/types.js'
import { sourcePreset } from '../shared/source-presets.js'
import { decodeText, emptyMetadata } from './parsers.js'
import { sandbox, normalizeMetadata } from './source-sandbox.js'
import { LIMITS } from './source-rules.js'

export interface Entry extends ScriptFile { path: string; metadata: boolean; kind: MediaKind; identity: string }
export interface Group { id: string; directory: string; entries: Entry[] }
export function rulesFor(source: Source): SourceRules {
  if (source.rules) return source.rules
  if (source.kind === 'pixiv' || source.kind === 'telegram') return sourcePreset(source.kind)
  throw new Error('来源缺少规则配置')
}
const images = new Set(['jpg','jpeg','png','webp','avif','bmp'])
const videos = new Set(['mp4','mov','webm','mkv','m4v','avi'])
const identity = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
export function isWithin(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
async function safePath(root: string, file: string): Promise<void> {
  if (!isWithin(root, file)) throw new Error('文件越过来源目录边界')
  const parts = path.relative(root, file).split(path.sep).filter(Boolean)
  let current = root
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part)
    const s = await lstat(current)
    if (s.isSymbolicLink() || !isWithin(root, await realpath(current))) throw new Error('不允许符号链接、目录联接或越界文件')
  }
}
export async function readSnapshot(root: string, entry: Entry): Promise<string> {
  await safePath(root, entry.path)
  const handle = await open(entry.path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink > 1 || identity(before) !== entry.identity) throw new Error('文件身份变化或为硬链接')
    if (before.size > LIMITS.file) throw new Error('单个元文件超过 2 MiB')
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    await safePath(root, entry.path)
    const after = await handle.stat(), current = await lstat(entry.path)
    if (offset !== before.size || identity(after) !== entry.identity || identity(current) !== entry.identity) throw new Error('读取期间文件发生变化')
    return decodeText(buffer.subarray(0, offset))
  } finally { await handle.close() }
}
export async function collectGroups(source: Source, limit = Infinity, progress?: (matched: number) => void) {
  const rules = rulesFor(source), root = path.resolve(source.path)
  await safePath(root, root)
  const groups = new Map<string, Group>(), errors: string[] = []
  let enumerated = 0, matched = 0, truncated = false
  const natural = new Intl.Collator('en', { numeric: true }).compare
  let batch: string[] = []
  const flush = async () => {
    if (!batch.length) return
    const files = batch; batch = []
    const results = await sandbox<Array<{ metadata: boolean; captures: Record<string, string> } | null>>({ type: 'match', rules, names: files.map(f => path.relative(root, f).split(path.sep).join('/')) })
    // Keep every path check, but overlap filesystem calls with bounded concurrency.
    const inspected = new Map<number, Stats | Error>()
    let cursor = 0
    await Promise.all(Array.from({length: Math.min(16, files.length)}, async () => {
      while (cursor < files.length) {
        const i = cursor++, result = results[i]
        if (!result) continue
        const ext = path.extname(files[i]).slice(1).toLowerCase()
        if (!result.metadata && !images.has(ext) && !videos.has(ext) && ext !== 'gif') continue
        try { await safePath(root, files[i]); inspected.set(i, await lstat(files[i])) }
        catch (error) { inspected.set(i, error as Error) }
      }
    }))
    for (let i = 0; i < files.length; i++) {
      const result = results[i]; if (!result) continue
      const file = files[i], filename = path.basename(file), extension = path.extname(filename).slice(1).toLowerCase()
      if (!result.metadata && !images.has(extension) && !videos.has(extension) && extension !== 'gif') continue
      try {
        const { id } = result.captures
        if (!id || id.length > 512) throw new Error('分组 id 为空或超过 512 字符')
        const numeric = (key: string) => {
          const value = result.captures[key]
          if (value === undefined) return undefined
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} 必须为非负安全整数`)
          return Number(value)
        }
        const info = inspected.get(i)
        if (info instanceof Error) throw info
        if (!info) continue
        if (!info.isFile()) continue
        const relativePath = path.relative(root, file).split(path.sep).join('/')
        const directory = rules.scope === 'directory' ? path.posix.dirname(relativePath) : ''
        const key = JSON.stringify([directory, id])
        const group = groups.get(key) ?? { id, directory: directory === '.' ? '' : directory, entries: [] }
        const kind = Object.hasOwn(rules.typeOverrides, extension) ? rules.typeOverrides[extension] : extension === 'gif' ? 'animation' : videos.has(extension) ? 'video' : 'image'
        group.entries.push({ path: file, filename, relativePath, extension, captures: result.captures, metadata: result.metadata,
          page: numeric('page') ?? (result.metadata ? undefined : rules.media.defaultPage), sequence: numeric('sequence'), kind, size: info.size, modified: info.mtimeMs, identity: identity(info) })
        groups.set(key, group); matched++
      } catch (e) { if (errors.length < 100) errors.push(`${filename}: ${(e as Error).message}`) }
    }
    progress?.(matched)
  }
  const walk = async (folder: string): Promise<void> => {
    await safePath(root, folder)
    const entries = await readdir(folder, { withFileTypes: true })
    entries.sort((a,b) => natural(a.name, b.name))
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink()) continue
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) {
        if (enumerated >= limit) { truncated = true; return }
        enumerated++; batch.push(file)
        if (batch.length >= 100) await flush()
      }
    }
  }
  await walk(root); await flush()
  return { groups: [...groups.values()].filter(g => g.entries.some(e => !e.metadata)), errors, enumerated, matched, truncated }
}
export function groupWorkId(source: Source, group: Group): string {
  return rulesFor(source).scope === 'source' ? `${source.id}:${group.id}`
    : `v2:${JSON.stringify([source.id, group.directory, group.id])}`
}
export function groupStamp(source: Source, group: Group, rulesJSON = JSON.stringify(rulesFor(source))): string {
  return createHash('sha256').update('[3,' + rulesJSON + ',' + JSON.stringify(group.id) + ',' + JSON.stringify(group.directory) + ',' +
    JSON.stringify(group.entries.map(e => [e.relativePath, e.identity, e.captures])) + ']').digest('hex')
}
function publicFile(e: Entry): ScriptFile {
  return { filename: e.filename, relativePath: e.relativePath, directory: e.relativePath.includes('/') ? e.relativePath.slice(0, e.relativePath.lastIndexOf('/')) : '', directoryName: e.relativePath.split('/').at(-2) ?? '', extension: e.extension, size: e.size, modified: e.modified, captures: e.captures, page: e.page, sequence: e.sequence }
}
export async function extractGroup(source: Source, group: Group): Promise<MetadataFields> {
  const files = group.entries.filter(e => e.metadata)
  if (files.length > LIMITS.files || files.reduce((sum, f) => sum + f.size, 0) > LIMITS.total) throw new Error('每组元文件最多 64 个、合计 8 MiB')
  const input: ScriptInput = { id: group.id, directory: group.directory, media: group.entries.filter(e => !e.metadata).map(publicFile), files: [] }
  for (const file of files) input.files.push({ ...publicFile(file), text: await readSnapshot(source.path, file) })
  // Decoded text can expand (e.g. UTF-16); cap the actual transferred snapshot as well.
  if (Buffer.byteLength(JSON.stringify(input)) > LIMITS.total * 2) throw new Error('解码后的分组输入过大')
  return normalizeMetadata(await sandbox({ type: 'extract', rules: rulesFor(source), input }))
}
export async function previewSource(source: Source): Promise<SourcePreview> {
  const collected = await collectGroups(source, 5000)
  const result: SourcePreview = { enumerated: collected.enumerated, truncated: collected.truncated || collected.groups.length > 20, errors: collected.errors, groups: [] }
  for (const group of collected.groups.slice(0, 20)) {
    const row: SourcePreview['groups'][number] = { id: group.id, directory: group.directory, captures: group.entries.map(e => ({relativePath: e.relativePath, metadata: e.metadata, captures: e.captures})),
      media: group.entries.filter(e => !e.metadata).map(e => e.relativePath), metadata: group.entries.filter(e => e.metadata).map(e => e.relativePath) }
    if (result.groups.length < 5) {
      try { row.result = await extractGroup(source, group) }
      catch (error) { row.error = (error as Error).message; row.result = emptyMetadata() }
    }
    result.groups.push(row)
  }
  return result
}
