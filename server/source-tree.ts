import { opendir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SourceAiSample } from '../shared/types.js'
import { isWithin } from './source-engine.js'

const samples = new Map<string, { sample: SourceAiSample; folder: string; expires: number }>()
export const SOURCE_TREE_MAX_LENGTH = 100
export const SOURCE_TREE_MAX_CALLS = 24

// Names only: no file contents, absolute paths, symlink targets or configuration are sent upstream.
export async function sourceTreeSample(folder: string): Promise<SourceAiSample> {
  const root = await realpath(folder)
  if (!(await lstat(root)).isDirectory()) throw Object.assign(new Error('请选择有效目录'),{statusCode:400})
  const maxLines = 200, maxBytes = 24 * 1024, maxDepth = 8
  const lines = ['.'], deadline = Date.now() + 3000
  let bytes = 2, truncated = false, visited = 0
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth >= maxDepth) { truncated = true; return }
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !isWithin(root, await realpath(directory))) return
    const entries = await opendir(directory)
    for await (const entry of entries) {
      if (++visited > 2000 || Date.now() > deadline) {truncated = true; break}
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
      // 直接用名称，不加引号；控制字符转义，避免文件名里的换行破坏树结构。
      const display = entry.name.replace(/[\u0000-\u001f\u007f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      const name = display.length > 240 ? display.slice(0,237) + '...' : display
      if (name !== entry.name) truncated = true
      const line = '  '.repeat(depth) + '|-- ' + name + (entry.isDirectory() ? '/' : '')
      if (lines.length >= maxLines - 1 || bytes + Buffer.byteLength(line) > maxBytes - 128) { truncated = true; break }
      lines.push(line); bytes += Buffer.byteLength(line) + 1
      if (entry.isDirectory()) await walk(path.join(directory,entry.name),depth+1)
      if (lines.length >= maxLines - 1 || bytes >= maxBytes - 512 || Date.now() > deadline) { truncated = true;break }
    }
  }
  await walk(root,0)
  if (truncated) lines.push('...（目录树样本已截断）')
  const sample = {token:randomUUID(),tree:lines.join('\n'),truncated,lines:lines.length}
  for (const [key,value] of samples) if (value.expires < Date.now()) samples.delete(key)
  if (samples.size >= 8) samples.delete(samples.keys().next().value!)
  samples.set(sample.token,{sample,folder:root,expires:Date.now()+5*60_000})
  return sample
}

export function getSourceTreeSample(token: string): SourceAiSample {
  const entry = samples.get(token)
  if (!entry || entry.expires < Date.now()) {samples.delete(token);throw Object.assign(new Error('目录树样本已过期，请重新读取'),{statusCode:410})}
  return entry.sample
}
export function getSourceTreeFolder(token: string): string {
  const entry = samples.get(token)
  if (!entry || entry.expires < Date.now()) { samples.delete(token); throw Object.assign(new Error('目录树样本已过期，请重新读取'), { statusCode: 410 }) }
  return entry.folder
}

export interface SourceTreeEntry { name: string; type: 'file' | 'directory' }
export interface SourceTreeRead { path: string; offset: number; length: number; total: number; hasMore: boolean; entries: SourceTreeEntry[] }

/** Read one safe, paginated directory level. The returned paths are always relative to root. */
export async function readSourceTreeDirectory(folder: string, relative = '.', offset = 0, length = SOURCE_TREE_MAX_LENGTH): Promise<SourceTreeRead> {
  const root = await realpath(folder)
  if (!(await lstat(root)).isDirectory()) throw Object.assign(new Error('请选择有效目录'), { statusCode: 400 })
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0
  if (!Number.isInteger(length) || length < 1 || length > SOURCE_TREE_MAX_LENGTH) throw Object.assign(new Error(`length 必须是 1-${SOURCE_TREE_MAX_LENGTH}`), { statusCode: 400 })
  const safeLength = length
  const requested = typeof relative === 'string' && relative.trim() ? relative.trim() : '.'
  if (path.isAbsolute(requested) || requested.includes('\0')) throw Object.assign(new Error('目录路径必须是来源内相对路径'), { statusCode: 400 })
  const relativePath = path.normalize(requested)
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) throw Object.assign(new Error('目录路径越过来源边界'), { statusCode: 400 })
  const target = path.resolve(root, relativePath)
  if (!isWithin(root, target)) throw Object.assign(new Error('目录路径越过来源边界'), { statusCode: 400 })
  await lstat(target)
  if (!isWithin(root, await realpath(target))) throw Object.assign(new Error('不允许符号链接、目录联接或越界目录'), { statusCode: 400 })
  const entries: SourceTreeEntry[] = []
  const dir = await opendir(target)
  for await (const entry of dir) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
    entries.push({ name: entry.name.slice(0, 240), type: entry.isDirectory() ? 'directory' : 'file' })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const displayPath = relativePath === '.' ? '.' : relativePath.split(path.sep).join('/')
  return { path: displayPath, offset: safeOffset, length: safeLength, total: entries.length, hasMore: safeOffset + safeLength < entries.length, entries: entries.slice(safeOffset, safeOffset + safeLength) }
}
