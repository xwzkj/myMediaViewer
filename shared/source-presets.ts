import type { SourceRules } from './types.js'
import { pixivScript, telegramScript, customScript } from './preset-scripts.js'

export function sourcePreset(kind: 'pixiv' | 'telegram'): SourceRules {
  const pattern = kind === 'pixiv'
    ? String.raw`(?<sequence>\d+)-(?<id>\d+)(?:_p(?<page>\d+))?(?:-meta)?\.+[a-z0-9]+`
    : String.raw`(?<id>(?<sequence>\d+)_(?<month>\d{6}))(?:_p(?<page>\d+))?\.+[a-z0-9]+`
  return {
    version: 1, preset: kind, scope: 'source', duplicates: 'page',
    media: { mode: 'regex', pattern, caseSensitive: false, defaultPage: 0 },
    metadata: [{ mode: 'regex', pattern: pattern.replace('[a-z0-9]+', '(?:txt|json)'), caseSensitive: false }],
    typeOverrides: kind === 'pixiv' ? { webm: 'animation' } : {}, script: kind === 'pixiv' ? pixivScript : telegramScript
  }
}
export function customRules(): SourceRules {
  return { version: 1, scope: 'source', duplicates: 'all', typeOverrides: {},
    media: { mode: 'template', pattern: '{id}[_p{page}].{ext}', caseSensitive: false },
    metadata: [{ mode: 'template', pattern: '{id}.json', caseSensitive: false }],
    script: customScript }
}

/** Ignore property order/default target when deciding whether to send an untouched blank preset. */
export function isBlankSourceRules(rules: SourceRules): boolean {
  const normalizeRule = (r: SourceRules['media']) => ({mode:r.mode,pattern:r.pattern,caseSensitive:r.caseSensitive,target:r.target ?? 'filename',defaultPage:r.defaultPage})
  const normalize = (r: SourceRules) => ({version:r.version,scope:r.scope,duplicates:r.duplicates,media:normalizeRule(r.media),metadata:r.metadata.map(normalizeRule),typeOverrides:Object.entries(r.typeOverrides).sort(),script:r.script.trim()})
  return JSON.stringify(normalize(rules)) === JSON.stringify(normalize(customRules()))
}
