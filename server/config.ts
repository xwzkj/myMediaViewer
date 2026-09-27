import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import type { Source } from '../shared/types.js'

export const dataDir = path.resolve(process.env.MEDIA_DATA_DIR || 'data')
mkdirSync(dataDir, { recursive: true })
export const cacheDir = path.join(dataDir, 'cache')
mkdirSync(cacheDir, { recursive: true })
export const port = Number(process.env.PORT || 3210)
export const host = process.env.HOST || '0.0.0.0'
export const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'

const configPath = path.join(dataDir, 'sources.json')
if (!existsSync(configPath)) writeFileSync(configPath, '[]', 'utf8')
export const sources: Source[] = JSON.parse(readFileSync(configPath, 'utf8'))
if (!Array.isArray(sources) || sources.some(s => !s.id || !s.path || !['pixiv', 'telegram'].includes(s.kind))) {
  throw new Error('data/sources.json 格式不正确，请检查媒体目录配置。')
}
export function saveSources(next: Source[]): void {
  writeFileSync(`${configPath}.tmp`, JSON.stringify(next, null, 2), 'utf8')
  renameSync(`${configPath}.tmp`, configPath)
  sources.splice(0, sources.length, ...next)
}
