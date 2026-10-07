import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import type { Source } from '../shared/types.js'
import { sourcePreset } from '../shared/source-presets.js'
import { validateRulesShape } from './source-rules.js'

export const dataDir = path.resolve(process.env.MEDIA_DATA_DIR || 'data')
mkdirSync(dataDir, { recursive: true })
export const cacheDir = path.join(dataDir, 'cache')
mkdirSync(cacheDir, { recursive: true })
export const port = Number(process.env.PORT || 3210)
export const host = process.env.HOST || '0.0.0.0'
export const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
// 默认只允许局域网/保留地址访问；把 ALLOW_PUBLIC_ACCESS 设为 1/true/yes/on 才放行公网地址。
export const allowPublicAccess = /^(1|true|yes|on)$/i.test((process.env.ALLOW_PUBLIC_ACCESS || '').trim())

const configPath = path.join(dataDir, 'sources.json')
if (!existsSync(configPath)) writeFileSync(configPath, '[]', 'utf8')
export const sources: Source[] = JSON.parse(readFileSync(configPath, 'utf8'))
if (!Array.isArray(sources) || sources.some(s => !s.id || !s.path || !['pixiv', 'telegram', 'custom'].includes(s.kind))) {
  throw new Error('data/sources.json 格式不正确，请检查媒体目录配置。')
}
export function saveSources(next: Source[]): void {
  writeFileSync(`${configPath}.tmp`, JSON.stringify(next, null, 2), 'utf8')
  renameSync(`${configPath}.tmp`, configPath)
  sources.splice(0, sources.length, ...next)
}

// Migration is configuration-only: IDs and library/favorite rows stay untouched.
if (sources.some(s => !s.rules)) {
  const next = sources.map(source => {
    if (source.rules) return source
    if (source.kind !== 'pixiv' && source.kind !== 'telegram') throw new Error('自定义来源缺少规则')
    return { ...source, rules: sourcePreset(source.kind) }
  })
  for (const source of next) validateRulesShape(source.rules)
  if (!existsSync(`${configPath}.legacy.bak`)) copyFileSync(configPath, `${configPath}.legacy.bak`)
  saveSources(next)
}
for (const source of sources) validateRulesShape(source.rules)
