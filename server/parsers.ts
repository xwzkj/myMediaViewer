import path from 'node:path'
import type { MediaKind, SourceKind } from '../shared/types.js'

export interface ParsedName { externalId: string; page: number; metadata: boolean; kind: MediaKind; extension: string; sequence: number }
export interface Metadata { title: string; author: string; description: string; tags: string[]; date: string; originalUrl: string }
const images = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp'])
const videos = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi'])
const metadataExtensions = new Set(['txt', 'json'])
export const emptyMetadata = (): Metadata => ({ title: '', author: '', description: '', tags: [], date: '', originalUrl: '' })

export function parseName(filename: string, kind: SourceKind): ParsedName | null {
  const extension = path.extname(filename).slice(1).toLowerCase()
  const metadata = metadataExtensions.has(extension)
  if (!metadata && extension !== 'gif' && !images.has(extension) && !videos.has(extension)) return null
  // 元文件既可能直接跟在作品号后面（-meta.json），也可能带页码（_p0-meta.json），两种都要认。
  const match = kind === 'pixiv'
    ? filename.match(/^(?<sequence>\d+)-(?<id>\d+)(?:_p(?<page>\d+))?(?:-meta)?\.+[a-z0-9]+$/i)
    : filename.match(/^(?<sequence>\d+)_(?<month>\d{6})(?:_p(?<page>\d+))?\.+[a-z0-9]+$/i)
  if (!match?.groups) return null
  const { sequence, id, month, page } = match.groups
  return {
    externalId: kind === 'pixiv' ? id : `${sequence}_${month}`, page: Number(page ?? 0), metadata, extension,
    // 文件名开头的编号：Pixiv 是收藏编号（bmk_id），Telegram 是消息号，越大表示收藏得越晚。
    sequence: Number(sequence),
    // Pixiv animation exports may include a page suffix; both formats share the same logical page.
    kind: metadata ? 'image'
      : extension === 'gif' || (kind === 'pixiv' && extension === 'webm') ? 'animation'
        : videos.has(extension) ? 'video' : 'image',
  }
}

export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { return new TextDecoder('gb18030').decode(buffer) }
}

function decodeEntities(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (raw, value: string) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw
  }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/** 简介在 json 里是 HTML 片段，转成纯文本方便显示和搜索。 */
function stripHtml(text: string): string {
  return decodeEntities(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseMetadata(text: string, kind: SourceKind): Metadata {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const blank = emptyMetadata()
  if (kind === 'telegram') return {
    ...blank, title: text.split('\n').find(line => line.trim())?.trim().slice(0, 100) || '',
    description: text, tags: [...new Set(text.match(/#[^\s#]+/gu) || [])].map(t => t.slice(1)),
  }
  // These are section headings in the export format, not arbitrary blank-line separators.
  const fields = new Map<string, string>()
  const marker = /^(ID|URL|Original|Thumbnail|xRestrict|AI|User|UserID|Title|Description|Tags|Size|Bookmark|Date)\n/gm
  const matches = [...text.matchAll(marker)]
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index! + matches[i][0].length
    fields.set(matches[i][1], decodeEntities(text.slice(start, matches[i + 1]?.index ?? text.length).trim()))
  }
  return {
    title: fields.get('Title') || '', author: fields.get('User') || '',
    description: fields.get('Description') || '',
    tags: (fields.get('Tags') || '').split('\n').map(t => t.trim().replace(/^#/, '')).filter(Boolean),
    date: fields.get('Date') || '', originalUrl: fields.get('URL') || '',
  }
}

/** 下载器的 json 元文件，字段比 txt 全，还带翻译后的标签。 */
export function parseJsonMetadata(text: string, kind: SourceKind): Metadata {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyMetadata()
    data = parsed as Record<string, unknown>
  } catch { return emptyMetadata() }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = data[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
    return ''
  }
  const tags = [...new Set([data.tags, data.tagsWithTransl, data.tagsTranslOnly]
    .filter((value): value is unknown[] => Array.isArray(value)).flat()
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))]
  const date = pick('date', 'uploadDate')
  const original = pick('original', 'url', 'webUrl')
  if (kind === 'telegram') {
    const description = stripHtml(pick('description', 'desc', 'content'))
    return {
      title: pick('title', 'name') || description.split('\n').find(line => line.trim())?.trim().slice(0, 100) || '',
      author: pick('user', 'userName', 'author', 'channel'),
      description, tags, date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date : '', originalUrl: original,
    }
  }
  const id = pick('idNum', 'id')
  return {
    title: pick('title'), author: pick('user', 'userName', 'author'),
    description: stripHtml(pick('description')), tags,
    date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date : '',
    originalUrl: /^https?:\/\/(?:www\.)?pixiv\.net\/i\/\d+/.test(original) ? original : id ? `https://www.pixiv.net/i/${id}` : original,
  }
}

export function parseMetadataFile(buffer: Buffer, filename: string, kind: SourceKind): Metadata {
  const text = decodeText(buffer)
  return path.extname(filename).slice(1).toLowerCase() === 'json' ? parseJsonMetadata(text, kind) : parseMetadata(text, kind)
}
