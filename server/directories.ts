import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DirectoryEntry, DirectoryListing } from '../shared/types.js'

function directoryError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

export async function listDirectories(requested?: string): Promise<DirectoryListing> {
  if (!requested) {
    const candidates = process.platform === 'win32'
      ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
      : ['/']
    const roots = await Promise.all(candidates.map(async root => {
      try { return (await stat(root)).isDirectory() ? { name: root, path: root } : null }
      catch { return null }
    }))
    return { path: null, parent: null, breadcrumbs: [], directories: roots.filter((entry): entry is DirectoryEntry => entry !== null) }
  }
  if (!path.isAbsolute(requested) || requested.includes('\0') || /^\\\\[?.]\\/.test(requested)) {
    throw directoryError('请选择有效的文件夹', 400)
  }
  try {
    const current = await realpath(requested)
    const entries = await readdir(current, { withFileTypes: true })
    const root = path.parse(current).root
    const breadcrumbs: DirectoryEntry[] = [{ name: root, path: root }]
    const parts = current.slice(root.length).split(path.sep).filter(Boolean)
    for (const part of parts) {
      breadcrumbs.push({ name: part, path: path.join(breadcrumbs[breadcrumbs.length - 1].path, part) })
    }
    return {
      path: current, parent: current === root ? null : path.dirname(current), breadcrumbs,
      directories: entries.filter(entry => entry.isDirectory())
        .map(entry => ({ name: entry.name, path: path.join(current, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw directoryError('没有权限读取这个文件夹，请选择其他位置', 403)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw directoryError('文件夹不存在，或所在磁盘已断开', 404)
    throw directoryError('暂时无法读取这个文件夹，请重试或选择其他位置', 503)
  }
}
