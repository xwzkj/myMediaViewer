import { opendir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SourceAiSample } from '../shared/types.js'
import { isWithin } from './source-engine.js'
const samples = new Map<string, { sample: SourceAiSample; expires: number }>()
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
      // JSON-quote names so embedded line breaks/control characters cannot fabricate tree structure.
      const name = entry.name.length > 240 ? entry.name.slice(0,237) + '...' : entry.name
      if (name !== entry.name) truncated = true
      const line = '  '.repeat(depth) + '|-- ' + JSON.stringify(name) + (entry.isDirectory() ? '/' : '')
      if (lines.length >= maxLines - 1 || bytes + Buffer.byteLength(line) > maxBytes - 128) {truncated = true; break}
      lines.push(line); bytes += Buffer.byteLength(line) + 1
      if (entry.isDirectory()) await walk(path.join(directory,entry.name),depth+1)
      if (lines.length >= maxLines - 1 || bytes >= maxBytes - 512 || Date.now() > deadline) {truncated = true;break}
    }
  }
  await walk(root,0)
  if (truncated) lines.push('...（目录树样本已截断）')
  const sample = {token:randomUUID(),tree:lines.join('\n'),truncated,lines:lines.length}
  for (const [key,value] of samples) if (value.expires < Date.now()) samples.delete(key)
  if (samples.size >= 8) samples.delete(samples.keys().next().value!)
  samples.set(sample.token,{sample,expires:Date.now()+5*60_000})
  return sample
}
export function getSourceTreeSample(token: string): SourceAiSample {
  const entry = samples.get(token)
  if (!entry || entry.expires < Date.now()) {samples.delete(token);throw Object.assign(new Error('目录树样本已过期，请重新读取'),{statusCode:410})}
  return entry.sample
}
